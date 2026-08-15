/**
 * Central configuration.
 *
 * EVERY tunable in this project lives here. If you want to change how the app
 * behaves — expand past LA County, add a cuisine, swap a map provider, tune the
 * enrichment crawler — you should be able to do it in this file alone.
 *
 * Values are read from the environment where they are secret or
 * deployment-specific, and hardcoded here where they are product decisions.
 */

const env = process.env;

/** Parse an env var as an integer, falling back to a default. */
function int(name, fallback) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n)) {
    throw new Error(`Environment variable ${name} must be an integer, got "${raw}"`);
  }
  return n;
}

/** Parse an env var as a boolean ("true"/"1" are true). */
function bool(name, fallback) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  return raw === 'true' || raw === '1';
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export const server = {
  port: int('PORT', 3000),
  // Render sets NODE_ENV=production automatically.
  isProduction: env.NODE_ENV === 'production',
  // Browsers allowed to call this API from a DIFFERENT origin.
  //
  // Same-origin requests are always permitted regardless of this list — see
  // corsDelegate() in index.js. This only matters if you want another site to
  // call your API.
  //
  // RENDER_EXTERNAL_URL is injected by Render with the service's real public
  // URL, so the deployed site is trusted automatically even when CORS_ORIGINS
  // is stale or was never updated from a placeholder.
  corsOrigins: [
    ...(env.CORS_ORIGINS ?? 'http://localhost:3000').split(','),
    env.RENDER_EXTERNAL_URL ?? '',
  ]
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter(Boolean),
};

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------
//
// If DATABASE_URL is set we connect to real Postgres (Supabase in production).
// If it is not set we fall back to PGlite — Postgres compiled to WebAssembly,
// running in-process with no install and no Docker. Same SQL, same drivers'
// query shape, so local development and production do not diverge.

export const database = {
  url: env.DATABASE_URL ?? null,
  // Where PGlite stores its files when DATABASE_URL is absent.
  // 'memory://' gives a throwaway database, used by the test suite.
  pgliteDir: env.PGLITE_DIR ?? './.data/pglite',
  poolMax: int('DB_POOL_MAX', 10),
  // Supabase's pooler terminates idle connections; keep ours below that.
  idleTimeoutMs: int('DB_IDLE_TIMEOUT_MS', 20_000),
  connectionTimeoutMs: int('DB_CONNECTION_TIMEOUT_MS', 10_000),
};

// ---------------------------------------------------------------------------
// Supabase (auth + file storage)
// ---------------------------------------------------------------------------

/**
 * Reduce a Supabase URL to its bare project origin.
 *
 * The dashboard shows several URLs for one project, and it is easy to copy the
 * Data API endpoint (`https://<ref>.supabase.co/rest/v1/`) instead of the
 * Project URL. The code appends its own paths — `/auth/v1/...`,
 * `/storage/v1/...` — so anything beyond the origin produces broken requests,
 * and even a bare trailing slash yields a double slash that breaks JWT issuer
 * matching.
 *
 * The intent is unambiguous in every one of those cases, so normalise rather
 * than fail a deploy over a paste error. Genuinely unusable values are still
 * rejected by validateConfig().
 *
 * @param {string|null|undefined} raw
 * @returns {{url: string|null, corrected: boolean}}
 */
export function normalizeSupabaseUrl(raw) {
  if (!raw) return { url: null, corrected: false };

  const trimmed = String(raw).trim();
  if (!trimmed) return { url: null, corrected: false };

  try {
    const parsed = new URL(trimmed);
    const origin = `${parsed.protocol}//${parsed.host}`;
    return { url: origin, corrected: origin !== trimmed.replace(/\/+$/, '') || trimmed !== origin };
  } catch {
    // Not parseable as a URL at all — hand it back untouched so validation can
    // report the actual value the user set.
    return { url: trimmed, corrected: false };
  }
}

const normalizedSupabase = normalizeSupabaseUrl(env.SUPABASE_URL);

if (normalizedSupabase.corrected) {
  console.warn(
    `[config] SUPABASE_URL was "${env.SUPABASE_URL}" — using "${normalizedSupabase.url}".\n` +
      '         Only the project origin is needed; the code adds /auth/v1 and\n' +
      '         /storage/v1 itself. Update the variable to silence this.'
  );
}

export const supabase = {
  url: normalizedSupabase.url,
  // Safe to expose to the browser — it only permits what row-level security allows.
  anonKey: env.SUPABASE_ANON_KEY ?? null,
  // NEVER expose this. Full database access, bypasses row-level security.
  serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY ?? null,
  storageBucket: env.SUPABASE_STORAGE_BUCKET ?? 'restaurant-photos',
  // Supabase edge-caches its JWKS for 10 minutes. Caching longer than that
  // would keep us trusting keys after a rotation or revocation.
  jwksCacheMs: int('JWKS_CACHE_MS', 10 * 60 * 1000),
};

// ---------------------------------------------------------------------------
// Geographic scope
// ---------------------------------------------------------------------------
//
// >>> TO EXPAND BEYOND LA COUNTY, EDIT THIS BLOCK. <<<
//
// These bounds are also what stop the map repeating infinitely when a user
// zooms out. The frontend reads them from GET /api/config, so changing them
// here changes the map's hard limits with no frontend edit.

export const geography = {
  /**
   * [[southLat, westLng], [northLat, eastLng]]
   *
   * Deliberately includes Santa Catalina and San Clemente islands, which are
   * legally part of LA County, so the southern edge sits well below the
   * mainland coast.
   */
  bounds: [
    [32.75, -118.95],
    [34.85, -117.6],
  ],
  /** Where a brand-new map starts: downtown LA. */
  defaultCenter: { lat: 34.0522, lng: -118.2437 },
  defaultZoom: 12,
  /** Zooming out past this would show the whole globe (and repeat it). */
  minZoom: 8,
  maxZoom: 19,
  /** Name used to scope the Overpass seed query. */
  osmAreaName: 'Los Angeles County',
  /** Default radius for "restaurants near me" searches. */
  defaultSearchRadiusMeters: int('DEFAULT_SEARCH_RADIUS_M', 5_000),
  maxSearchRadiusMeters: int('MAX_SEARCH_RADIUS_M', 50_000),
};

// ---------------------------------------------------------------------------
// Restaurant catalog / OSM seeding
// ---------------------------------------------------------------------------

export const catalog = {
  /**
   * Which OpenStreetMap amenity tags count as "a restaurant" for our purposes.
   * fast_food is included deliberately — a huge share of LA's taquerias, delis
   * and counter-service spots are tagged fast_food, not restaurant.
   */
  osmAmenities: ['restaurant', 'fast_food', 'cafe'],
  overpassUrl: env.OVERPASS_URL ?? 'https://overpass-api.de/api/interpreter',
  overpassTimeoutSeconds: int('OVERPASS_TIMEOUT_S', 180),
  /** Rows per INSERT batch when seeding. Larger is faster but uses more memory. */
  seedBatchSize: int('SEED_BATCH_SIZE', 500),
};

// ---------------------------------------------------------------------------
// Search ranking
// ---------------------------------------------------------------------------
//
// Tune these to change what "best match" means when a user searches to add a
// restaurant. Weights are relative; only their ratio matters.

export const search = {
  weights: {
    /** Fuzzy name similarity — catches typos like "chipolte". */
    nameTrigram: 3.0,
    /** Full-text match across name + address + cuisine. */
    fullText: 2.0,
    /** Closeness to the map's centre, when a location is supplied. */
    proximity: 1.5,
  },
  /** Below this trigram score, a result is considered irrelevant. */
  minSimilarity: 0.15,
  defaultLimit: int('SEARCH_DEFAULT_LIMIT', 20),
  maxLimit: int('SEARCH_MAX_LIMIT', 50),
};

// ---------------------------------------------------------------------------
// Provider selection
// ---------------------------------------------------------------------------
//
// >>> TO SWITCH TO GOOGLE, SET GOOGLE_MAPS_API_KEY AND REDEPLOY. <<<
//
// The Google providers are fully implemented, not stubs. They are simply
// unreachable while the key is absent. No code changes are needed to enable
// them — `googleEnabled` below flips automatically.

export const providers = {
  googleApiKey: env.GOOGLE_MAPS_API_KEY ?? null,
  get googleEnabled() {
    return Boolean(this.googleApiKey);
  },

  /** 'census' | 'nominatim' | 'google' — or 'auto' to try them in order. */
  geocoding: env.GEOCODING_PROVIDER ?? 'auto',

  /** 'leaflet' | 'google' — sent to the browser via GET /api/config. */
  map: env.MAP_PROVIDER ?? (env.GOOGLE_MAPS_API_KEY ? 'google' : 'leaflet'),

  /**
   * Basemap tiles for Leaflet. CARTO's Voyager style is clean and legible.
   * Swapping map styles is a one-line change here.
   */
  tileUrl:
    env.TILE_URL ?? 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png',
  tileAttribution:
    '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
};

// ---------------------------------------------------------------------------
// Enrichment crawler
// ---------------------------------------------------------------------------
//
// Fetches a restaurant's OWN website and reads the structured data it publishes
// for search engines (schema.org JSON-LD, Open Graph). This is not scraping a
// third party — it is reading machine-readable data a business chose to publish.
// The politeness settings below are not optional decoration; keep them honest.

export const enrichment = {
  enabled: bool('ENRICHMENT_ENABLED', true),
  /** How often the worker looks for pending jobs. */
  pollIntervalMs: int('ENRICH_POLL_INTERVAL_MS', 15_000),
  /** How many websites we fetch at once, across all domains. */
  concurrency: int('ENRICH_CONCURRENCY', 3),
  jobsPerTick: int('ENRICH_JOBS_PER_TICK', 10),
  /** Don't re-fetch a restaurant we already enriched within this window. */
  refreshAfterDays: int('ENRICH_REFRESH_DAYS', 30),

  requestTimeoutMs: int('ENRICH_TIMEOUT_MS', 8_000),
  maxResponseBytes: int('ENRICH_MAX_BYTES', 2 * 1024 * 1024),
  maxRedirects: int('ENRICH_MAX_REDIRECTS', 3),

  /** Identifies our crawler honestly, with a link explaining what it is. */
  userAgent:
    env.ENRICH_USER_AGENT ??
    'FoodMapBot/1.0 (+https://github.com/MikailH06/Food_Map; restaurant map enrichment)',
  /** Minimum gap between two requests to the same host. */
  perDomainDelayMs: int('ENRICH_DOMAIN_DELAY_MS', 1_000),
  /** Give up after this many failures, with exponential backoff between tries. */
  maxAttempts: int('ENRICH_MAX_ATTEMPTS', 3),
  backoffBaseMs: int('ENRICH_BACKOFF_BASE_MS', 60_000),

  /** schema.org types we accept as describing a restaurant. */
  acceptedSchemaTypes: [
    'Restaurant',
    'FoodEstablishment',
    'CafeOrCoffeeShop',
    'BarOrPub',
    'FastFoodRestaurant',
    'BakeryShop',
    'Bakery',
    'IceCreamShop',
    'LocalBusiness',
  ],

  /**
   * Download discovered images into Supabase Storage instead of hotlinking.
   * Off by default: the free tier is 1GB and fills faster than you'd expect.
   */
  rehostPhotos: bool('REHOST_PHOTOS', false),
};

// ---------------------------------------------------------------------------
// Ratings and price
// ---------------------------------------------------------------------------

export const ratings = {
  minStars: 1,
  maxStars: 5,
  /** Price tiers, 1-4, rendered as $ through $$$$. */
  minPriceLevel: 1,
  maxPriceLevel: 4,
  maxCommentLength: 1_000,
  /**
   * Upper bound in USD for a typical main course at each price level. Used to
   * turn a schema.org priceRange like "$15 - $30" into a 1-4 tier.
   */
  priceLevelThresholdsUsd: [15, 30, 60, Infinity],
};

// ---------------------------------------------------------------------------
// Photo uploads
// ---------------------------------------------------------------------------

export const photos = {
  maxBytes: int('PHOTO_MAX_BYTES', 5 * 1024 * 1024),
  allowedMimeTypes: ['image/jpeg', 'image/png', 'image/webp'],
  maxPerRestaurantPerUser: int('PHOTO_MAX_PER_USER', 5),
};

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

export const rateLimits = {
  windowMs: int('RATE_LIMIT_WINDOW_MS', 15 * 60 * 1000),
  readMax: int('RATE_LIMIT_READ_MAX', 300),
  writeMax: int('RATE_LIMIT_WRITE_MAX', 60),
  searchMax: int('RATE_LIMIT_SEARCH_MAX', 120),
};

// ---------------------------------------------------------------------------
// Startup validation
// ---------------------------------------------------------------------------

/**
 * Fail loudly at boot rather than mysteriously at request time.
 *
 * Only production requires the Supabase settings: local development runs
 * against PGlite with auth disabled, so you can build and test the whole
 * backend before creating any cloud account.
 */
export function validateConfig({ requireSupabase = server.isProduction } = {}) {
  const problems = [];

  if (requireSupabase) {
    if (!supabase.url) problems.push('SUPABASE_URL is required in production');
    if (!supabase.anonKey) problems.push('SUPABASE_ANON_KEY is required in production');
    if (!database.url) problems.push('DATABASE_URL is required in production');
  }

  if (supabase.url && !/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(supabase.url)) {
    problems.push(
      `SUPABASE_URL is not a Supabase project URL.\n` +
        `      got:      ${env.SUPABASE_URL}\n` +
        `      expected: https://<your-project-ref>.supabase.co\n` +
        `      Find it in the Supabase dashboard under Settings -> API,\n` +
        `      labelled "Project URL". Do not use the Data API endpoint that\n` +
        `      ends in /rest/v1/.`
    );
  }

  if (server.isProduction && server.corsOrigins.some((o) => o.includes('localhost'))) {
    problems.push('CORS_ORIGINS still contains localhost in production');
  }

  if (problems.length > 0) {
    throw new Error(`Configuration errors:\n  - ${problems.join('\n  - ')}`);
  }
}

/** Everything the browser is allowed to know. Served by GET /api/config. */
export function publicConfig() {
  return {
    supabaseUrl: supabase.url,
    supabaseAnonKey: supabase.anonKey,
    mapProvider: providers.map,
    googleMapsApiKey: providers.googleEnabled ? providers.googleApiKey : null,
    tileUrl: providers.tileUrl,
    tileAttribution: providers.tileAttribution,
    bounds: geography.bounds,
    defaultCenter: geography.defaultCenter,
    defaultZoom: geography.defaultZoom,
    minZoom: geography.minZoom,
    maxZoom: geography.maxZoom,
    priceLevels: { min: ratings.minPriceLevel, max: ratings.maxPriceLevel },
    stars: { min: ratings.minStars, max: ratings.maxStars },
  };
}

export default {
  server,
  database,
  supabase,
  geography,
  catalog,
  search,
  providers,
  enrichment,
  ratings,
  photos,
  rateLimits,
  validateConfig,
  publicConfig,
};
