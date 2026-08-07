/**
 * Geocoding tests.
 *
 * Pure logic only — no network calls, so the suite stays fast and does not
 * depend on the Census or Nominatim services being reachable.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { splitAddress } from '../server/providers/geocoding/census.js';
import { activeProviders } from '../server/providers/geocoding/index.js';

test('splits a Census matched address into components', () => {
  // This is exactly the shape the live Census geocoder returns.
  assert.deepEqual(splitAddress('3014 W OLYMPIC BLVD, LOS ANGELES, CA, 90006'), {
    line1: '3014 W OLYMPIC BLVD',
    city: 'LOS ANGELES',
    state: 'CA',
    postalCode: '90006',
  });

  assert.deepEqual(splitAddress('1000 VIN SCULLY AVE, LOS ANGELES, CA, 90012'), {
    line1: '1000 VIN SCULLY AVE',
    city: 'LOS ANGELES',
    state: 'CA',
    postalCode: '90012',
  });
});

test('splitting prevents the duplicated-state display bug', () => {
  // Regression guard. Storing the whole formatted address in address_line1 and
  // then re-appending city and state for display produced
  // "3014 W OLYMPIC BLVD, LOS ANGELES, CA, 90006, CA".
  const parts = splitAddress('3014 W OLYMPIC BLVD, LOS ANGELES, CA, 90006');
  const rendered = [parts.line1, parts.city, parts.state].filter(Boolean).join(', ');

  assert.equal(rendered, '3014 W OLYMPIC BLVD, LOS ANGELES, CA');
  assert.equal(rendered.match(/CA/g).length, 1, 'the state must appear exactly once');
});

test('tolerates an address with missing trailing parts', () => {
  // Missing parts are null rather than undefined, because these go straight
  // into nullable database columns.
  assert.deepEqual(splitAddress('123 MAIN ST, PASADENA'), {
    line1: '123 MAIN ST',
    city: 'PASADENA',
    state: null,
    postalCode: null,
  });
});

test('returns null for something that cannot be split', () => {
  assert.equal(splitAddress('somewhere'), null);
  assert.equal(splitAddress(''), null);
});

test('provider order puts free, keyless services first when Google is absent', () => {
  // Without GOOGLE_MAPS_API_KEY the Google provider reports itself unavailable
  // and drops out, leaving Census (authoritative for US streets) ahead of
  // Nominatim (rate-limited, used only as a fallback).
  const names = activeProviders().map((p) => p.name);

  assert.deepEqual(names, ['census', 'nominatim']);
  assert.ok(!names.includes('google'), 'Google must stay dormant without a key');
});
