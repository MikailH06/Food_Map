/**
 * Map provider interface.
 *
 * Both implementations satisfy this exact shape, so main.js never knows or
 * cares which renderer is active. The server decides via GET /api/config, which
 * reads server/config.js — so switching the whole app to Google Maps is an
 * environment variable, not a code change.
 *
 * Implementations:
 *   leafletProvider.js  Leaflet + CARTO tiles. Free, no key. The default.
 *   googleProvider.js   Google Maps JS API. Selected when a key is configured.
 */

export class MapProvider {
  /**
   * @param {HTMLElement} container
   * @param {object} options
   * @param {{lat: number, lng: number}} options.center
   * @param {number} options.zoom
   * @param {[[number, number], [number, number]]} options.bounds
   *        [[southLat, westLng], [northLat, eastLng]] — a HARD limit, not a hint
   * @param {number} options.minZoom
   * @param {number} options.maxZoom
   * @returns {Promise<void>}
   */
  async init() {
    throw new Error('init() must be implemented');
  }

  /**
   * Add or replace a pin.
   * @param {object} restaurant  a resolved restaurant from the API
   * @param {{onClick: (restaurant: object) => void}} handlers
   */
  addPin() {
    throw new Error('addPin() must be implemented');
  }

  /** @param {string} restaurantId */
  removePin() {
    throw new Error('removePin() must be implemented');
  }

  clearPins() {
    throw new Error('clearPins() must be implemented');
  }

  /**
   * @param {number} lat
   * @param {number} lng
   * @param {number} [zoom]
   * @param {{animate?: boolean}} [options] Pass `animate: false` for any view
   *   change the user did not initiate — animated transitions are driven by
   *   requestAnimationFrame, which does not run in a backgrounded tab, so an
   *   animated move issued on load can be silently dropped.
   */
  setCenter() {
    throw new Error('setCenter() must be implemented');
  }

  /**
   * Zoom to fit every current pin. No-op when there are none.
   * @param {{animate?: boolean}} [options]
   */
  fitPins() {
    throw new Error('fitPins() must be implemented');
  }

  /** Briefly draw attention to one pin, e.g. when picked from the list. */
  highlightPin() {
    throw new Error('highlightPin() must be implemented');
  }

  /** Recompute size after the container changes shape. */
  invalidateSize() {}

  destroy() {}
}

/**
 * Escape text for safe insertion into HTML.
 *
 * Restaurant names and descriptions come from OpenStreetMap and from scraped
 * websites — neither is trustworthy, and both end up inside popup markup.
 */
export function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Small shared popup summary, so both providers show the same thing. */
export function popupHtml(restaurant) {
  const rating = restaurant.rating
    ? `<div class="popup-rating">★ ${restaurant.rating.value.toFixed(1)}
         <span class="popup-source">${escapeHtml(sourceLabel(restaurant.rating.source))}</span>
       </div>`
    : '<div class="popup-rating popup-unrated">Not rated yet</div>';

  const price = restaurant.price ? `<span class="popup-price">${restaurant.price.symbols}</span>` : '';

  return `
    <div class="popup">
      <div class="popup-title">${escapeHtml(restaurant.name)}</div>
      <div class="popup-address">${escapeHtml(restaurant.address.full ?? '')}</div>
      <div class="popup-meta">${rating}${price}</div>
    </div>
  `;
}

/** Human wording for a resolver layer. */
export function sourceLabel(source) {
  switch (source) {
    case 'google':
      return 'Google';
    case 'website':
      return "from the restaurant's site";
    case 'community':
      return 'from Food Map users';
    default:
      return '';
  }
}
