/**
 * OpenStreetMap translation tests.
 *
 * OSM tags are hand-entered, so the interesting cases are the malformed ones.
 * These fixtures use tag shapes that genuinely occur in the LA County extract.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildOverpassQuery,
  parseCuisines,
  normalizeWebsite,
  formatAddress,
  osmElementToRestaurant,
  withinBounds,
  elementsToRestaurants,
} from '../server/services/osm.js';

test('the Overpass query covers ways and relations, not just nodes', () => {
  const query = buildOverpassQuery();

  // Restaurants mapped as building outlines are ways or relations. Querying
  // only nodes would silently lose a large share of the county.
  assert.match(query, /node\[/);
  assert.match(query, /way\[/);
  assert.match(query, /relation\[/);

  // Without `center`, ways and relations come back with no coordinates at all.
  assert.match(query, /out center tags;/);
  assert.match(query, /restaurant\|fast_food\|cafe/);
});

test('the bounding-box query mode emits south,west,north,east', () => {
  const query = buildOverpassQuery({
    bounds: [
      [32.75, -118.95],
      [34.85, -117.6],
    ],
  });

  assert.match(query, /\(32\.75,-118\.95,34\.85,-117\.6\)/);
  assert.doesNotMatch(query, /area/);
});

test('splits multi-value cuisine tags and converts underscores', () => {
  assert.deepEqual(parseCuisines('mexican;ice_cream'), ['mexican', 'ice cream']);
  assert.deepEqual(parseCuisines('Pizza'), ['pizza']);
  assert.deepEqual(parseCuisines('burger; ; sandwich'), ['burger', 'sandwich']);
  assert.deepEqual(parseCuisines('taco;taco'), ['taco'], 'duplicates collapse');
  assert.deepEqual(parseCuisines(''), []);
  assert.deepEqual(parseCuisines(null), []);
  assert.deepEqual(parseCuisines(undefined), []);
});

test('normalizes website values, rejecting the unusable ones', () => {
  assert.equal(normalizeWebsite('https://langersdeli.com'), 'https://langersdeli.com/');
  assert.equal(normalizeWebsite('http://example.com/menu'), 'http://example.com/menu');

  // Missing scheme is extremely common in OSM.
  assert.equal(normalizeWebsite('www.guelaguetza.com'), 'https://www.guelaguetza.com/');

  // Things the crawler could never fetch.
  assert.equal(normalizeWebsite('see facebook page'), null);
  assert.equal(normalizeWebsite('none'), null);
  assert.equal(normalizeWebsite('ftp://files.example.com'), null);
  assert.equal(normalizeWebsite(''), null);
  assert.equal(normalizeWebsite(null), null);
});

test('joins house number and street, tolerating either being absent', () => {
  assert.deepEqual(
    formatAddress({
      'addr:housenumber': '704',
      'addr:street': 'S Alvarado St',
      'addr:city': 'Los Angeles',
      'addr:postcode': '90057',
    }),
    {
      address_line1: '704 S Alvarado St',
      city: 'Los Angeles',
      state: 'CA',
      postal_code: '90057',
    }
  );

  // Street with no number still locates the place well enough to show.
  assert.equal(formatAddress({ 'addr:street': 'Sunset Blvd' }).address_line1, 'Sunset Blvd');

  // A house number alone is meaningless without a street.
  assert.equal(formatAddress({ 'addr:housenumber': '704' }).address_line1, null);
  assert.equal(formatAddress({}).address_line1, null);
  assert.equal(formatAddress({}).state, 'CA');
});

test('converts a node element', () => {
  const row = osmElementToRestaurant({
    type: 'node',
    id: 358761437,
    lat: 34.0576,
    lon: -118.2917,
    tags: {
      name: 'Langer’s Delicatessen',
      amenity: 'restaurant',
      cuisine: 'sandwich;jewish',
      'addr:housenumber': '704',
      'addr:street': 'S Alvarado St',
      'addr:city': 'Los Angeles',
      phone: '+1-213-483-8050',
      website: 'https://langersdeli.com',
      opening_hours: 'Tu-Sa 08:00-16:00',
    },
  });

  assert.equal(row.source, 'osm');
  assert.equal(row.source_id, 'node/358761437');
  assert.equal(row.name, 'Langer’s Delicatessen');
  assert.equal(row.address_line1, '704 S Alvarado St');
  assert.equal(row.lat, 34.0576);
  assert.equal(row.lng, -118.2917);
  assert.equal(row.phone, '+1-213-483-8050');
  assert.equal(row.opening_hours, 'Tu-Sa 08:00-16:00');

  // The amenity type joins the cuisine list so "restaurant" is searchable.
  assert.ok(row.cuisines.includes('sandwich'));
  assert.ok(row.cuisines.includes('jewish'));
  assert.ok(row.cuisines.includes('restaurant'));
});

test('converts a way element using its computed centre', () => {
  // A restaurant mapped as a building outline has no lat/lon of its own.
  const row = osmElementToRestaurant({
    type: 'way',
    id: 123456,
    center: { lat: 34.1016, lon: -118.3267 },
    tags: { name: 'Musso & Frank Grill', amenity: 'restaurant' },
  });

  assert.equal(row.source_id, 'way/123456');
  assert.equal(row.lat, 34.1016);
  assert.equal(row.lng, -118.3267);
});

test('reads the contact: tag variants', () => {
  const row = osmElementToRestaurant({
    type: 'node',
    id: 1,
    lat: 34,
    lon: -118,
    tags: {
      name: 'Some Cafe',
      amenity: 'cafe',
      'contact:phone': '+1-310-555-0100',
      'contact:website': 'example.com',
    },
  });

  assert.equal(row.phone, '+1-310-555-0100');
  assert.equal(row.website, 'https://example.com/');
});

test('discards elements that cannot be shown as a pin', () => {
  // No name — nothing to label the pin with.
  assert.equal(
    osmElementToRestaurant({ type: 'node', id: 1, lat: 34, lon: -118, tags: { amenity: 'restaurant' } }),
    null
  );

  // No coordinates — nothing to place.
  assert.equal(
    osmElementToRestaurant({ type: 'way', id: 2, tags: { name: 'Ghost Kitchen' } }),
    null
  );

  assert.equal(osmElementToRestaurant(null), null);
  assert.equal(osmElementToRestaurant({}), null);
});

test('bounds check keeps LA County and excludes neighbours', () => {
  assert.ok(withinBounds(34.0522, -118.2437), 'downtown LA is inside');
  assert.ok(withinBounds(33.3879, -118.4163), 'Catalina Island is legally LA County');

  assert.ok(!withinBounds(37.7749, -122.4194), 'San Francisco is outside');
  assert.ok(!withinBounds(32.7157, -117.1611), 'San Diego is outside');
});

test('summarises what a whole response yielded and dropped', () => {
  const { rows, skipped } = elementsToRestaurants([
    { type: 'node', id: 1, lat: 34.05, lon: -118.24, tags: { name: 'Good One', amenity: 'restaurant' } },
    { type: 'node', id: 2, lat: 34.06, lon: -118.25, tags: { amenity: 'restaurant' } },
    { type: 'way', id: 3, tags: { name: 'No Coords' } },
    { type: 'node', id: 4, lat: 37.77, lon: -122.41, tags: { name: 'In SF', amenity: 'restaurant' } },
    { type: 'node', id: 1, lat: 34.05, lon: -118.24, tags: { name: 'Good One', amenity: 'restaurant' } },
  ]);

  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'Good One');
  assert.equal(skipped.unnamed, 1);
  assert.equal(skipped.noCoords, 1);
  assert.equal(skipped.outOfBounds, 1);
  assert.equal(skipped.duplicate, 1, 'a repeated element would abort the whole batch insert');
});
