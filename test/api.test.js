/**
 * API tests.
 *
 * Drives the real Express app over HTTP against a real (in-memory) Postgres.
 * Nothing is mocked, so these exercise routing, validation, authorisation,
 * SQL and the error shape together.
 */

import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { setupDb, teardownDb, truncateAll, db } from './helpers/db.js';

const { createApp } = await import('../server/index.js');

let baseUrl;
let httpServer;

/** A stable fake user id. Dev auth accepts it via the X-Dev-User header. */
const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';

/** Fetch helper that resolves relative paths and signs in as a given user. */
async function api(path, { user = null, ...options } = {}) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers ?? {}) };
  if (user) headers['X-Dev-User'] = user;

  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  const text = await response.text();
  return {
    status: response.status,
    body: text ? JSON.parse(text) : null,
  };
}

before(async () => {
  await setupDb();
  httpServer = createApp().listen(0);
  await new Promise((resolve) => httpServer.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
});

after(async () => {
  await new Promise((resolve) => httpServer.close(resolve));
  await teardownDb();
});

beforeEach(async () => {
  await truncateAll();
});

/** Insert a restaurant directly and return its id. */
async function seedRestaurant(overrides = {}) {
  const r = {
    name: 'Guelaguetza',
    address_line1: '3014 W Olympic Blvd',
    city: 'Los Angeles',
    lat: 34.0522,
    lng: -118.3,
    cuisines: ['oaxacan', 'mexican'],
    website: null,
    ...overrides,
  };
  const { rows } = await db.query(
    `INSERT INTO restaurants (source, name, address_line1, city, lat, lng, cuisines, website)
     VALUES ('osm', $1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [r.name, r.address_line1, r.city, r.lat, r.lng, r.cuisines, r.website]
  );
  return rows[0].id;
}

// ---------------------------------------------------------------------------

test('rejects an unauthenticated request to a protected route', async () => {
  const res = await api('/api/me');
  assert.equal(res.status, 401);
  assert.match(res.body.error.message, /sign in/i);
});

test('creates a profile and a starter map on first authenticated request', async () => {
  const res = await api('/api/me', { user: ALICE });

  assert.equal(res.status, 200);
  assert.equal(res.body.profile.id, ALICE);
  assert.equal(res.body.maps.length, 1, 'a new user should land on a usable map, not an empty page');
  assert.equal(res.body.maps[0].restaurant_count, 0);
});

test('search finds a restaurant by cuisine that is absent from its name', async () => {
  await seedRestaurant();

  const res = await api('/api/restaurants/search?q=oaxacan');

  assert.equal(res.status, 200);
  assert.equal(res.body.count, 1);
  assert.equal(res.body.restaurants[0].name, 'Guelaguetza');
});

test('search tolerates a typo in the name', async () => {
  await seedRestaurant({ name: 'Chipotle Mexican Grill', cuisines: ['mexican'] });

  const res = await api('/api/restaurants/search?q=chipolte');

  assert.equal(res.status, 200);
  assert.equal(res.body.count, 1);
  assert.equal(res.body.restaurants[0].name, 'Chipotle Mexican Grill');
});

test('search rejects an out-of-range coordinate with field-level detail', async () => {
  const res = await api('/api/restaurants/search?q=pizza&lat=999&lng=0');

  assert.equal(res.status, 400);
  assert.ok(res.body.error.details.fields.lat, 'should say which field was wrong');
});

test('proximity ranking prefers the nearer of two equally-named places', async () => {
  // Same name, different distances from the search point.
  await seedRestaurant({ name: 'Taco Spot', lat: 34.0522, lng: -118.2437, cuisines: [] }); // ~0m
  await seedRestaurant({ name: 'Taco Spot', lat: 34.09, lng: -118.2437, cuisines: [] }); // ~4.2km

  const res = await api('/api/restaurants/search?q=Taco Spot&lat=34.0522&lng=-118.2437&radius=10000');

  assert.equal(res.body.count, 2);
  assert.ok(
    res.body.restaurants[0].distance_meters < res.body.restaurants[1].distance_meters,
    'the closer one should rank first'
  );
});

test('quick-add pins a restaurant and it survives a fresh request', async () => {
  const me = await api('/api/me', { user: ALICE });
  const mapId = me.body.maps[0].id;
  const restaurantId = await seedRestaurant();

  const added = await api(`/api/maps/${mapId}/restaurants`, {
    method: 'POST',
    user: ALICE,
    body: { restaurantId },
  });
  assert.equal(added.status, 201);

  // Re-read from scratch: this is the "persists across sessions" guarantee.
  const reloaded = await api(`/api/maps/${mapId}`, { user: ALICE });
  assert.equal(reloaded.body.restaurants.length, 1);
  assert.equal(reloaded.body.restaurants[0].name, 'Guelaguetza');
});

test('the same restaurant cannot be pinned twice to one map', async () => {
  const me = await api('/api/me', { user: ALICE });
  const mapId = me.body.maps[0].id;
  const restaurantId = await seedRestaurant();

  await api(`/api/maps/${mapId}/restaurants`, { method: 'POST', user: ALICE, body: { restaurantId } });
  const second = await api(`/api/maps/${mapId}/restaurants`, {
    method: 'POST',
    user: ALICE,
    body: { restaurantId },
  });

  assert.equal(second.status, 409);
});

test('pinning enqueues enrichment only when there is a website to read', async () => {
  const me = await api('/api/me', { user: ALICE });
  const mapId = me.body.maps[0].id;

  const withSite = await seedRestaurant({ name: 'Has Site', website: 'https://example.com' });
  const withoutSite = await seedRestaurant({ name: 'No Site', website: null });

  await api(`/api/maps/${mapId}/restaurants`, { method: 'POST', user: ALICE, body: { restaurantId: withSite } });
  await api(`/api/maps/${mapId}/restaurants`, { method: 'POST', user: ALICE, body: { restaurantId: withoutSite } });

  const jobs = await db.query('SELECT restaurant_id FROM enrichment_jobs');
  assert.equal(jobs.rows.length, 1, 'a restaurant with no website has nothing to crawl');
  assert.equal(jobs.rows[0].restaurant_id, withSite);
});

test('each user gets their own map', async () => {
  const alice = await api('/api/me', { user: ALICE });
  const bob = await api('/api/me', { user: BOB });

  const restaurantId = await seedRestaurant();
  await api(`/api/maps/${alice.body.maps[0].id}/restaurants`, {
    method: 'POST',
    user: ALICE,
    body: { restaurantId },
  });

  const bobsMap = await api(`/api/maps/${bob.body.maps[0].id}`, { user: BOB });
  assert.equal(bobsMap.body.restaurants.length, 0, "Alice's pin must not appear on Bob's map");
});

test('a private map is not readable by another user', async () => {
  const alice = await api('/api/me', { user: ALICE });
  await api('/api/me', { user: BOB });

  const res = await api(`/api/maps/${alice.body.maps[0].id}`, { user: BOB });
  assert.equal(res.status, 403);
});

test('a public map is readable by anyone but writable only by its owner', async () => {
  const alice = await api('/api/me', { user: ALICE });
  const mapId = alice.body.maps[0].id;
  await api('/api/me', { user: BOB });

  await api(`/api/maps/${mapId}`, { method: 'PATCH', user: ALICE, body: { isPublic: true } });

  const bobReads = await api(`/api/maps/${mapId}`, { user: BOB });
  assert.equal(bobReads.status, 200);
  assert.equal(bobReads.body.isOwner, false);

  const bobWrites = await api(`/api/maps/${mapId}`, {
    method: 'PATCH',
    user: BOB,
    body: { name: 'Hijacked' },
  });
  assert.equal(bobWrites.status, 403);
});

test('another user cannot pin to a map they do not own', async () => {
  const alice = await api('/api/me', { user: ALICE });
  await api('/api/me', { user: BOB });
  const restaurantId = await seedRestaurant();

  const res = await api(`/api/maps/${alice.body.maps[0].id}/restaurants`, {
    method: 'POST',
    user: BOB,
    body: { restaurantId },
  });

  assert.equal(res.status, 403);
});

test('removing a pin leaves the shared restaurant in the catalog', async () => {
  const me = await api('/api/me', { user: ALICE });
  const mapId = me.body.maps[0].id;
  const restaurantId = await seedRestaurant();

  await api(`/api/maps/${mapId}/restaurants`, { method: 'POST', user: ALICE, body: { restaurantId } });
  const removed = await api(`/api/maps/${mapId}/restaurants/${restaurantId}`, {
    method: 'DELETE',
    user: ALICE,
  });

  assert.equal(removed.status, 204);

  const still = await api(`/api/restaurants/${restaurantId}`);
  assert.equal(still.status, 200, 'the catalog entry is shared and must survive');
});

test('excludeMapId hides what is already pinned', async () => {
  const me = await api('/api/me', { user: ALICE });
  const mapId = me.body.maps[0].id;
  const pinned = await seedRestaurant({ name: 'Already Added' });
  await seedRestaurant({ name: 'Already Missing' });

  await api(`/api/maps/${mapId}/restaurants`, {
    method: 'POST',
    user: ALICE,
    body: { restaurantId: pinned },
  });

  const res = await api(`/api/restaurants/search?q=Already&excludeMapId=${mapId}`, { user: ALICE });

  assert.equal(res.body.count, 1);
  assert.equal(res.body.restaurants[0].name, 'Already Missing');
});

test('rejects a malformed uuid rather than reaching the database', async () => {
  const res = await api('/api/restaurants/not-a-uuid');
  assert.equal(res.status, 400);
  assert.ok(res.body.error.details.fields.id);
});

test('creating a map requires a name', async () => {
  const res = await api('/api/maps', { method: 'POST', user: ALICE, body: { name: '   ' } });
  assert.equal(res.status, 400);
});

test('deleting a map removes it from the user list', async () => {
  await api('/api/me', { user: ALICE });
  const created = await api('/api/maps', { method: 'POST', user: ALICE, body: { name: 'Trip Food' } });

  const deleted = await api(`/api/maps/${created.body.map.id}`, { method: 'DELETE', user: ALICE });
  assert.equal(deleted.status, 204);

  const me = await api('/api/me', { user: ALICE });
  assert.equal(me.body.maps.length, 1, 'only the starter map should remain');
});
