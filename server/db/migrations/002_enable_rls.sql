-- ---------------------------------------------------------------------------
-- 002 — Row-level security
--
-- WHY THIS EXISTS
--
-- The Supabase anon/publishable key is served to every browser by
-- GET /api/config, because signing in requires it. That key can call Supabase's
-- auto-generated REST API directly at
-- https://<ref>.supabase.co/rest/v1/<table>.
--
-- With RLS off, anyone could therefore read and write maps, ratings and
-- restaurants straight from a browser console, bypassing this application's
-- API and every ownership check in it.
--
-- Enabling RLS with NO POLICIES denies the anon and authenticated roles
-- everything, which is exactly right: nothing legitimate reaches these tables
-- through the Data API. All real access goes through the Express server.
--
-- WHY IT DOES NOT BREAK THE SERVER
--
-- The server connects with DATABASE_URL as the role that owns these tables, and
-- in Postgres a table's owner bypasses RLS unless FORCE ROW LEVEL SECURITY is
-- set. It is not set here, so application queries, migrations and the OSM seed
-- importer are unaffected.
--
-- This runs as a migration rather than living in a setup checklist so that it
-- cannot be forgotten on a new deployment.
-- ---------------------------------------------------------------------------

ALTER TABLE profiles           ENABLE ROW LEVEL SECURITY;
ALTER TABLE maps               ENABLE ROW LEVEL SECURITY;
ALTER TABLE restaurants        ENABLE ROW LEVEL SECURITY;
ALTER TABLE map_restaurants    ENABLE ROW LEVEL SECURITY;
ALTER TABLE ratings            ENABLE ROW LEVEL SECURITY;
ALTER TABLE restaurant_photos  ENABLE ROW LEVEL SECURITY;
ALTER TABLE enrichment_jobs    ENABLE ROW LEVEL SECURITY;

-- Created by the migration runner itself before any migration executes, so it
-- exists by the time this runs. Included so Supabase's linter does not flag it.
ALTER TABLE schema_migrations  ENABLE ROW LEVEL SECURITY;
