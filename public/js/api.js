/**
 * API client.
 *
 * One place that knows how to talk to the backend: attaches the auth header,
 * parses the response, and turns the server's error shape into a thrown Error
 * with a message that is already fit to show a user.
 */

import { getAuthHeader } from './auth.js';

/** An API error carrying the HTTP status and any per-field detail. */
export class ApiError extends Error {
  constructor(message, status, details) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.details = details;
  }

  /** First field-level message, if the server sent one. */
  get firstFieldError() {
    const fields = this.details?.fields;
    if (!fields) return null;
    const [field, message] = Object.entries(fields)[0] ?? [];
    return field ? `${field}: ${message}` : null;
  }
}

async function request(path, { method = 'GET', body = null, signal } = {}) {
  const headers = { ...(await getAuthHeader()) };
  if (body) headers['Content-Type'] = 'application/json';

  let response;
  try {
    response = await fetch(path, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal,
    });
  } catch (err) {
    // An aborted request is a normal part of search-as-you-type, not a failure.
    if (err.name === 'AbortError') throw err;
    throw new ApiError('Could not reach the server. Check your connection.', 0);
  }

  if (response.status === 204) return null;

  const text = await response.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      throw new ApiError('The server sent an unreadable response.', response.status);
    }
  }

  if (!response.ok) {
    const error = payload?.error ?? {};
    throw new ApiError(
      error.message ?? `Request failed (${response.status})`,
      response.status,
      error.details
    );
  }

  return payload;
}

export const api = {
  config: () => request('/api/config'),
  me: () => request('/api/me'),

  createMap: (name) => request('/api/maps', { method: 'POST', body: { name } }),
  getMap: (id) => request(`/api/maps/${id}`),
  updateMap: (id, changes) => request(`/api/maps/${id}`, { method: 'PATCH', body: changes }),
  deleteMap: (id) => request(`/api/maps/${id}`, { method: 'DELETE' }),

  /** Move the map by ADDRESS. No coordinates are ever sent from the UI. */
  setMapCenter: (id, address) =>
    request(`/api/maps/${id}/center`, { method: 'PATCH', body: { address } }),

  searchRestaurants: ({ q, lat, lng, radius, limit, excludeMapId }, signal) => {
    const params = new URLSearchParams();
    if (q) params.set('q', q);
    if (lat !== undefined && lat !== null) params.set('lat', lat);
    if (lng !== undefined && lng !== null) params.set('lng', lng);
    if (radius) params.set('radius', radius);
    if (limit) params.set('limit', limit);
    if (excludeMapId) params.set('excludeMapId', excludeMapId);
    return request(`/api/restaurants/search?${params}`, { signal });
  },

  getRestaurant: (id) => request(`/api/restaurants/${id}`),

  addToMap: (mapId, restaurantId) =>
    request(`/api/maps/${mapId}/restaurants`, { method: 'POST', body: { restaurantId } }),

  addCustomRestaurant: (mapId, details) =>
    request(`/api/maps/${mapId}/restaurants/custom`, { method: 'POST', body: details }),

  removeFromMap: (mapId, restaurantId) =>
    request(`/api/maps/${mapId}/restaurants/${restaurantId}`, { method: 'DELETE' }),

  setNotes: (mapId, restaurantId, notes) =>
    request(`/api/maps/${mapId}/restaurants/${restaurantId}`, { method: 'PATCH', body: { notes } }),

  rate: (restaurantId, { stars, priceLevel, comment }) =>
    request(`/api/restaurants/${restaurantId}/rating`, {
      method: 'PUT',
      body: { stars, priceLevel: priceLevel ?? null, comment: comment ?? null },
    }),

  unrate: (restaurantId) => request(`/api/restaurants/${restaurantId}/rating`, { method: 'DELETE' }),

  getRatings: (restaurantId) => request(`/api/restaurants/${restaurantId}/ratings`),
};
