# Provider contracts

Everything that talks to an outside world sits behind one of these interfaces.
Swapping a provider is a configuration change, never a code change.

**To switch the whole app to Google: set `GOOGLE_MAPS_API_KEY` and redeploy.**
Nothing else. The Google providers are fully implemented, not stubs — they are
simply unreachable while the key is absent.

---

## Why this exists

Every API that carries real per-restaurant ratings, prices and photos is now
paid or card-gated. Yelp Fusion ended free access, Foursquare drops to 500 free
calls a month with ratings and photos billed from the first call, and
TripAdvisor requires a card on file. The free sources — OpenStreetMap, the US
Census geocoder — carry names, addresses and cuisines but no ratings, prices or
photos.

So the app resolves those fields from three layers, and the interfaces below are
what make swapping between them a one-line change rather than a rewrite.

---

## 1. Geocoding — `providers/geocoding/`

Turns a typed address into coordinates. Users never see or enter a latitude or
longitude; that is an internal detail.

```js
/**
 * @typedef {object} GeocodeResult
 * @property {number} lat
 * @property {number} lng
 * @property {string} formattedAddress  normalised address the provider matched
 * @property {string} provider          which implementation answered
 * @property {'exact'|'approximate'} confidence
 */

/**
 * @param {string} address
 * @returns {Promise<GeocodeResult|null>}  null when nothing matched
 */
export async function geocode(address) {}

/** Human-readable name, used in logs. */
export const name = 'census';

/** Whether this provider can run right now (e.g. has its key). */
export function isAvailable() {}
```

| Implementation | Cost | Key | Notes |
|---|---|---|---|
| `census.js` | free | none | US only, no rate limit, authoritative for US street addresses. Tried first. |
| `nominatim.js` | free | none | Global fallback. Hard limit of 1 request/second, requires an honest User-Agent. |
| `google.js` | paid | required | Best coverage and handles vague input ("the pizza place on Sunset"). Dormant without a key. |

`index.js` exports `geocode()`, which walks the providers in order and returns
the first hit. Set `GEOCODING_PROVIDER` to force one.

---

## 2. Enrichment — `services/enrichment/`

Fills in rating, price, photo and description for a restaurant.

```js
/**
 * @typedef {object} EnrichmentResult
 * @property {number|null} rating        0-5
 * @property {number|null} ratingCount
 * @property {number|null} priceLevel    1-4
 * @property {string|null} photoUrl
 * @property {string|null} description
 * @property {string} source             'website' | 'google'
 */

/**
 * @param {object} restaurant  row from the restaurants table
 * @returns {Promise<EnrichmentResult|null>}
 */
export async function enrich(restaurant) {}
```

| Implementation | What it reads |
|---|---|
| `structuredData.js` | The restaurant's **own website** — schema.org JSON-LD and Open Graph tags. This is machine-readable data the business publishes deliberately for search engines, not scraping of a third party. |
| `google.js` (in `providers/places/`) | Google Places API. Real ratings, prices and photos. Dormant without a key. |

`structuredData.js` is subject to `politeness.js`: it honours `robots.txt`,
identifies itself honestly, allows one in-flight request per domain with a
minimum gap between them, and backs off exponentially on failure. Those rules
are not decoration — keep them.

**Measured coverage** (see `scripts/measure-enrichment.js`): of the 13,191
OpenStreetMap restaurants in LA County, 47.7% have a website at all, which is
the hard ceiling on what this layer can ever reach.

---

## 3. Places — `providers/places/`

Searches for restaurants that are not already in the catalog.

```js
/**
 * @param {string} query
 * @param {{lat:number, lng:number, radiusMeters:number}} [near]
 * @returns {Promise<Array<RestaurantCandidate>>}
 */
export async function searchPlaces(query, near) {}

/** @returns {Promise<RestaurantCandidate|null>} */
export async function getPlaceDetails(externalId) {}
```

| Implementation | Notes |
|---|---|
| `osm.js` | Queries our own seeded Postgres. No quota, no rate limit, answers in milliseconds. The default. |
| `google.js` | Places API (New) `searchText` and `Place Details`. Wider coverage than OSM — which only has ~13k of LA County's ~30k+ food businesses — plus real ratings and photos. Costs money. |

---

## 4. Map rendering — `public/js/map/`

Browser-side. Same shape, different renderer.

```js
export class MapProvider {
  async init(container, { center, zoom, bounds, minZoom, maxZoom }) {}
  addPin(restaurant, { onClick }) {}
  removePin(restaurantId) {}
  clearPins() {}
  setCenter(lat, lng, zoom) {}
  fitBounds(pins) {}
  destroy() {}
}
```

| Implementation | Notes |
|---|---|
| `leafletProvider.js` | Leaflet with CARTO tiles. Free, no key. **Applies the LA County bounds as a hard wall** — `noWrap` on the tile layer stops the world repeating horizontally, `maxBoundsViscosity: 1.0` makes the edge solid rather than springy, and `minZoom` prevents zooming out to a repeated globe. |
| `googleProvider.js` | Google Maps JS API. Selected automatically when a key is present. |

The frontend fetches `GET /api/config` at startup and uses whichever provider
the server names, so changing `server/config.js` changes the frontend with no
frontend edit.

---

## Adding a new provider

1. Create the file in the right directory.
2. Implement the interface above, including `name` and `isAvailable()`.
3. Register it in that directory's `index.js`.
4. Add a config switch in `server/config.js`.

Do not add provider-specific branching anywhere else. If a caller needs to know
which provider answered, that belongs in the result object — every result
already carries a `source` or `provider` field for exactly this reason.
