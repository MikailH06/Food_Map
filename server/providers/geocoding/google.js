/**
 * Google Geocoding API.
 *
 * FULLY IMPLEMENTED — not a stub. It is simply unreachable until
 * GOOGLE_MAPS_API_KEY is set, at which point isAvailable() returns true and the
 * registry starts preferring it. No code change is needed to switch over.
 *
 * Worth the money if you ever want it: Google resolves business names, partial
 * addresses and misspellings that neither Census nor Nominatim will match.
 *
 * Billing note: geocoding is charged per request. Results are cached in the
 * maps table (center_lat/center_lng), so a repeated address costs nothing.
 *
 * https://developers.google.com/maps/documentation/geocoding
 */

import { providers, geography } from '../../config.js';

const ENDPOINT = 'https://maps.googleapis.com/maps/api/geocode/json';

export const name = 'google';

export function isAvailable() {
  return providers.googleEnabled;
}

/**
 * @param {string} address
 * @returns {Promise<import('./index.js').GeocodeResult|null>}
 */
export async function geocode(address) {
  if (!isAvailable()) {
    throw new Error('Google geocoding requires GOOGLE_MAPS_API_KEY');
  }

  const [[south, west], [north, east]] = geography.bounds;

  const url = new URL(ENDPOINT);
  url.searchParams.set('address', address);
  url.searchParams.set('key', providers.googleApiKey);
  // Bias towards the area we serve so "Main Street" resolves in LA rather than
  // in another state. This is a preference, not a hard filter.
  url.searchParams.set('bounds', `${south},${west}|${north},${east}`);
  url.searchParams.set('region', 'us');

  const response = await fetch(url, { signal: AbortSignal.timeout(8_000) });
  if (!response.ok) {
    throw new Error(`Google geocoding returned ${response.status}`);
  }

  const data = await response.json();

  // ZERO_RESULTS is a normal "no match", not a failure worth retrying.
  if (data.status === 'ZERO_RESULTS') return null;
  if (data.status !== 'OK') {
    throw new Error(`Google geocoding error: ${data.status} ${data.error_message ?? ''}`.trim());
  }

  const match = data.results?.[0];
  const location = match?.geometry?.location;
  if (!location) return null;

  return {
    lat: location.lat,
    lng: location.lng,
    formattedAddress: match.formatted_address ?? address,
    provider: name,
    // ROOFTOP means Google pinpointed the building; the rest are interpolated.
    confidence: match.geometry?.location_type === 'ROOFTOP' ? 'exact' : 'approximate',
  };
}
