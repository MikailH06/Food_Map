/**
 * Leaflet map provider.
 *
 * ---------------------------------------------------------------------------
 * THE INFINITE-MAP FIX
 * ---------------------------------------------------------------------------
 * By default a Leaflet map repeats the world horizontally forever as you pan or
 * zoom out, and pins exist only in one copy — so scroll sideways and your
 * restaurants vanish onto a blank duplicate Earth. Four settings prevent that,
 * and all four are needed:
 *
 *   noWrap: true              on the TILE LAYER — stops tiles repeating
 *                             horizontally. Without it the basemap tiles keep
 *                             drawing new copies of the world.
 *
 *   maxBounds                 restricts panning to LA County.
 *
 *   maxBoundsViscosity: 1.0   makes that boundary a solid wall. At the default
 *                             of 0.0 the bounds are springy: you can still drag
 *                             well outside and get snapped back, which both
 *                             looks broken and briefly shows the empty repeat.
 *
 *   minZoom                   stops zooming out far enough to see the whole
 *                             globe, where repetition is unavoidable.
 *
 * The bounds themselves come from the server (server/config.js), so expanding
 * beyond LA County is one edit there with no change to this file.
 */

import { MapProvider, popupHtml } from './mapProvider.js';

export class LeafletProvider extends MapProvider {
  constructor(config) {
    super();
    this.config = config;
    this.map = null;
    this.cluster = null;
    this.markers = new Map();
  }

  async init(container, { center, zoom, bounds, minZoom, maxZoom }) {
    // Leaflet loads from a CDN with `defer`, so it may not be ready yet.
    await waitForGlobal('L');

    const latLngBounds = L.latLngBounds(bounds[0], bounds[1]);

    this.map = L.map(container, {
      center: [center.lat, center.lng],
      zoom,
      minZoom,
      maxZoom,

      // --- the fix (see the file header) ---
      maxBounds: latLngBounds,
      maxBoundsViscosity: 1.0,
      worldCopyJump: false,

      zoomControl: true,
      attributionControl: true,
    });

    L.tileLayer(this.config.tileUrl, {
      attribution: this.config.tileAttribution,
      // Without this the basemap still repeats even though panning is bounded.
      noWrap: true,
      bounds: latLngBounds,
      minZoom,
      maxZoom,
    }).addTo(this.map);

    // A map can hold hundreds of pins; unclustered they become an unreadable
    // pile of overlapping markers.
    this.cluster = L.markerClusterGroup({
      showCoverageOnHover: false,
      maxClusterRadius: 50,
      spiderfyOnMaxZoom: true,
      disableClusteringAtZoom: 17,
    });
    this.map.addLayer(this.cluster);

    // Belt and braces: if anything ever does drift outside the county, pull it
    // straight back rather than leaving the user stranded on empty tiles.
    this.map.on('drag', () => {
      this.map.panInsideBounds(latLngBounds, { animate: false });
    });
  }

  addPin(restaurant, { onClick } = {}) {
    if (!this.map || !restaurant?.position) return;

    this.removePin(restaurant.id);

    const marker = L.marker([restaurant.position.lat, restaurant.position.lng], {
      title: restaurant.name,
      alt: restaurant.name,
    });

    marker.bindPopup(popupHtml(restaurant), { maxWidth: 260 });
    if (onClick) marker.on('click', () => onClick(restaurant));

    this.cluster.addLayer(marker);
    this.markers.set(restaurant.id, marker);
  }

  removePin(restaurantId) {
    const marker = this.markers.get(restaurantId);
    if (!marker) return;
    this.cluster.removeLayer(marker);
    this.markers.delete(restaurantId);
  }

  clearPins() {
    this.cluster?.clearLayers();
    this.markers.clear();
  }

  /**
   * @param {boolean} [options.animate] Animate the transition. Pass false for
   *   view changes the user did not initiate.
   *
   *   This is not only cosmetic. Leaflet's animated transitions run on
   *   requestAnimationFrame, which browsers do not fire in a backgrounded or
   *   non-rendering tab. An animated setView issued while the tab is hidden is
   *   silently dropped — so a map opened in a background tab would stay at the
   *   default location instead of where it was saved. Positioning on load is
   *   therefore instant, which is also the better look: jumping straight to the
   *   right place beats gliding there from an arbitrary default.
   */
  setCenter(lat, lng, zoom, { animate = true } = {}) {
    this.map?.setView([lat, lng], zoom ?? this.map.getZoom(), { animate });
  }

  fitPins({ animate = true } = {}) {
    if (!this.map || this.markers.size === 0) return;

    const group = L.featureGroup([...this.markers.values()]);
    this.map.fitBounds(group.getBounds(), { padding: [48, 48], maxZoom: 16, animate });
  }

  highlightPin(restaurantId) {
    const marker = this.markers.get(restaurantId);
    if (!marker) return;

    // zoomToShowLayer expands the enclosing cluster first, so a pin hidden
    // inside a cluster still opens rather than silently doing nothing.
    if (this.cluster.hasLayer(marker)) {
      this.cluster.zoomToShowLayer(marker, () => marker.openPopup());
    } else {
      marker.openPopup();
    }
  }

  invalidateSize() {
    this.map?.invalidateSize();
  }

  destroy() {
    this.map?.remove();
    this.map = null;
    this.cluster = null;
    this.markers.clear();
  }
}

/** Wait for a CDN script that was loaded with `defer` to define its global. */
function waitForGlobal(name, timeoutMs = 10_000) {
  if (window[name]) return Promise.resolve();

  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const check = () => {
      if (window[name]) return resolve();
      if (Date.now() - startedAt > timeoutMs) {
        return reject(new Error(`${name} failed to load — check your network connection`));
      }
      setTimeout(check, 50);
    };
    check();
  });
}
