/**
 * Google Maps provider.
 *
 * FULLY IMPLEMENTED — not a stub. It becomes active automatically when the
 * server reports `mapProvider: "google"` from GET /api/config, which happens as
 * soon as GOOGLE_MAPS_API_KEY is set. No code change, no import change.
 *
 * Google's map does not repeat the world the way Leaflet's does, but the same
 * LA County limits are applied anyway so both providers behave identically:
 * restrictions.latLngBounds is Google's equivalent of maxBounds, and
 * strictBounds makes it a hard wall rather than a suggestion.
 */

import { MapProvider, popupHtml } from './mapProvider.js';

export class GoogleProvider extends MapProvider {
  constructor(config) {
    super();
    this.config = config;
    this.map = null;
    this.markers = new Map();
    this.infoWindow = null;
    this.clusterer = null;
  }

  async init(container, { center, zoom, bounds, minZoom, maxZoom }) {
    await loadGoogleMaps(this.config.googleMapsApiKey);

    const [[south, west], [north, east]] = bounds;

    this.map = new google.maps.Map(container, {
      center: { lat: center.lat, lng: center.lng },
      zoom,
      minZoom,
      maxZoom,
      // Google's equivalent of Leaflet's maxBounds + maxBoundsViscosity.
      restriction: {
        latLngBounds: { south, west, north, east },
        strictBounds: true,
      },
      mapTypeControl: false,
      streetViewControl: false,
      fullscreenControl: true,
      clickableIcons: false,
    });

    this.infoWindow = new google.maps.InfoWindow();
  }

  addPin(restaurant, { onClick } = {}) {
    if (!this.map || !restaurant?.position) return;

    this.removePin(restaurant.id);

    const marker = new google.maps.Marker({
      position: { lat: restaurant.position.lat, lng: restaurant.position.lng },
      map: this.map,
      title: restaurant.name,
    });

    marker.addListener('click', () => {
      this.infoWindow.setContent(popupHtml(restaurant));
      this.infoWindow.open({ anchor: marker, map: this.map });
      if (onClick) onClick(restaurant);
    });

    this.markers.set(restaurant.id, marker);
  }

  removePin(restaurantId) {
    const marker = this.markers.get(restaurantId);
    if (!marker) return;
    marker.setMap(null);
    this.markers.delete(restaurantId);
  }

  clearPins() {
    for (const marker of this.markers.values()) marker.setMap(null);
    this.markers.clear();
  }

  /**
   * @param {boolean} [options.animate] panTo eases; setCenter jumps. Same
   *   contract as the Leaflet provider — see the note there on why load-time
   *   positioning must not animate.
   */
  setCenter(lat, lng, zoom, { animate = true } = {}) {
    if (!this.map) return;

    if (animate) this.map.panTo({ lat, lng });
    else this.map.setCenter({ lat, lng });

    if (zoom) this.map.setZoom(zoom);
  }

  fitPins() {
    if (!this.map || this.markers.size === 0) return;

    const bounds = new google.maps.LatLngBounds();
    for (const marker of this.markers.values()) bounds.extend(marker.getPosition());
    this.map.fitBounds(bounds, 48);
  }

  highlightPin(restaurantId) {
    const marker = this.markers.get(restaurantId);
    if (!marker) return;

    this.map.panTo(marker.getPosition());
    google.maps.event.trigger(marker, 'click');
  }

  destroy() {
    this.clearPins();
    this.map = null;
    this.infoWindow = null;
  }
}

/** Inject the Maps JS API once and resolve when it is ready. */
let googleLoader = null;

function loadGoogleMaps(apiKey) {
  if (window.google?.maps) return Promise.resolve();
  if (googleLoader) return googleLoader;

  googleLoader = new Promise((resolve, reject) => {
    if (!apiKey) {
      reject(new Error('Google Maps selected but no API key was provided by the server'));
      return;
    }

    const callbackName = `__foodMapGoogleReady_${Date.now()}`;
    window[callbackName] = () => {
      delete window[callbackName];
      resolve();
    };

    const script = document.createElement('script');
    script.src =
      `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(apiKey)}` +
      `&callback=${callbackName}&loading=async`;
    script.async = true;
    script.onerror = () => reject(new Error('Failed to load the Google Maps script'));
    document.head.appendChild(script);
  });

  return googleLoader;
}
