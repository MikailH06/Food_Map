/**
 * US Census Bureau geocoder.
 *
 * The primary provider: free, no API key, no registration, no rate limit, and
 * authoritative for US street addresses because it geocodes against the
 * government's own TIGER address data. For an LA County app that is a better
 * fit than any commercial service.
 *
 * Limitation: it matches street addresses only. It will not resolve a place
 * name ("Guelaguetza") or a vague description, which is why Nominatim backs it
 * up.
 *
 * https://geocoding.geo.census.gov/geocoder/
 */

const ENDPOINT = 'https://geocoding.geo.census.gov/geocoder/locations/onelineaddress';

export const name = 'census';

/** No key needed, so this is always usable. */
export function isAvailable() {
  return true;
}

/**
 * @param {string} address
 * @returns {Promise<import('./index.js').GeocodeResult|null>}
 */
export async function geocode(address) {
  const url = new URL(ENDPOINT);
  url.searchParams.set('address', address);
  // "Current" tracks the latest published address ranges.
  url.searchParams.set('benchmark', 'Public_AR_Current');
  url.searchParams.set('format', 'json');

  const response = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(8_000),
  });

  if (!response.ok) {
    throw new Error(`Census geocoder returned ${response.status}`);
  }

  const data = await response.json();
  const match = data?.result?.addressMatches?.[0];
  if (!match) return null;

  // Census returns x as longitude and y as latitude — the opposite order from
  // how they are usually written, and an easy source of transposed coordinates.
  const lng = match.coordinates?.x;
  const lat = match.coordinates?.y;
  if (typeof lat !== 'number' || typeof lng !== 'number') return null;

  const formatted = match.matchedAddress ?? address;

  return {
    lat,
    lng,
    formattedAddress: formatted,
    components: splitAddress(formatted),
    provider: name,
    confidence: 'exact',
  };
}

/**
 * Split a Census matched address into parts.
 *
 * Census returns a predictable comma-separated shape:
 *   "3014 W OLYMPIC BLVD, LOS ANGELES, CA, 90006"
 *
 * Returning components rather than one string matters: storing the whole
 * formatted address in address_line1 and then re-appending the city and state
 * for display produces "…, LOS ANGELES, CA, 90006, CA".
 */
export function splitAddress(formatted) {
  const parts = formatted.split(',').map((p) => p.trim()).filter(Boolean);
  if (parts.length < 2) return null;

  const [line1, city, state, postalCode] = parts;
  return {
    line1: line1 ?? null,
    city: city ?? null,
    state: state ?? null,
    postalCode: postalCode ?? null,
  };
}
