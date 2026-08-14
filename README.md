# Food Map

A multi-user interactive restaurant map for LA County. Every user builds their
own map: search a restaurant, press add, and a pin appears with its photo,
address, cuisine, hours, price and rating. Maps persist across sessions and can
be shared publicly.

Backend is Node + Express. Frontend is plain HTML, CSS and ES modules — no
build step, no framework.

---

## Run it locally in two commands

**No database to install, no Docker, no cloud account.**

```bash
npm install
```

```bash
npm run dev
```

Open <http://localhost:3000>.

With no `.env` present the app runs against [PGlite](https://pglite.dev) — real
PostgreSQL compiled to WebAssembly, running inside the Node process — and
enables a local sign-in bypass. You get the entire app immediately.

To load the LA County restaurants (~13k, takes about a minute):

```bash
npm run migrate && npm run seed
```

---

## How data actually gets filled in

This is the part worth understanding before changing anything, because it is
shaped by a hard constraint: **every API carrying real per-restaurant ratings,
prices and photos is now paid or card-gated.** Yelp ended free access.
Foursquare bills ratings and photos from the first call. TripAdvisor needs a
card on file. The free sources — OpenStreetMap, the US Census geocoder — have
names, addresses and cuisines but no ratings, prices or photos.

So every displayed field resolves independently through three layers, taking
the first that has a value:

| Layer | Source | Active by default |
|---|---|---|
| 1. Google | Places API — ratings, prices, photos | No (needs an API key) |
| 2. Website | schema.org JSON-LD and Open Graph on the restaurant's **own** site | Yes |
| 3. Community | Ratings and photos from this app's users | Yes |

Layer 2 reads structured data a business publishes deliberately for search
engines. It is not scraping a third party, and it is stable because the schema
is a published standard.

### Measured coverage

Guessing here would have been irresponsible, so it was measured across 200 real
LA restaurant websites (`npm run measure`):

| Field | Found on the restaurant's own site |
|---|---|
| Description | **71.3%** |
| Photo | **62.9%** |
| Price range | 7.7% |
| **Rating** | **0.7%** |

Ratings are effectively unavailable from restaurant websites, and this will not
improve with better parsing. Google's 2019 policy made self-serving
`aggregateRating` on `LocalBusiness` schema ineligible for star rich results, so
SEO plugins stopped emitting it — a restaurant has no reason to publish its own
rating in machine-readable form. Of 37 sampled pages carrying any JSON-LD at
all, exactly one had a rating.

**Therefore: photos and descriptions fill in automatically; ratings come from
your users** — until you enable Google.

Also note the ceiling above all of this: only 47.7% of the seeded restaurants
have a website at all.

---

## Switching to Google later

One environment variable. The Google providers are fully implemented, not
stubs — they are simply unreachable while the key is absent.

```bash
GOOGLE_MAPS_API_KEY=your-key-here
```

Redeploy, and maps, place search, geocoding and enrichment all switch over.
Ratings, prices and real photos start resolving from layer 1. No code changes.

**On cost:** Google retired its universal $200/month credit in March 2025 and
replaced it with per-SKU free monthly allowances — roughly 5,000 free Places Pro
calls a month, which is the tier `rating` and `priceLevel` sit in. Enrichment
results are cached for 30 days, so a pinned restaurant costs about one call a
month. A billing account with a card is required even to stay inside the free
tier; set a hard quota cap in the Google Cloud console if you want a guarantee
you cannot be charged.

Field masks determine which SKU you are billed at, so
`server/providers/places/google.js` deliberately requests the minimum. The
richer extras sit behind `GOOGLE_RICH_DETAILS=true` because they promote every
call to a tier with a much smaller free allowance.

---

## Deploying

### 1. Supabase (database, auth, photo storage)

1. Create a project at [supabase.com](https://supabase.com) — free, no card.
   **Leave "Automatically expose new tables" unchecked.** Nothing here reaches
   the database through Supabase's Data API, so there is no reason to expose it
   — see *Locking down database access* below, which is not optional.
2. **Project Settings → Database → Connection string → Transaction pooler.**
   Copy it; that is `DATABASE_URL`. Use the pooler (port 6543), not a direct
   connection.
3. **Project Settings → API** gives you `SUPABASE_URL`, `SUPABASE_ANON_KEY` and
   `SUPABASE_SERVICE_ROLE_KEY`.
4. **Storage → New bucket** named `restaurant-photos`, marked public, then add
   the policies below.
5. **Authentication → Providers → Email** — enable it.

#### Locking down database access

The anon key is served to every browser by `GET /api/config` — it has to be, for
sign-in to work. That key can call Supabase's auto-generated REST API directly
at `https://<ref>.supabase.co/rest/v1/<table>`. **Without row-level security,
anyone could read and write `maps`, `ratings` and `restaurants` from a browser
console, bypassing this API and every ownership check in it.**

Enable RLS on every table in `public`. Supabase's dashboard flags any table
missing it. You need **no policies at all** — with RLS on and no policy, the
anon role is denied everything, which is correct because nothing legitimate uses
that path.

This does not affect the server: it connects as the table owner via
`DATABASE_URL`, and owners bypass RLS.

#### Storage policies

These are required — without them, photo uploads fail silently. Uploads go from
the browser straight to Supabase, so the rules live in the database. Run this in
the SQL Editor:

```sql
create policy "Users upload to their own folder"
on storage.objects for insert to authenticated
with check (
  bucket_id = 'restaurant-photos'
  and (storage.foldername(name))[1] = auth.uid()::text
);

create policy "Users delete their own photos"
on storage.objects for delete to authenticated
using (
  bucket_id = 'restaurant-photos'
  and (storage.foldername(name))[1] = auth.uid()::text
);
```

The first-path-segment check mirrors what `server/routes/photos.js` enforces
server-side, so the two layers agree on `<userId>/<restaurantId>/<filename>`. A
public bucket serves reads through its public URL without a select policy.

### 2. Render (the Node server)

1. New → Web Service, connected to this repository.
2. Build `npm ci`, start `npm run migrate && npm start`.
3. Add the environment variables above, plus `NODE_ENV=production` and
   `CORS_ORIGINS=https://your-app.onrender.com`.
4. Health check path `/health`.

`render.yaml` describes all of this if you prefer a blueprint deploy.

### 3. Seed production

```bash
DATABASE_URL="your-supabase-pooler-url" npm run seed
```

### 4. Turn on the keep-alive — do not skip this

Add a repository variable `HEALTH_URL` = `https://your-app.onrender.com/health`
under **Settings → Secrets and variables → Actions → Variables**.

`.github/workflows/keep-alive.yml` then pings it every 10 minutes. This is
load-bearing: Render's free tier sleeps after 15 minutes idle, and **Supabase
pauses a free project after 7 days of inactivity**, which requires a manual
restore from the dashboard. `/health` runs a real database query, so one ping
resets both timers.

---

## Changing things

`server/config.js` holds every tunable. You should not need to hunt through the
code to change behaviour.

| To do this | Change |
|---|---|
| Cover more than LA County | `geography.bounds`, `geography.osmAreaName`, then re-run `npm run seed` |
| Include or exclude place types | `catalog.osmAmenities` |
| Retune search relevance | `search.weights` |
| Change what counts as `$$` | `ratings.priceLevelThresholdsUsd` |
| Use different map tiles | `providers.tileUrl` |
| Crawl faster or slower | `enrichment.concurrency`, `enrichment.perDomainDelayMs` |

The map bounds are served to the browser via `GET /api/config`, so changing
them changes the frontend's hard limits with no frontend edit.

### Adding a provider

See `server/providers/CONTRACT.md`. Implement the interface, register it in the
directory's `index.js`, add a config switch. No provider-specific branching
anywhere else.

---

## Architecture

```
Browser (vanilla ES modules)
  ├── supabase-js ──────────────► Supabase Auth (sign in/up directly)
  └── fetch + Bearer JWT ───────► Node/Express on Render
                                    ├── pg ──────────► Supabase Postgres
                                    ├── supabase-js ─► Storage (photos)
                                    └── enrichment worker (in-process)
                                          └── fetches restaurant websites
```

JWTs are verified locally against Supabase's published JWKS, so a request costs
no round-trip to Supabase. The cache is capped at Supabase's own 10-minute edge
cache — caching longer would keep trusting a rotated or revoked key.

```
server/
  config.js              every tunable lives here
  db/                    pool (PGlite or Postgres), migrations, runner
  middleware/            auth, validation, errors
  routes/                maps, restaurants, ratings, photos, health
  services/
    search.js            trigram + full-text + proximity ranking
    resolver.js          the three-layer merge
    enrichment/          crawler, structured-data parsing, politeness
  providers/
    geocoding/           census, nominatim, google
    places/              osm, google
scripts/
  seed-osm.js            Overpass import
  measure-enrichment.js  coverage measurement
public/                  frontend
test/                    92 tests, node:test
```

Notable design choices:

- **Coordinates never appear in the interface.** Addresses are geocoded by the
  US Census geocoder (free, no key, no rate limit, authoritative for US
  streets), with Nominatim as a fallback for place names.
- **Search runs against our own Postgres**, seeded from OpenStreetMap. No
  external quota, no rate limit, and measured at 6–44 ms across 13,191 rows.
- **No PostGIS.** Distances use lat/lng plus haversine so the identical SQL runs
  on Supabase and on PGlite.
- **Restaurants are shared; maps are personal.** Two users pinning the same
  place point at one row, which is what makes a cross-user average meaningful.
- **Enrichment is queued on pin, not on import**, so the crawler only visits
  places somebody actually cares about.

### The infinite-map fix

Leaflet repeats the world horizontally forever by default, and pins exist in
only one copy — so panning sideways makes your restaurants vanish onto a blank
duplicate Earth. Four settings in `public/js/map/leafletProvider.js` prevent it,
and all four are needed: `noWrap` on the tile layer, `maxBounds`,
`maxBoundsViscosity: 1.0` (the default of 0 makes the edge springy rather than
solid), and a `minZoom` floor.

Verified in a browser: an attempt to fly to Tokyo clamps to −117.754°, zooming
out to level 1 is refused, and zero duplicate-world tiles render.

---

## Tests

```bash
npm test
```

92 tests on Node's built-in runner — no Jest, no Vitest. They run against a real
in-memory PostgreSQL, so schema constraints, cascades and SQL are genuinely
exercised rather than mocked.

---

## Known limitations

Stated plainly rather than discovered later:

- **OpenStreetMap has ~13,191 LA County restaurants**; county health records
  list 30,000+ food businesses. Coverage is roughly 40%, which is why manual add
  matters. Merging the LA County health dataset would be the natural next step.
- **Ratings start empty.** See the coverage table above.
- **~28% of restaurant websites are unreachable** to the crawler, mostly HTTP
  403 from bot protection.
- **`og:image` is sometimes a logo** rather than food. A user-uploaded photo
  overrides it.
- **Render's free tier cold-starts at ~50 seconds** if the keep-alive lapses.
- **Photo uploads need Supabase configured** — they go browser-to-Supabase
  directly, so they do not work in the local no-account mode.

## Attribution

Restaurant data © [OpenStreetMap](https://www.openstreetmap.org/copyright)
contributors, [ODbL](https://opendatacommons.org/licenses/odbl/). Basemap tiles
© [CARTO](https://carto.com/attributions). Geocoding by the
[US Census Bureau](https://geocoding.geo.census.gov/) and
[Nominatim](https://nominatim.openstreetmap.org/).
