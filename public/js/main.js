/**
 * Application entry point.
 *
 * Wires the pieces together and owns the small amount of shared state. Kept
 * deliberately plain: ES modules, no framework, no build step.
 */

import { api, ApiError } from './api.js';
import { initAuth, signIn, signUp, signOut, isSignedIn, getMode } from './auth.js';
import { LeafletProvider } from './map/leafletProvider.js';
import { GoogleProvider } from './map/googleProvider.js';
import { resultRow, detailHtml } from './ui/restaurantCard.js';

const state = {
  config: null,
  map: null, // the MapProvider instance
  maps: [], // the user's maps
  currentMapId: null,
  pins: [], // restaurants on the current map
  selected: null,
  searchAbort: null,
  authMode: 'signin',
};

const el = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function boot() {
  try {
    state.config = await api.config();
  } catch {
    document.body.innerHTML =
      '<p class="fatal">Could not reach the server. Is it running?</p>';
    return;
  }

  const { mode } = await initAuth(state.config);

  // In dev mode there is no real sign-in, so go straight to the app.
  if (isSignedIn() || mode === 'dev') {
    await startApp();
  } else {
    showAuthScreen();
  }
}

// ---------------------------------------------------------------------------
// Auth screen
// ---------------------------------------------------------------------------

function showAuthScreen() {
  el('auth-screen').hidden = false;
  el('app').hidden = true;

  el('auth-form').addEventListener('submit', onAuthSubmit);
  el('auth-switch-btn').addEventListener('click', toggleAuthMode);
}

function toggleAuthMode() {
  state.authMode = state.authMode === 'signin' ? 'signup' : 'signin';
  const signingIn = state.authMode === 'signin';

  el('auth-submit').textContent = signingIn ? 'Sign in' : 'Create account';
  el('auth-switch-text').textContent = signingIn ? 'New here?' : 'Already have an account?';
  el('auth-switch-btn').textContent = signingIn ? 'Create an account' : 'Sign in';
  el('auth-password').autocomplete = signingIn ? 'current-password' : 'new-password';
  hide('auth-error');
  hide('auth-notice');
}

async function onAuthSubmit(event) {
  event.preventDefault();
  hide('auth-error');
  hide('auth-notice');

  const email = el('auth-email').value.trim();
  const password = el('auth-password').value;
  const button = el('auth-submit');

  button.disabled = true;
  button.textContent = 'Please wait…';

  try {
    if (state.authMode === 'signup') {
      const { needsConfirmation } = await signUp(email, password);
      if (needsConfirmation) {
        show('auth-notice', 'Account created. Check your email to confirm, then sign in.');
        state.authMode = 'signin';
        toggleAuthMode();
        toggleAuthMode();
        return;
      }
    } else {
      await signIn(email, password);
    }

    el('auth-screen').hidden = true;
    await startApp();
  } catch (err) {
    show('auth-error', err.message);
  } finally {
    button.disabled = false;
    button.textContent = state.authMode === 'signin' ? 'Sign in' : 'Create account';
  }
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

async function startApp() {
  el('auth-screen').hidden = true;
  el('app').hidden = false;

  if (getMode() === 'dev') {
    showBanner(
      'Local development mode — no Supabase configured, so anyone can act as any user. ' +
        'See README for connecting a real project.'
    );
  }

  const me = await api.me();
  state.maps = me.maps;
  state.currentMapId = me.maps[0]?.id ?? null;

  renderMapSelect();
  await initMap();
  await loadCurrentMap();

  bindAppEvents();
}

/** Create whichever map provider the server selected. */
async function initMap() {
  const ProviderClass = state.config.mapProvider === 'google' ? GoogleProvider : LeafletProvider;
  state.map = new ProviderClass(state.config);

  const current = currentMap();

  await state.map.init(el('map'), {
    center: {
      lat: current?.center_lat ?? state.config.defaultCenter.lat,
      lng: current?.center_lng ?? state.config.defaultCenter.lng,
    },
    zoom: current?.zoom ?? state.config.defaultZoom,
    // These bounds are what stop the map repeating infinitely when zoomed out.
    bounds: state.config.bounds,
    minZoom: state.config.minZoom,
    maxZoom: state.config.maxZoom,
  });

  el('map-loading').hidden = true;

  // Debugging handle, dev mode only. Lets you poke at the map from the console
  // (window.foodMap.map.map for the raw Leaflet instance) while extending the
  // app. Never exposed once a real Supabase project is configured.
  if (getMode() === 'dev') {
    window.foodMap = state;
  }
}

function currentMap() {
  return state.maps.find((m) => m.id === state.currentMapId) ?? null;
}

async function loadCurrentMap() {
  if (!state.currentMapId) return;

  const { map, restaurants } = await api.getMap(state.currentMapId);
  state.pins = restaurants;

  // Keep the local copy in step, e.g. after re-centering.
  const index = state.maps.findIndex((m) => m.id === map.id);
  if (index !== -1) state.maps[index] = { ...state.maps[index], ...map };

  renderPins();

  // Positioning on load is instant, not animated — the user did not ask for a
  // camera move, and an animated one is dropped entirely if the tab happens to
  // be in the background. See setCenter() in leafletProvider.js.
  if (map.center_lat && map.center_lng) {
    state.map.setCenter(map.center_lat, map.center_lng, map.zoom, { animate: false });
  }
  if (restaurants.length > 0) state.map.fitPins({ animate: false });
}

function renderPins() {
  state.map.clearPins();
  for (const restaurant of state.pins) {
    state.map.addPin(restaurant, { onClick: openDetail });
  }

  const list = el('pin-list');
  list.innerHTML = '';
  el('pin-count').textContent = String(state.pins.length);

  if (state.pins.length === 0) {
    list.innerHTML =
      '<p class="empty">No restaurants yet. Search above and press Add to start building your map.</p>';
    return;
  }

  for (const restaurant of state.pins) {
    list.appendChild(
      resultRow(restaurant, {
        action: 'remove',
        onAction: removeFromMap,
        onSelect: (r) => {
          state.map.highlightPin(r.id);
          openDetail(r);
        },
      })
    );
  }
}

function renderMapSelect() {
  const select = el('map-select');
  select.innerHTML = state.maps
    .map(
      (m) =>
        `<option value="${m.id}" ${m.id === state.currentMapId ? 'selected' : ''}>${escapeAttr(m.name)}</option>`
    )
    .join('');
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

let searchTimer = null;

function onSearchInput(event) {
  const term = event.target.value.trim();
  clearTimeout(searchTimer);

  if (term.length < 2) {
    el('search-results').hidden = true;
    return;
  }

  // Debounce so a fast typist does not fire a request per keystroke.
  searchTimer = setTimeout(() => runSearch(term), 250);
}

async function runSearch(term) {
  // Cancel any in-flight search so results cannot arrive out of order.
  state.searchAbort?.abort();
  state.searchAbort = new AbortController();

  const map = currentMap();
  const container = el('search-results');
  container.hidden = false;
  container.innerHTML = '<p class="empty">Searching…</p>';

  try {
    const { restaurants } = await api.searchRestaurants(
      {
        q: term,
        lat: map?.center_lat ?? undefined,
        lng: map?.center_lng ?? undefined,
        radius: 50000,
        limit: 15,
        excludeMapId: state.currentMapId,
      },
      state.searchAbort.signal
    );

    container.innerHTML = '';

    if (restaurants.length === 0) {
      container.innerHTML =
        '<p class="empty">Nothing found. Try fewer words, or add it manually below.</p>';
      return;
    }

    for (const restaurant of restaurants) {
      container.appendChild(
        resultRow(restaurant, { action: 'add', onAction: addToMap, onSelect: openDetail })
      );
    }
  } catch (err) {
    if (err.name === 'AbortError') return;
    container.innerHTML = `<p class="empty">${escapeAttr(err.message)}</p>`;
  }
}

// ---------------------------------------------------------------------------
// Pins
// ---------------------------------------------------------------------------

async function addToMap(restaurant) {
  try {
    await api.addToMap(state.currentMapId, restaurant.id);
    toast(`Added ${restaurant.name}`);

    el('search-input').value = '';
    el('search-results').hidden = true;

    await loadCurrentMap();
    state.map.highlightPin(restaurant.id);
  } catch (err) {
    toast(err instanceof ApiError ? err.message : 'Could not add that restaurant', true);
  }
}

async function removeFromMap(restaurant) {
  try {
    await api.removeFromMap(state.currentMapId, restaurant.id);
    toast(`Removed ${restaurant.name}`);
    closeDetail();
    await loadCurrentMap();
  } catch (err) {
    toast(err.message, true);
  }
}

// ---------------------------------------------------------------------------
// Detail panel
// ---------------------------------------------------------------------------

async function openDetail(restaurant) {
  // Re-fetch so the panel shows the freshest rating and any enrichment that
  // landed since the list was rendered.
  let full = restaurant;
  try {
    const response = await api.getRestaurant(restaurant.id);
    full = response.restaurant;
  } catch {
    // Fall back to what the list already has.
  }

  state.selected = full;

  const panel = el('detail');
  panel.innerHTML = detailHtml(full, { canEdit: state.pins.some((p) => p.id === full.id) });
  panel.hidden = false;
  el('detail-backdrop').hidden = false;

  panel.querySelector('.detail-close')?.addEventListener('click', closeDetail);
  panel.querySelector('.detail-remove')?.addEventListener('click', () => removeFromMap(full));

  let pendingStars = full.yourRating?.stars ?? 0;
  let pendingPrice = full.yourRating?.priceLevel ?? null;

  panel.querySelectorAll('.star-btn').forEach((button) => {
    button.addEventListener('click', () => {
      pendingStars = Number(button.dataset.stars);
      panel.querySelectorAll('.star-btn').forEach((b) => {
        b.classList.toggle('star-on', Number(b.dataset.stars) <= pendingStars);
      });
    });
  });

  panel.querySelectorAll('.price-btn').forEach((button) => {
    button.addEventListener('click', () => {
      pendingPrice = Number(button.dataset.price);
      panel.querySelectorAll('.price-btn').forEach((b) => {
        b.classList.toggle('price-on', Number(b.dataset.price) === pendingPrice);
      });
    });
  });

  panel.querySelector('#save-rating')?.addEventListener('click', async () => {
    if (!pendingStars) {
      toast('Pick a star rating first', true);
      return;
    }
    try {
      await api.rate(full.id, {
        stars: pendingStars,
        priceLevel: pendingPrice,
        comment: panel.querySelector('#rating-comment')?.value || null,
      });
      toast('Rating saved');
      await loadCurrentMap();
      await openDetail(full);
    } catch (err) {
      toast(err.message, true);
    }
  });

  panel.querySelector('#clear-rating')?.addEventListener('click', async () => {
    try {
      await api.unrate(full.id);
      toast('Rating removed');
      await loadCurrentMap();
      await openDetail(full);
    } catch (err) {
      toast(err.message, true);
    }
  });
}

function closeDetail() {
  el('detail').hidden = true;
  el('detail-backdrop').hidden = true;
  state.selected = null;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

function bindAppEvents() {
  el('search-input').addEventListener('input', onSearchInput);
  el('detail-backdrop').addEventListener('click', closeDetail);

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeDetail();
  });

  // Re-centre the map by ADDRESS. No coordinates in the interface.
  el('center-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const address = el('center-input').value.trim();
    if (!address) return;

    try {
      const { map, geocoding } = await api.setMapCenter(state.currentMapId, address);
      state.map.setCenter(map.center_lat, map.center_lng, 15);

      const index = state.maps.findIndex((m) => m.id === map.id);
      if (index !== -1) state.maps[index] = { ...state.maps[index], ...map };

      toast(
        geocoding.confidence === 'approximate'
          ? `Centered near ${map.center_address} (approximate)`
          : `Centered on ${map.center_address}`
      );
      el('center-input').value = '';
    } catch (err) {
      toast(err.message, true);
    }
  });

  el('map-select').addEventListener('change', async (event) => {
    state.currentMapId = event.target.value;
    closeDetail();
    await loadCurrentMap();
  });

  el('new-map-btn').addEventListener('click', async () => {
    const name = prompt('Name your new map:');
    if (!name?.trim()) return;

    try {
      const { map } = await api.createMap(name.trim());
      state.maps.push(map);
      state.currentMapId = map.id;
      renderMapSelect();
      await loadCurrentMap();
      toast(`Created "${map.name}"`);
    } catch (err) {
      toast(err.message, true);
    }
  });

  el('sign-out-btn').addEventListener('click', async () => {
    await signOut();
    location.reload();
  });

  // --- manual add ---
  const dialog = el('custom-dialog');
  el('add-custom-btn').addEventListener('click', () => {
    hide('custom-error');
    dialog.showModal();
  });
  el('custom-cancel').addEventListener('click', () => dialog.close());

  el('custom-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    hide('custom-error');

    const details = {
      name: el('custom-name').value.trim(),
      address: el('custom-address').value.trim(),
      cuisines: el('custom-cuisines')
        .value.split(',')
        .map((c) => c.trim().toLowerCase())
        .filter(Boolean),
      website: el('custom-website').value.trim() || undefined,
    };

    try {
      const { restaurant } = await api.addCustomRestaurant(state.currentMapId, details);
      dialog.close();
      el('custom-form').reset();
      toast(`Added ${restaurant.name}`);
      await loadCurrentMap();
      state.map.highlightPin(restaurant.id);
    } catch (err) {
      show('custom-error', err.firstFieldError ?? err.message);
    }
  });
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function show(id, message) {
  const node = el(id);
  node.textContent = message;
  node.hidden = false;
}

function hide(id) {
  el(id).hidden = true;
}

function showBanner(message) {
  const banner = el('banner');
  banner.textContent = message;
  banner.hidden = false;
}

let toastTimer = null;
function toast(message, isError = false) {
  const node = el('toast');
  node.textContent = message;
  node.className = `toast ${isError ? 'toast-error' : 'toast-ok'}`;
  node.hidden = false;

  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    node.hidden = true;
  }, 3200);
}

function escapeAttr(value) {
  return String(value ?? '').replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

boot();
