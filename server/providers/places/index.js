/**
 * Places registry.
 *
 * Finds restaurants. Defaults to our own seeded catalog; switches to Google
 * automatically when GOOGLE_MAPS_API_KEY is present.
 */

import { providers as providerConfig } from '../../config.js';
import * as osm from './osm.js';
import * as google from './google.js';

const ALL = { osm, google };

/** The provider that should answer right now. */
export function activeProvider() {
  return providerConfig.googleEnabled ? google : osm;
}

export function activeProviderName() {
  return activeProvider().name;
}

/**
 * @param {string} query
 * @param {{lat: number, lng: number, radiusMeters: number}} [near]
 */
export async function searchPlaces(query, near = null) {
  return activeProvider().searchPlaces(query, near);
}

/**
 * Look up one place.
 *
 * Google place ids are opaque strings while ours are uuids, so the id shape
 * decides who answers. That keeps a restaurant imported from Google resolvable
 * even if the key is later removed.
 */
export async function getPlaceDetails(id) {
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);

  if (isUuid) return osm.getPlaceDetails(id);
  if (google.isAvailable()) return google.getPlaceDetails(id);
  return null;
}

export { osm, google, ALL };
