/**
 * Three-layer resolver tests.
 *
 * The resolver decides what a user actually sees, so the layering rules need to
 * hold precisely. In particular: resolution is PER FIELD, so a restaurant can
 * take its rating from the community and its photo from its own website in the
 * same response. That combination is the normal case given measured coverage
 * (ratings 0.7% from websites, photos 62.9%), not an edge case.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveRestaurant, resolveMany } from '../server/services/resolver.js';

/** A catalog row with nothing filled in beyond the essentials. */
const bareRow = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  name: 'Guelaguetza',
  address_line1: '3014 W Olympic Blvd',
  city: 'Los Angeles',
  state: 'CA',
  postal_code: '90006',
  lat: 34.0522,
  lng: -118.3,
  cuisines: ['oaxacan', 'mexican'],
  phone: '+1-213-427-0608',
  website: 'https://guelaguetza.example.com',
  opening_hours: null,
  source: 'osm',
  ext_rating: null,
  ext_rating_count: null,
  ext_price_level: null,
  ext_photo_url: null,
  ext_description: null,
  ext_source: null,
  enrich_status: 'pending',
  avg_stars: null,
  rating_count: null,
  modal_price_level: null,
};

const row = (overrides) => ({ ...bareRow, ...overrides });

test('an unenriched, unrated restaurant resolves every optional field to null', () => {
  const result = resolveRestaurant(row({}));

  assert.equal(result.rating, null, 'null means "nobody has said anything", not zero stars');
  assert.equal(result.price, null);
  assert.equal(result.photo, null);
  assert.equal(result.description, null);

  // The facts we do have still come through.
  assert.equal(result.name, 'Guelaguetza');
  assert.equal(result.address.full, '3014 W Olympic Blvd, Los Angeles, CA');
  assert.deepEqual(result.cuisines, ['oaxacan', 'mexican']);
});

test('community rating is used when no external rating exists', () => {
  const result = resolveRestaurant(row({ avg_stars: '4.33', rating_count: 3 }));

  assert.equal(result.rating.value, 4.33);
  assert.equal(result.rating.count, 3);
  assert.equal(result.rating.source, 'community');
});

test('an external rating outranks the community one', () => {
  // An aggregate over thousands beats an aggregate over three.
  const result = resolveRestaurant(
    row({
      ext_rating: '4.4',
      ext_rating_count: 2841,
      ext_source: 'website',
      avg_stars: '2.00',
      rating_count: 3,
    })
  );

  assert.equal(result.rating.value, 4.4);
  assert.equal(result.rating.count, 2841);
  assert.equal(result.rating.source, 'website');
});

test('Google is attributed distinctly from a website rating', () => {
  const result = resolveRestaurant(
    row({ ext_rating: '4.6', ext_rating_count: 5000, ext_source: 'google' })
  );

  assert.equal(result.rating.source, 'google');
});

test('rating and photo resolve from DIFFERENT layers in the same response', () => {
  // The realistic shape: the website published a photo but no rating, so the
  // rating falls through to the community while the photo does not.
  const result = resolveRestaurant(
    row({
      ext_photo_url: 'https://example.com/dining-room.jpg',
      ext_source: 'website',
      avg_stars: '4.50',
      rating_count: 2,
    })
  );

  assert.equal(result.photo.source, 'website');
  assert.equal(result.rating.source, 'community');
  assert.equal(result.rating.value, 4.5);
});

test('price falls back to the community mode and renders as symbols', () => {
  const community = resolveRestaurant(row({ modal_price_level: 2 }));
  assert.equal(community.price.level, 2);
  assert.equal(community.price.symbols, '$$');
  assert.equal(community.price.source, 'community');

  const external = resolveRestaurant(
    row({ ext_price_level: 3, ext_source: 'website', modal_price_level: 1 })
  );
  assert.equal(external.price.level, 3);
  assert.equal(external.price.symbols, '$$$');
  assert.equal(external.price.source, 'website');
});

test('a user-uploaded photo outranks one scraped from the website', () => {
  // og:image is frequently a logo rather than food, so a photo a human
  // deliberately uploaded wins.
  const result = resolveRestaurant(row({ ext_photo_url: 'https://example.com/logo.png' }), {
    userPhotoUrl: 'https://storage.example.com/real-food.jpg',
  });

  assert.equal(result.photo.url, 'https://storage.example.com/real-food.jpg');
  assert.equal(result.photo.source, 'community');
});

test("the viewer's own rating is surfaced separately from the average", () => {
  const result = resolveRestaurant(row({ avg_stars: '3.50', rating_count: 4 }), {
    viewerRating: { stars: 5, price_level: 2, comment: 'The mole is worth the drive' },
  });

  assert.equal(result.rating.value, 3.5, 'the shared average is unaffected by the viewer');
  assert.equal(result.yourRating.stars, 5);
  assert.equal(result.yourRating.comment, 'The mole is worth the drive');
});

test('yourRating is null when the viewer has not rated', () => {
  assert.equal(resolveRestaurant(row({})).yourRating, null);
});

test('assembles a partial address without stray separators', () => {
  const noCity = resolveRestaurant(row({ address_line1: '123 Main St', city: null, state: null }));
  assert.equal(noCity.address.full, '123 Main St');

  const nothing = resolveRestaurant(row({ address_line1: null, city: null, state: null }));
  assert.equal(nothing.address.full, null);
});

test('resolveMany attaches the right photo and rating to each restaurant', () => {
  const a = row({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', name: 'A' });
  const b = row({ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', name: 'B' });

  const resolved = resolveMany([a, b], {
    photosByRestaurant: new Map([[a.id, 'https://x.com/a.jpg']]),
    ratingsByRestaurant: new Map([[b.id, { stars: 4, price_level: null, comment: null }]]),
  });

  assert.equal(resolved[0].photo.url, 'https://x.com/a.jpg');
  assert.equal(resolved[0].yourRating, null);
  assert.equal(resolved[1].photo, null);
  assert.equal(resolved[1].yourRating.stars, 4);
});

test('carries pin metadata through for map listings', () => {
  const result = resolveRestaurant(
    row({ notes: 'Get the mole negro', added_at: '2026-08-07T00:00:00Z', distance_meters: 832.5 })
  );

  assert.equal(result.meta.notes, 'Get the mole negro');
  assert.equal(result.meta.distanceMeters, 832.5);
});

test('resolving null yields null rather than throwing', () => {
  assert.equal(resolveRestaurant(null), null);
});
