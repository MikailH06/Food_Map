/**
 * Schema tests.
 *
 * These check the guarantees the application relies on but does not enforce
 * itself: constraints, cascade behaviour, the community-stats view, and the
 * search indexes. If any of these break, bugs surface far away from the cause.
 */

import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  setupDb,
  teardownDb,
  truncateAll,
  makeProfile,
  makeMap,
  makeRestaurant,
  db,
} from './helpers/db.js';

before(async () => {
  await setupDb();
});
after(async () => {
  await teardownDb();
});
beforeEach(async () => {
  await truncateAll();
});

test('creates every expected table', async () => {
  const { rows } = await db.query(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    ORDER BY table_name
  `);
  const tables = rows.map((r) => r.table_name);

  for (const expected of [
    'enrichment_jobs',
    'map_restaurants',
    'maps',
    'profiles',
    'ratings',
    'restaurant_photos',
    'restaurants',
    'schema_migrations',
  ]) {
    assert.ok(tables.includes(expected), `missing table: ${expected}`);
  }
});

test('rejects a star rating outside 1-5', async () => {
  const user = await makeProfile();
  const restaurant = await makeRestaurant();

  for (const bad of [0, 6, -1]) {
    await assert.rejects(
      () =>
        db.query('INSERT INTO ratings (user_id, restaurant_id, stars) VALUES ($1,$2,$3)', [
          user,
          restaurant,
          bad,
        ]),
      /violates check constraint/i,
      `stars=${bad} should have been rejected`
    );
  }
});

test('allows only one rating per user per restaurant', async () => {
  const user = await makeProfile();
  const restaurant = await makeRestaurant();

  await db.query('INSERT INTO ratings (user_id, restaurant_id, stars) VALUES ($1,$2,4)', [
    user,
    restaurant,
  ]);

  await assert.rejects(
    () =>
      db.query('INSERT INTO ratings (user_id, restaurant_id, stars) VALUES ($1,$2,5)', [
        user,
        restaurant,
      ]),
    /duplicate key value|unique constraint/i
  );
});

test('deleting a map removes its pins but not the shared restaurant', async () => {
  const user = await makeProfile();
  const map = await makeMap(user);
  const restaurant = await makeRestaurant();

  await db.query('INSERT INTO map_restaurants (map_id, restaurant_id) VALUES ($1,$2)', [
    map,
    restaurant,
  ]);

  await db.query('DELETE FROM maps WHERE id = $1', [map]);

  const pins = await db.query('SELECT count(*)::int AS c FROM map_restaurants');
  assert.equal(pins.rows[0].c, 0, 'pins should cascade away with the map');

  const restaurants = await db.query('SELECT count(*)::int AS c FROM restaurants');
  assert.equal(restaurants.rows[0].c, 1, 'the shared restaurant must survive');
});

test('the same restaurant can sit on two different users maps', async () => {
  const alice = await makeProfile('Alice');
  const bob = await makeProfile('Bob');
  const aliceMap = await makeMap(alice);
  const bobMap = await makeMap(bob);
  const restaurant = await makeRestaurant();

  await db.query('INSERT INTO map_restaurants (map_id, restaurant_id) VALUES ($1,$2), ($3,$2)', [
    aliceMap,
    restaurant,
    bobMap,
  ]);

  const { rows } = await db.query('SELECT count(*)::int AS c FROM map_restaurants');
  assert.equal(rows[0].c, 2);
});

test('restaurant_stats averages ratings across all users', async () => {
  const alice = await makeProfile('Alice');
  const bob = await makeProfile('Bob');
  const carol = await makeProfile('Carol');
  const restaurant = await makeRestaurant();

  // 5, 4, 3 -> mean 4.00; price levels 2, 2, 3 -> mode 2
  await db.query(
    `INSERT INTO ratings (user_id, restaurant_id, stars, price_level)
     VALUES ($1,$4,5,2), ($2,$4,4,2), ($3,$4,3,3)`,
    [alice, bob, carol, restaurant]
  );

  const { rows } = await db.query('SELECT * FROM restaurant_stats WHERE restaurant_id = $1', [
    restaurant,
  ]);

  assert.equal(Number(rows[0].avg_stars), 4);
  assert.equal(rows[0].rating_count, 3);
  assert.equal(rows[0].modal_price_level, 2);
});

test('full-text search matches on cuisine, not just name', async () => {
  await makeRestaurant({
    name: 'Guelaguetza',
    city: 'Los Angeles',
    cuisines: ['oaxacan', 'mexican'],
  });

  // A user searching "oaxacan" should find it even though the word appears
  // nowhere in the restaurant's name.
  const { rows } = await db.query(
    `SELECT name FROM restaurants WHERE search_vec @@ plainto_tsquery('english', $1)`,
    ['oaxacan']
  );

  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'Guelaguetza');
});

test('trigram search tolerates a misspelling', async () => {
  await makeRestaurant({ name: 'Chipotle Mexican Grill' });

  const { rows } = await db.query(
    `SELECT name, similarity(name, $1) AS score
     FROM restaurants
     WHERE similarity(name, $1) > 0.15
     ORDER BY score DESC`,
    ['chipolte']
  );

  assert.equal(rows.length, 1, '"chipolte" should still find Chipotle');
  assert.ok(rows[0].score > 0.15);
});

test('re-importing the same OSM node does not duplicate it', async () => {
  await makeRestaurant({ source: 'osm', source_id: 'node/12345', name: 'Langers Deli' });

  await assert.rejects(
    () => makeRestaurant({ source: 'osm', source_id: 'node/12345', name: 'Langers Deli' }),
    /duplicate key value|unique constraint/i,
    'the seed importer relies on this to stay idempotent'
  );
});

test('user-created restaurants are exempt from the source uniqueness rule', async () => {
  // Two people may add distinct places that both have a null source_id.
  await makeRestaurant({ source: 'user', source_id: null, name: 'Taco Spot A' });
  await makeRestaurant({ source: 'user', source_id: null, name: 'Taco Spot B' });

  const { rows } = await db.query('SELECT count(*)::int AS c FROM restaurants');
  assert.equal(rows[0].c, 2);
});

test('updated_at advances on update', async () => {
  const restaurant = await makeRestaurant();
  const before = await db.query('SELECT updated_at FROM restaurants WHERE id = $1', [restaurant]);

  await db.query('UPDATE restaurants SET name = $2 WHERE id = $1', [restaurant, 'Renamed']);

  const after = await db.query('SELECT updated_at FROM restaurants WHERE id = $1', [restaurant]);
  assert.ok(
    new Date(after.rows[0].updated_at) >= new Date(before.rows[0].updated_at),
    'the set_updated_at trigger should have fired'
  );
});

test('rejects impossible coordinates', async () => {
  await assert.rejects(
    () => makeRestaurant({ lat: 91, lng: 0 }),
    /violates check constraint/i,
    'latitude above 90 is not a place'
  );
});
