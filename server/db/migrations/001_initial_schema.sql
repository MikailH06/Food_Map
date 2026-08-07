-- ---------------------------------------------------------------------------
-- 001 — Initial schema
--
-- Design notes:
--
--   * Coordinates are plain double precision columns, not PostGIS geometry.
--     Distance is computed with the haversine formula in SQL. This keeps the
--     identical schema working on Supabase Postgres and on PGlite (the
--     in-process Postgres used for local development and tests), and at LA
--     County scale (~30k rows) a bounding-box prefilter plus haversine is
--     comfortably fast.
--
--   * Supabase Auth owns auth.users. We do NOT hard-depend on it: profiles.id
--     simply holds the Supabase user id, and the foreign key is added only if
--     the auth schema exists (see the DO block at the end). That keeps the
--     schema runnable locally where no auth schema is present.
--
--   * Restaurants are a SHARED catalog. A user's map holds references to them
--     via map_restaurants, so two users pinning the same restaurant point at
--     one row — which is what makes a cross-user average rating meaningful.
-- ---------------------------------------------------------------------------

CREATE EXTENSION IF NOT EXISTS pg_trgm;


-- One row per signed-in user. Created lazily by the API on first authenticated
-- request rather than by a database trigger, so it works the same locally and
-- on Supabase, and cannot silently break if a trigger is missing.
CREATE TABLE profiles (
  id           uuid PRIMARY KEY,
  display_name text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);


-- A user's personal map. Each user gets one on signup and may create more.
CREATE TABLE maps (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id       uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  name           text NOT NULL,
  -- Shareable URL segment, unique across all users.
  slug           text NOT NULL UNIQUE,
  -- The address the user typed. Coordinates below are derived from it by the
  -- geocoding provider; the user never sees or types a coordinate.
  center_address text,
  center_lat     double precision,
  center_lng     double precision,
  zoom           smallint NOT NULL DEFAULT 12,
  is_public      boolean NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX maps_owner_idx ON maps (owner_id);
CREATE INDEX maps_public_idx ON maps (is_public) WHERE is_public;


-- Builds the text document that restaurant search matches against.
--
-- This exists because a generated column requires an IMMUTABLE expression, and
-- array_to_string is marked STABLE rather than IMMUTABLE — Postgres is
-- conservative there because array element output functions can be stable in
-- general. For text[] the result is genuinely deterministic, so wrapping it in
-- a function we declare IMMUTABLE is correct rather than a workaround. Note the
-- explicitly named 'english' configuration: the two-argument to_tsvector is
-- only STABLE because it depends on the session's default_text_search_config.
CREATE FUNCTION restaurant_document(
  p_name text, p_address text, p_city text, p_cuisines text[]
) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $fn$
  SELECT p_name || ' ' ||
         coalesce(p_address, '') || ' ' ||
         coalesce(p_city, '') || ' ' ||
         coalesce(array_to_string(p_cuisines, ' '), '')
$fn$;


-- The shared restaurant catalog: seeded from OpenStreetMap, extended by users.
CREATE TABLE restaurants (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Provenance. 'osm' rows come from the seed importer, 'user' rows are
  -- manually added, 'google' rows come from the Places provider when enabled.
  source        text NOT NULL DEFAULT 'user'
                  CHECK (source IN ('osm', 'user', 'google')),
  -- e.g. 'node/1234567'. Null for user-created entries.
  source_id     text,

  name          text NOT NULL,
  address_line1 text,
  city          text,
  state         text DEFAULT 'CA',
  postal_code   text,

  lat           double precision NOT NULL,
  lng           double precision NOT NULL,

  cuisines      text[] NOT NULL DEFAULT '{}',
  phone         text,
  website       text,
  -- OSM's raw opening_hours string, e.g. "Mo-Fr 11:00-22:00; Sa 12:00-23:00".
  opening_hours text,

  google_place_id text,

  -- ---- Enrichment output -------------------------------------------------
  -- Populated by the crawler from the restaurant's own published structured
  -- data, or by the Google provider when a key is configured. Null means
  -- "nothing found", and the resolver falls back to community data.
  ext_rating       numeric(2,1) CHECK (ext_rating IS NULL OR (ext_rating >= 0 AND ext_rating <= 5)),
  ext_rating_count integer,
  ext_price_level  smallint CHECK (ext_price_level IS NULL OR ext_price_level BETWEEN 1 AND 4),
  ext_photo_url    text,
  ext_description  text,
  ext_source       text CHECK (ext_source IS NULL OR ext_source IN ('website', 'google')),
  enriched_at      timestamptz,
  enrich_status    text NOT NULL DEFAULT 'pending'
                     CHECK (enrich_status IN ('pending', 'running', 'done', 'failed', 'skipped')),

  created_by    uuid REFERENCES profiles(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  -- Precomputed full-text document covering everything a user might type:
  -- name, street, city and cuisine. See restaurant_document() above for why
  -- that helper exists.
  search_vec tsvector GENERATED ALWAYS AS (
    to_tsvector('english', restaurant_document(name, address_line1, city, cuisines))
  ) STORED,

  CONSTRAINT restaurants_lat_valid CHECK (lat BETWEEN -90 AND 90),
  CONSTRAINT restaurants_lng_valid CHECK (lng BETWEEN -180 AND 180)
);

-- Makes re-running the OSM seed idempotent.
CREATE UNIQUE INDEX restaurants_source_uniq
  ON restaurants (source, source_id) WHERE source_id IS NOT NULL;

-- Typo-tolerant name search: "chipolte" still finds Chipotle.
CREATE INDEX restaurants_name_trgm_idx ON restaurants USING GIN (name gin_trgm_ops);
CREATE INDEX restaurants_search_idx ON restaurants USING GIN (search_vec);
-- Bounding-box prefilter before haversine.
CREATE INDEX restaurants_latlng_idx ON restaurants (lat, lng);
-- Lets the enrichment worker find candidates that have a site but no data yet.
CREATE INDEX restaurants_enrich_idx ON restaurants (enrich_status)
  WHERE website IS NOT NULL;


-- The pins: which restaurants are on which map.
CREATE TABLE map_restaurants (
  map_id        uuid NOT NULL REFERENCES maps(id) ON DELETE CASCADE,
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  -- The owner's private note about this place.
  notes         text,
  added_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (map_id, restaurant_id)
);

CREATE INDEX map_restaurants_restaurant_idx ON map_restaurants (restaurant_id);


-- Community ratings. One per user per restaurant, editable.
-- Averaged across ALL users, which is what makes the rating shared rather than
-- personal.
CREATE TABLE ratings (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  stars         smallint NOT NULL CHECK (stars BETWEEN 1 AND 5),
  price_level   smallint CHECK (price_level IS NULL OR price_level BETWEEN 1 AND 4),
  comment       text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, restaurant_id)
);

CREATE INDEX ratings_restaurant_idx ON ratings (restaurant_id);


-- User-uploaded photos, stored in Supabase Storage; this table holds pointers.
CREATE TABLE restaurant_photos (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  user_id       uuid REFERENCES profiles(id) ON DELETE SET NULL,
  storage_path  text NOT NULL,
  is_primary    boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX restaurant_photos_restaurant_idx ON restaurant_photos (restaurant_id);


-- Work queue for the enrichment crawler.
CREATE TABLE enrichment_jobs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id   uuid NOT NULL UNIQUE REFERENCES restaurants(id) ON DELETE CASCADE,
  status          text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'running', 'done', 'failed', 'skipped')),
  attempts        integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- Supports the worker's "claim the next due job" query.
CREATE INDEX enrichment_jobs_claim_idx ON enrichment_jobs (status, next_attempt_at);


-- Community aggregates, read by the three-layer resolver.
-- A plain view is fast enough at this scale; if it ever isn't, this can become
-- a materialized view refreshed by the worker without changing any read path.
CREATE VIEW restaurant_stats AS
SELECT
  restaurant_id,
  round(avg(stars)::numeric, 2)                   AS avg_stars,
  count(*)::integer                               AS rating_count,
  mode() WITHIN GROUP (ORDER BY price_level)      AS modal_price_level
FROM ratings
GROUP BY restaurant_id;


-- Keep updated_at honest without every query having to remember it.
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER profiles_updated_at    BEFORE UPDATE ON profiles    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER maps_updated_at        BEFORE UPDATE ON maps        FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER restaurants_updated_at BEFORE UPDATE ON restaurants FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER ratings_updated_at     BEFORE UPDATE ON ratings     FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- On Supabase, tie profiles to the real auth table so deleting an account
-- cascades. Skipped automatically where no auth schema exists (local PGlite).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'auth' AND table_name = 'users'
  ) THEN
    ALTER TABLE profiles
      ADD CONSTRAINT profiles_id_fkey
      FOREIGN KEY (id) REFERENCES auth.users(id) ON DELETE CASCADE;
  END IF;
END $$;
