/**
 * Nominatim (OpenStreetMap) geocoder.
 *
 * The fallback for anything the Census geocoder cannot match — most usefully
 * place names rather than street addresses, since a user may well type
 * "Guelaguetza, Los Angeles" instead of a street number.
 *
 * Nominatim is donated infrastructure with a strict usage policy: at most one
 * request per second, and a genuine User-Agent identifying the application.
 * Both are enforced here rather than left to the caller. Because it only runs
 * when Census has already failed, the real request rate stays far below the
 * limit.
 *
 * https://operations.osmfoundation.org/policies/nominatim/
 */

import { enrichment } from '../../config.js';

const ENDPOINT = 'https://nominatim.openstreetmap.org/search';
const MIN_INTERVAL_MS = 1_100;

export const name = 'nominatim';

let lastRequestAt = 0;
let queue = Promise.resolve();

export function isAvailable() {
  return true;
}

/**
 * Serialise calls and space them at least MIN_INTERVAL_MS apart.
 *
 * Chaining onto a shared promise means concurrent callers queue rather than all
 * sleeping the same amount and then firing simultaneously.
 */
function rateLimited(fn) {
  const result = queue.then(async () => {
    const wait = Math.max(0, lastRequestAt + MIN_INTERVAL_MS - Date.now());
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastRequestAt = Date.now();
    return fn();
  });

  // Keep the chain alive even when one call rejects.
  queue = result.catch(() => {});
  return result;
}

/**
 * @param {string} address
 * @returns {Promise<import('./index.js').GeocodeResult|null>}
 */
export async function geocode(address) {
  return rateLimited(async () => {
    const url = new URL(ENDPOINT);
    url.searchParams.set('q', address);
    url.searchParams.set('format', 'jsonv2');
    url.searchParams.set('limit', '1');
    url.searchParams.set('countrycodes', 'us');
    url.searchParams.set('addressdetails', '1');

    const response = await fetch(url, {
      headers: {
        // The usage policy requires this to identify a real application.
        'User-Agent': enrichment.userAgent,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(8_000),
    });

    if (!response.ok) {
      throw new Error(`Nominatim returned ${response.status}`);
    }

    const results = await response.json();
    const match = Array.isArray(results) ? results[0] : null;
    if (!match) return null;

    const lat = Number.parseFloat(match.lat);
    const lng = Number.parseFloat(match.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

    return {
      lat,
      lng,
      formattedAddress: match.display_name ?? address,
      provider: name,
      // Nominatim happily returns a whole city for a vague query, so only a
      // building-level match counts as exact.
      confidence: ['house', 'building', 'amenity', 'shop'].includes(match.category)
        ? 'exact'
        : 'approximate',
    };
  });
}
