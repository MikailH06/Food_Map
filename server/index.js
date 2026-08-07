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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, '..', 'public');

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

  app.use(
    cors({
      origin(origin, callback) {
        // Same-origin requests and server-to-server calls send no Origin header.
        if (!origin) return callback(null, true);
        if (serverConfig.corsOrigins.includes(origin)) return callback(null, true);
        callback(new Error(`Origin ${origin} is not allowed by CORS`));
      },
      credentials: true,
    })
  );

  app.use(express.json({ limit: '1mb' }));

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
