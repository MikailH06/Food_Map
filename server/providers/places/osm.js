/**
 * OpenStreetMap places provider.
 *
 * Searches the catalog we seeded into our own Postgres. Because the data is
 * local there is no quota, no rate limit and no per-request cost, and searches
 * answer in milliseconds — measured at 6-44ms across 13,191 LA County rows.
 *
 * Its limitation is coverage: OpenStreetMap knows about ~13k LA County
 * restaurants, while county health records list 30k+ food businesses. That gap
 * is why users can add a restaurant manually, and one of the reasons to enable
 * the Google provider if you ever want to pay for it.
 */

import { searchRestaurants, getRestaurantById } from '../../services/search.js';

export const name = 'osm';

/** Always available — it is just our own database. */
export function isAvailable() {
  return true;
}

/**
 * @param {string} query
 * @param {{lat: number, lng: number, radiusMeters: number}} [near]
 * @returns {Promise<Array>}
 */
export async function searchPlaces(query, near = null) {
  return searchRestaurants({
    q: query,
    lat: near?.lat ?? null,
    lng: near?.lng ?? null,
    radiusMeters: near?.radiusMeters ?? null,
  });
}

/**
 * @param {string} id  our own restaurant uuid
 * @returns {Promise<object|null>}
 */
export async function getPlaceDetails(id) {
  return getRestaurantById(id);
}
