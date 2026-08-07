/**
 * Test database helper.
 *
 * Gives each test file a fresh in-memory Postgres with the full schema applied.
 * Node's test runner executes each file in its own process, so the module-level
 * database singleton is genuinely per-file and tests cannot leak into each
 * other.
 *
 * These environment variables must be set before config.js is imported, which
 * is why the imports below are dynamic.
 */

process.env.PGLITE_DIR = 'memory://';
process.env.NODE_ENV = 'test';
// A stray DATABASE_URL in the shell would silently point tests at a real
// database. Refuse to inherit it.
delete process.env.DATABASE_URL;

const db = await import('../../server/db/pool.js');
const { migrate } = await import('../../server/db/migrate.js');

let ready = false;

/** Connect and apply migrations once per test file. */
export async function setupDb() {
  if (!ready) {
    await db.init();
    await migrate({ silent: true });
    ready = true;
  }
  return db;
}

/** Remove all rows without tearing down the schema. */
export async function truncateAll() {
  await db.exec(`
    TRUNCATE ratings, restaurant_photos, enrichment_jobs, map_restaurants,
             maps, restaurants, profiles
    RESTART IDENTITY CASCADE;
  `);
}

export async function teardownDb() {
  await db.close();
  ready = false;
}

/** Insert a profile and return its id. */
export async function makeProfile(displayName = 'Test User') {
  const id = crypto.randomUUID();
  await db.query('INSERT INTO profiles (id, display_name) VALUES ($1, $2)', [id, displayName]);
  return id;
}

/** Insert a map owned by `ownerId` and return its id. */
export async function makeMap(ownerId, name = 'My Map') {
  const { rows } = await db.query(
    'INSERT INTO maps (owner_id, name, slug) VALUES ($1, $2, $3) RETURNING id',
    [ownerId, name, `map-${crypto.randomUUID().slice(0, 8)}`]
  );
  return rows[0].id;
}

/** Insert a restaurant and return its id. */
export async function makeRestaurant(overrides = {}) {
  const r = {
    source: 'user',
    source_id: null,
    name: 'Test Restaurant',
    address_line1: '123 Main St',
    city: 'Los Angeles',
    lat: 34.0522,
    lng: -118.2437,
    cuisines: [],
    website: null,
    ...overrides,
  };

  const { rows } = await db.query(
    `INSERT INTO restaurants
       (source, source_id, name, address_line1, city, lat, lng, cuisines, website)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     RETURNING id`,
    [r.source, r.source_id, r.name, r.address_line1, r.city, r.lat, r.lng, r.cuisines, r.website]
  );
  return rows[0].id;
}

export { db };
