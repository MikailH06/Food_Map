/**
 * Application entry point.
 *
 * Wires up middleware, mounts routes, serves the frontend, and shuts down
 * cleanly. Deliberately thin — the interesting logic lives in routes/ and
 * services/, and every tunable lives in config.js.
 */

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';

import { server as serverConfig, rateLimits, validateConfig } from './config.js';
import * as db from './db/pool.js';
import { notFoundHandler, errorHandler } from './middleware/errors.js';
import { attachUser, devAuthEnabled } from './middleware/auth.js';
import healthRoutes from './routes/health.js';
import mapRoutes from './routes/maps.js';
import restaurantRoutes from './routes/restaurants.js';
import ratingRoutes from './routes/ratings.js';
import photoRoutes from './routes/photos.js';
import { startWorker, stopWorker } from './services/enrichment/worker.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, '..', 'public');

/**
 * Decide whether a cross-origin request is permitted.
 *
 * Two rules beyond the configured allowlist, both learned the hard way:
 *
 *   1. A request whose Origin matches the host it is being sent to is
 *      same-origin and is ALWAYS allowed. The site must never be able to lock
 *      itself out because CORS_ORIGINS was left stale — that is a configuration
 *      mistake, not an attack, and browsers enforce same-origin policy anyway.
 *
 *   2. A disallowed origin is refused by simply not emitting CORS headers,
 *      which is what the browser looks for. The previous code passed an Error
 *      to the callback, which surfaced as an opaque HTTP 500 rather than a
 *      clean refusal.
 */
export function corsDelegate(req, callback) {
  const origin = req.header('Origin');

  // No Origin means a same-origin navigation or a server-to-server call.
  if (!origin) return callback(null, { origin: true, credentials: true });

  let originHost = null;
  try {
    originHost = new URL(origin).host;
  } catch {
    // Unparseable Origin — treat as untrusted.
  }

  const isSameOrigin = originHost !== null && originHost === req.headers.host;
  const isAllowed = isSameOrigin || serverConfig.corsOrigins.includes(origin);

  callback(null, isAllowed ? { origin: true, credentials: true } : { origin: false });
}

export function createApp() {
  const app = express();

  // Render terminates TLS upstream, so trust its proxy header. Without this,
  // rate limiting would see every request as coming from one IP.
  app.set('trust proxy', 1);

  app.use(
    helmet({
      // The frontend loads Leaflet and its tiles from CDNs, so the default
      // same-origin policy is too strict. Everything permitted here is either
      // our own origin or an explicitly named map/tile host.
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'", 'https://unpkg.com', 'https://cdn.jsdelivr.net'],
          styleSrc: ["'self'", "'unsafe-inline'", 'https://unpkg.com', 'https://cdn.jsdelivr.net'],
          // Restaurant photos come from arbitrary restaurant websites, so image
          // sources cannot be enumerated in advance.
          imgSrc: ["'self'", 'data:', 'https:'],
          connectSrc: ["'self'", 'https://*.supabase.co', 'https://*.basemaps.cartocdn.com'],
          fontSrc: ["'self'", 'https://unpkg.com', 'data:'],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"],
        },
      },
      // Cross-origin isolation would block the CDN-hosted tile images.
      crossOriginEmbedderPolicy: false,
    })
  );

  app.use(express.json({ limit: '1mb' }));

  // CORS guards the API only, and is mounted before any /api route so that
  // every one of them is covered — including /api/config, which lives in
  // healthRoutes below.
  //
  // It deliberately does NOT wrap the static files or the HTML page. Browsers
  // send an Origin header when fetching a module script, so gating static
  // assets on the allowlist meant that a stale CORS_ORIGINS did not merely
  // block other sites — it stopped the app loading its own JavaScript and
  // served a blank page. Which is exactly what happened on the first deploy.
  app.use('/api', cors(corsDelegate));

  // Health must be reachable without hitting a rate limit — the keep-alive cron
  // polls it continuously, and throttling it would defeat its purpose.
  app.use(healthRoutes);

  app.use(
    '/api',
    rateLimit({
      windowMs: rateLimits.windowMs,
      max: rateLimits.readMax,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      message: { error: { message: 'Too many requests, please slow down', status: 429 } },
    })
  );

  // Resolve the caller's identity once, before any route needs it. Routes that
  // require a user add requireAuth; the rest simply see req.user or null.
  app.use('/api', attachUser);

  app.use('/api', mapRoutes);
  app.use('/api', restaurantRoutes);
  app.use('/api', ratingRoutes);
  app.use('/api', photoRoutes);

  // Frontend. Static assets are served after the API so a stray file can never
  // shadow an endpoint.
  app.use(express.static(publicDir, { extensions: ['html'] }));

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

/** Start listening. Exported separately so tests can use createApp() alone. */
export async function start() {
  validateConfig();

  await db.init();
  console.log(`[db] connected via ${db.kind()}`);

  startWorker();

  const app = createApp();
  const httpServer = app.listen(serverConfig.port, () => {
    console.log(`[server] listening on http://localhost:${serverConfig.port}`);
    console.log(`[server] environment: ${serverConfig.isProduction ? 'production' : 'development'}`);
    if (devAuthEnabled()) {
      console.warn(
        '[server] DEV AUTH ACTIVE — any request may claim an identity with the\n' +
          '         X-Dev-User header. This requires both a non-production\n' +
          '         NODE_ENV and an unset SUPABASE_URL, so it cannot happen in\n' +
          '         production, but never expose this server publicly as-is.'
      );
    }
  });

  // Give in-flight requests a chance to finish before dropping the process.
  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[server] ${signal} received, shutting down`);
    stopWorker();

    httpServer.close(async () => {
      await db.close();
      console.log('[server] shutdown complete');
      process.exit(0);
    });

    // Don't hang forever if a connection refuses to close.
    setTimeout(() => {
      console.error('[server] forced exit after 10s');
      process.exit(1);
    }, 10_000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  return httpServer;
}

// Only auto-start when run directly, so importing this module in a test does
// not open a port.
const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (invokedDirectly) {
  start().catch((err) => {
    console.error('[server] failed to start:', err.message);
    process.exit(1);
  });
}
