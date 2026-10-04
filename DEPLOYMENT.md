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

> **[DEPLOYMENT.md](DEPLOYMENT.md) is the click-by-click walkthrough** — start
> there if this is your first deploy. About 40 minutes. What follows is the
> condensed version for reference.

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


# Deploying Food Map

A click-by-click walkthrough. Roughly **40 minutes**, most of it waiting for
things to provision.

You will end up with a public URL anyone can sign up on, backed by 13,000+ LA
County restaurants. Everything below is free and none of it needs a credit card.

**Do the parts in order.** Render needs values that Supabase gives you, and the
keep-alive needs the URL Render gives you.

---

## How to read this guide

Each step happens in one of two places, and the guide marks which:

**🌐 In your browser** — clicking around the Supabase, Render or GitHub
dashboards.

**⌨️ In a terminal** — typing a command on your own computer. Anything shown in
a box like this is a command to **type or paste into a terminal and press
Enter**:

```bash
npm run migrate
```

It is *not* a name to type into a dashboard, and not a file or table to create.
`npm` is a program installed alongside Node; `npm run migrate` tells it to run
this project's migration script, which creates the database tables for you.

### Opening a terminal in the project folder

Any one of these works:

- **File Explorer:** open the project folder, click the address bar, type
  `powershell`, press Enter.
- **File Explorer:** hold Shift, right-click empty space in the folder →
  **Open PowerShell window here** / **Open in Terminal**.
- **VS Code:** open the project folder, then **Terminal → New Terminal**.

Check you are in the right place by running:

```bash
npm --version
```

If that prints a version number you are set. If it says "not recognized",
install Node from [nodejs.org](https://nodejs.org) and reopen the terminal.

---

## Before you start

You need:

- The code pushed to GitHub (already done: `MikailH06/Food_Map`)
- Node installed locally — check with `node --version`, needs v20.6 or newer
- A text file open to paste six values into as you collect them

Those six values, so you know what you are hunting for:

| Value | Where it comes from | Looks like |
|---|---|---|
| `DATABASE_URL` | Supabase → Connect | `postgresql://postgres.abcd…:PASSWORD@aws-1-us-west-1.pooler.supabase.com:6543/postgres` |
| `SUPABASE_URL` | Supabase → Settings → API | `https://abcdefgh.supabase.co` |
| `SUPABASE_ANON_KEY` | Supabase → Settings → API Keys | `sb_publishable_…` |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase → Settings → API Keys | `sb_secret_…` |
| Database password | You set it at project creation | whatever you chose |
| `CORS_ORIGINS` | Render, after first deploy | `https://food-map-xxxx.onrender.com` |

> **Naming note.** The env vars are still called `SUPABASE_ANON_KEY` and
> `SUPABASE_SERVICE_ROLE_KEY`, but Supabase renamed the keys themselves in 2026.
> Put the **publishable** key in `SUPABASE_ANON_KEY` and the **secret** key in
> `SUPABASE_SERVICE_ROLE_KEY`. The code works with both old and new formats.

---

## Part 1 — Supabase  🌐 browser

### 1.1 Create the project

1. Go to [supabase.com](https://supabase.com) → **Start your project** → sign in
   with GitHub.
2. **New project**.
3. Fill in:
   - **Name:** `food-map`
   - **Database Password:** click **Generate a password**, then
     **copy it into your notes file immediately.** Supabase shows it once. You
     need it in the next step and there is no way to view it again — only reset
     it.
   - **Region:** **West US (Oregon)** or **West US (North California)**. Pick one
     near your Render region; you will choose Oregon there.
   - **"Automatically expose new tables":** **uncheck this** if you see it.
     Nothing in this app reaches the database through Supabase's Data API, so
     there is no reason to expose your tables to it.
4. **Create new project**, then wait ~2 minutes while it provisions.

> If you set your own password instead of generating one, avoid `@ : / ? # [ ]`.
> Those are URL-reserved characters and will break the connection string unless
> percent-encoded.

### 1.2 Get the connection string

1. Click **Connect** in the header bar (top of the dashboard, next to your
   project name).
2. Choose the **Transaction pooler** tab.
   **Not** "Direct connection" and **not** "Session pooler."
   Render's free plan shares outbound IPs, and direct connections exhaust
   Supabase's connection limit quickly.
3. Copy the string. It looks like:

   ```
   postgresql://postgres.abcdefghijkl:[YOUR-PASSWORD]@aws-1-us-west-1.pooler.supabase.com:6543/postgres
   ```

4. **Replace `[YOUR-PASSWORD]`** — including the square brackets — with the
   database password from step 1.1.

   This is the single most common mistake. The literal text `[YOUR-PASSWORD]`
   stays in the string unless you replace it, and you get
   `password authentication failed`.

5. Confirm the port reads **6543**, not 5432. Save as `DATABASE_URL`.

### 1.3 Get the API keys

1. **Settings** (gear, bottom left) → **API Keys**.
2. Copy the **Publishable key** (`sb_publishable_…`) → this is your
   `SUPABASE_ANON_KEY`.
3. Copy or create a **Secret key** (`sb_secret_…`) → this is your
   `SUPABASE_SERVICE_ROLE_KEY`.
   You may need to click **Create new secret key**. It is shown once — save it.
4. **Settings → API** (or **Data API**) → copy the **Project URL** →
   `SUPABASE_URL`.

   It must be **only the origin**, with nothing after `.co`:

   | | |
   |---|---|
   | ✅ correct | `https://abcdefgh.supabase.co` |
   | ❌ wrong | `https://abcdefgh.supabase.co/rest/v1/` |

   That second one is the **Data API endpoint**, shown nearby on the same page,
   and it is easy to grab by mistake. The code appends `/auth/v1` and
   `/storage/v1` itself, so an extra path produces broken requests. The server
   now strips it and logs a warning rather than refusing to start, but set it
   correctly and the warning goes away.

> The secret key grants full database access and ignores all security rules.
> Server-side only. Never commit it, never put it in frontend code.
> Supabase now rejects secret keys sent from a browser, so a misplaced one fails
> loudly rather than quietly working.

### 1.4 Turn on email sign-in

1. **Authentication** (left sidebar) → **Sign In / Providers**.
2. Confirm **Email** is enabled.
3. Decide about **Confirm email**:
   - **On** (default): new users must click a link before they can sign in.
     Supabase's built-in mailer is rate-limited to a few messages an hour, which
     is fine for you but not for real traffic.
   - **Off**: sign-ups work instantly. Easier while testing.

   You can change this later.

### 1.5 Create the photo bucket

1. **Storage** (left sidebar) → **New bucket**.
2. Name it exactly `restaurant-photos` — the code looks for that name.
3. Turn **Public bucket** **on**, so photos load without signed URLs.
4. **Save**.

### 1.6 Add the storage policies

Uploads go from the browser straight to Supabase, so the rules live in the
database. **Without this step, uploads fail silently.**

**SQL Editor** (left sidebar) → **New query** → paste → **Run**:

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

This restricts each user to a folder named after their own user id, matching
what `server/routes/photos.js` enforces server-side.

> **Row-level security on your own tables is handled automatically** by
> migration `002_enable_rls.sql` in the next part. There is nothing to click.

---

## Part 2 — Load the database  ⌨️ terminal

Run this from your computer, not Render. The seed pulls ~13,000 restaurants from
OpenStreetMap and takes a couple of minutes.

### 2.1 Point your local copy at Supabase

You are creating **one file** here. Nothing new to download, no folder to make.

The project folder is wherever you cloned this repository — the folder
containing `package.json`, `server/` and `public/`. On the machine this was
built on that is `D:\cooki\Downloads\Food_Map`.

Inside that folder, create a file named exactly **`.env`** — leading dot, no
extension. Put one line in it:

```
DATABASE_URL=postgresql://postgres.abcdefghijkl:yourpassword@aws-1-us-west-1.pooler.supabase.com:6543/postgres
```

Use your real string from step 1.2, all on one line.

**Creating a dotfile on Windows.** File Explorer resists filenames that begin
with a dot. Easiest ways round it:

- **VS Code:** open the project folder, then right-click in the file list →
  **New File** → type `.env`.
- **Terminal**, from inside the project folder:

  ```bash
  printf 'DATABASE_URL=\n' > .env && notepad .env
  ```

- **Notepad:** File → Save As, set *Save as type* to **All Files**, and put the
  name in quotes: `".env"`.

`.env` is listed in `.gitignore`, so your password is never committed. Confirm
with `git check-ignore -v .env` — it should print a match.

### 2.2 Create the tables

You do **not** create these by hand in the Supabase Table Editor. The two
commands below make all eight tables for you. Run them in a terminal opened in
the project folder.

```bash
npm install
```

```bash
npm run migrate
```

Expected output:

```
[migrate] applying 001_initial_schema.sql ... ok
[migrate] applying 002_enable_rls.sql ... ok
[migrate] applied 2 migration(s)
```

Check it worked: **Table Editor** in Supabase should now list `restaurants`,
`maps`, `ratings` and the rest. **They will all be empty** — that is correct at
this point. Only `schema_migrations` has rows, because it records which
migrations have run. Step 2.3 is what fills `restaurants`.

### 2.3 Load the restaurants

```bash
npm run seed
```

This queries OpenStreetMap, then writes in batches. Expect:

```
[seed] received 13606 elements in 27.0s
[seed] usable restaurants: 13191
[seed] have a website: 6297 (47.7%)
[seed] done — 13191 rows written
```

Roughly 12 MB, against Supabase's 500 MB free limit.

> **If Overpass returns a 429 or 504**, its free public server is overloaded —
> this is common and not a problem with your setup. Wait a few minutes and
> re-run; the importer is idempotent, so re-running is always safe.
>
> To avoid repeated waits, save the response the first time it succeeds and
> reuse it:
>
> ```bash
> npm run seed -- --save la-osm.json
> npm run seed -- --file la-osm.json
> ```

---

## Part 3 — Render  🌐 browser

### 3.1 Create the service

1. [render.com](https://render.com) → sign in with GitHub.
2. **New +** → **Web Service**.
3. Connect your GitHub account if prompted, then pick **`MikailH06/Food_Map`**.
   If it is not listed, click **Configure account** and grant Render access to
   the repository.
4. Settings:

   | Field | Value |
   |---|---|
   | Name | `food-map` |
   | Region | **Oregon (US West)** |
   | Branch | `main` |
   | Runtime | Node |
   | Build command | `npm ci` |
   | Start command | `npm run migrate && npm start` |
   | Instance type | **Free** |

   The start command runs migrations at boot on purpose — Render's build step
   cannot see your environment variables, so `DATABASE_URL` is not available
   there.

### 3.2 Add the environment variables

Scroll to **Environment Variables** → **Add** each of these:

| Key | Value |
|---|---|
| `NODE_ENV` | `production` |
| `DATABASE_URL` | your pooler string from 1.2 |
| `SUPABASE_URL` | from 1.3 |
| `SUPABASE_ANON_KEY` | your `sb_publishable_…` key |
| `SUPABASE_SERVICE_ROLE_KEY` | your `sb_secret_…` key |
| `CORS_ORIGINS` | `https://food-map.onrender.com` — a placeholder for now, fixed in 3.4 |

### 3.3 Deploy

1. **Advanced** → set **Health Check Path** to `/health`.
2. **Create Web Service**.
3. Watch the log. First deploy takes 2–5 minutes. Success looks like:

   ```
   [db] connected via postgres
   [enrich] worker started
   [server] listening on http://localhost:10000
   ```

### 3.4 Fix CORS with the real URL

Render assigns the actual URL, and it may not be the name you chose — if
`food-map` was taken it appends a suffix.

1. Copy the URL from the top of your service page, e.g.
   `https://food-map-a1b2.onrender.com`.
2. **Environment** → edit `CORS_ORIGINS` to exactly that URL.
   **No trailing slash.** `https://x.onrender.com/` will not match.
3. Save. Render redeploys automatically.

### 3.5 Check it

Visit `https://your-url.onrender.com/health`. You want:

```json
{"status":"ok","database":{"connected":true,"driver":"postgres"}}
```

`"driver":"postgres"` confirms it is talking to Supabase. If it says `"pglite"`,
`DATABASE_URL` did not reach the app.

---

## Part 4 — Keep the site awake  🌐 browser

**Do not skip this.** Two separate timers will take your site down:

- Render's free tier **sleeps after 15 minutes** idle → ~50 second cold start.
- Supabase **pauses a free project after 7 days** of no database activity →
  requires a manual restore from the dashboard, and until then everything fails.

`/health` runs a real database query, so one ping resets both.

1. GitHub → your repo → **Settings** → **Secrets and variables** → **Actions**.
2. The **Variables** tab — *not* Secrets. The workflow reads
   `${{ vars.HEALTH_URL }}`, which only sees Variables.
3. **New repository variable**:
   - **Name:** `HEALTH_URL`
   - **Value:** `https://your-url.onrender.com/health` — keep the `/health`.
     Pointing at the bare domain wakes Render but runs no query, so Supabase
     would still pause.
4. Test it now: **Actions** tab → **Keep alive** → **Run workflow**. A green run
   printing the health JSON means the whole chain works.

---

## Part 5 — Confirm it actually works  🌐 browser

Open your Render URL and walk through this:

1. **Create an account.** If you left email confirmation on, click the link.
2. **Search `chipolte`** (deliberately misspelled) — Chipotle locations should
   appear. If nothing does, the seed did not reach this database.
3. **Press Add** on one. A pin appears.
4. **Reload the page.** The pin is still there — that is the persistence
   requirement.
5. **Click the pin → rate it 4 stars → Save.** It should read
   `★4.0 (1) from Food Map users`.
6. **Type an address** in the top bar, e.g. `1000 Vin Scully Ave, Los Angeles`,
   and press Go. The map recenters on Dodger Stadium.
7. **Zoom all the way out and drag sideways.** The map stops at the county edge
   and the world never repeats.

---

## When something goes wrong

**`password authentication failed for user "postgres"`**
You left `[YOUR-PASSWORD]` in the connection string, or the password contains a
character needing percent-encoding. Re-copy from **Connect** and substitute
carefully.

**`Tenant or user not found`**
Wrong connection string type. You need **Transaction pooler**, whose username
looks like `postgres.abcdefghijkl` (with a dot and your project ref), not plain
`postgres`.

**Deploy fails with `SUPABASE_URL is not a Supabase project URL`**
You copied the Data API endpoint (ending `/rest/v1/`) rather than the Project
URL. The message prints exactly what you set and what was expected. Fix it under
**Environment** in Render; it redeploys automatically.

**Health check says `"driver":"pglite"`**
`DATABASE_URL` is missing or misspelled in Render. The app silently falls back
to its local in-process database, so the site works but stores nothing in
Supabase.

**Browser console: `blocked by CORS policy`**
`CORS_ORIGINS` does not exactly match the address bar. Check for a trailing
slash, and `http` vs `https`.

**Signed in, but every action says "Sign in to continue"**
`SUPABASE_URL` or `SUPABASE_ANON_KEY` differs between what the browser got and
what the server validates against. Confirm both point at the same project, then
redeploy.

**Search returns nothing on the live site**
The seed ran against a different database. Confirm your local `.env`
`DATABASE_URL` is the same string you gave Render, then re-run `npm run seed`.

**First visit takes ~50 seconds**
Normal cold start on Render's free tier. It means the keep-alive is not running
— check Part 4.

**Everything fails after about a week away**
Supabase paused the project. Dashboard → **Restore project**. Then fix the
keep-alive, because that is what it exists to prevent.

**Photo upload does nothing**
The storage policies from step 1.6 were not applied, or the bucket is not named
exactly `restaurant-photos`.

---

## Costs

Everything above is $0 with no card.

| Service | Free allowance | Where it pinches first |
|---|---|---|
| Supabase database | 500 MB | Seed uses ~12 MB |
| Supabase storage | 1 GB | Only if users upload many photos |
| Supabase auth | 50,000 monthly users | — |
| Render web service | 750 hours/month | Sleeps when idle; the cron keeps it up |
| CARTO map tiles | free basemaps | Only at real traffic |

To add Google ratings and photos later, see **Switching to Google** in the
[README](README.md). It is one environment variable.
