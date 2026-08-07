/**
 * Google Places API (New).
 *
 * FULLY IMPLEMENTED — not a stub. Unreachable until GOOGLE_MAPS_API_KEY is set;
 * once it is, isAvailable() returns true and the registry prefers it
 * automatically. Switching the whole app to Google is that one env var.
 *
 * What it adds over the free stack:
 *   - real ratings and review counts
 *   - real price levels
 *   - real photos of the restaurant
 *   - coverage of LA County's ~30k+ food businesses rather than the ~13k
 *     that OpenStreetMap knows about
 *
 * Billing, so you can predict the cost before enabling it: both calls below are
 * billed per request, and the field mask directly affects the rate — asking for
 * rating, priceLevel or photos moves a call into a more expensive tier. The
 * masks here are deliberately minimal. Results are cached in the restaurants
 * table and refreshed at most every ENRICH_REFRESH_DAYS (default 30), so a
 * pinned restaurant costs roughly one call a month, not one per page view.
 *
 * https://developers.google.com/maps/documentation/places/web-service/op-overview
 */

import { providers, geography } from '../../config.js';
import { normalizePriceLevel } from '../../services/enrichment/priceNormalizer.js';

const SEARCH_URL = 'https://places.googleapis.com/v1/places:searchText';
const DETAILS_URL = 'https://places.googleapis.com/v1/places';

export const name = 'google';

export function isAvailable() {
  return providers.googleEnabled;
}

/** Only the fields we actually use — every extra field can raise the price. */
const SEARCH_FIELDS = [
  'places.id',
  'places.displayName',
  'places.formattedAddress',
  'places.location',
  'places.types',
  'places.rating',
  'places.userRatingCount',
  'places.priceLevel',
  'places.photos',
  'places.nationalPhoneNumber',
  'places.websiteUri',
].join(',');

/**
 * Field masks decide what you are BILLED, not just what you receive.
 *
 * Since March 2025 Google has priced Places by SKU tier, each with its own free
 * monthly allowance — roughly 10,000 calls for Essentials, 5,000 for Pro and
 * 1,000 for Enterprise. Asking for a single Enterprise field promotes the whole
 * call to the Enterprise tier and its much smaller free allowance.
 *
 * So the default mask below stops at the fields we actually need — rating,
 * price and photos — and the richer extras are opt-in via GOOGLE_RICH_DETAILS.
 * Turning that on cuts the free allowance roughly fivefold, which is why it is
 * off.
 *
 * Verify the current tier of each field before changing this list:
 * https://developers.google.com/maps/documentation/places/web-service/place-details
 */
const DETAILS_FIELDS_STANDARD = [
  'id',
  'displayName',
  'formattedAddress',
  'location',
  'types',
  'rating',
  'userRatingCount',
  'priceLevel',
  'photos',
  'nationalPhoneNumber',
  'websiteUri',
];

/** Nice to have, but they raise the billing tier. */
const DETAILS_FIELDS_RICH = ['regularOpeningHours', 'editorialSummary', 'addressComponents'];

const DETAILS_FIELDS = (
  process.env.GOOGLE_RICH_DETAILS === 'true'
    ? [...DETAILS_FIELDS_STANDARD, ...DETAILS_FIELDS_RICH]
    : DETAILS_FIELDS_STANDARD
).join(',');

/** Build a URL that serves a photo. The reference alone is not an image URL. */
function photoUrl(photos, maxWidthPx = 800) {
  const reference = photos?.[0]?.name;
  if (!reference) return null;
  return `https://places.googleapis.com/v1/${reference}/media?maxWidthPx=${maxWidthPx}&key=${providers.googleApiKey}`;
}

/** Map a Places resource onto our restaurant shape. */
function toCandidate(place) {
  const address = place.formattedAddress ?? '';
  // "3014 W Olympic Blvd, Los Angeles, CA 90006, USA"
  const [street, city, stateZip] = address.split(',').map((s) => s.trim());
  const [state, postalCode] = (stateZip ?? '').split(' ').filter(Boolean);

  return {
    source: 'google',
    source_id: place.id,
    google_place_id: place.id,
    name: place.displayName?.text ?? 'Unknown',
    address_line1: street ?? null,
    city: city ?? null,
    state: state ?? 'CA',
    postal_code: postalCode ?? null,
    lat: place.location?.latitude ?? null,
    lng: place.location?.longitude ?? null,
    cuisines: (place.types ?? [])
      .filter((t) => !['point_of_interest', 'establishment', 'food'].includes(t))
      .map((t) => t.replace(/_/g, ' ')),
    phone: place.nationalPhoneNumber ?? null,
    website: place.websiteUri ?? null,
    opening_hours: place.regularOpeningHours?.weekdayDescriptions?.join('; ') ?? null,

    rating: typeof place.rating === 'number' ? place.rating : null,
    ratingCount: place.userRatingCount ?? null,
    priceLevel: normalizePriceLevel(place.priceLevel),
    photoUrl: photoUrl(place.photos),
    description: place.editorialSummary?.text ?? null,
  };
}

async function request(url, { method = 'GET', body = null, fieldMask }) {
  const response = await fetch(url, {
    method,
    headers: {
      'X-Goog-Api-Key': providers.googleApiKey,
      'X-Goog-FieldMask': fieldMask,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(8_000),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Google Places ${response.status}: ${text.slice(0, 300)}`);
  }

  return response.json();
}

/**
 * @param {string} query
 * @param {{lat: number, lng: number, radiusMeters: number}} [near]
 * @returns {Promise<Array>}
 */
export async function searchPlaces(query, near = null) {
  if (!isAvailable()) throw new Error('Google Places requires GOOGLE_MAPS_API_KEY');

  const body = {
    textQuery: query,
    includedType: 'restaurant',
    maxResultCount: 20,
    // Keep results inside the area we serve.
    locationRestriction: {
      rectangle: {
        low: { latitude: geography.bounds[0][0], longitude: geography.bounds[0][1] },
        high: { latitude: geography.bounds[1][0], longitude: geography.bounds[1][1] },
      },
    },
  };

  if (near) {
    body.locationBias = {
      circle: {
        center: { latitude: near.lat, longitude: near.lng },
        radius: Math.min(near.radiusMeters ?? 5000, 50000),
      },
    };
  }

  const data = await request(SEARCH_URL, { method: 'POST', body, fieldMask: SEARCH_FIELDS });
  return (data.places ?? []).map(toCandidate);
}

/**
 * @param {string} placeId
 * @returns {Promise<object|null>}
 */
export async function getPlaceDetails(placeId) {
  if (!isAvailable()) throw new Error('Google Places requires GOOGLE_MAPS_API_KEY');

  try {
    const place = await request(`${DETAILS_URL}/${encodeURIComponent(placeId)}`, {
      fieldMask: DETAILS_FIELDS,
    });
    return toCandidate(place);
  } catch (err) {
    // A deleted or merged place is a normal outcome, not an error to propagate.
    if (err.message.includes('404')) return null;
    throw err;
  }
}
