/**
 * Health and public-config endpoints.
 *
 * GET /health is the target for the GitHub Actions keep-alive cron. That cron
 * is doing real work: it prevents Render's free tier sleeping after 15 minutes
 * idle AND Supabase pausing a free project after 7 days idle. Because it issues
 * a real database query, it resets both timers at once.
 */

import { Router } from 'express';
import * as db from '../db/pool.js';
import { publicConfig } from '../config.js';

const router = Router();

const startedAt = Date.now();

router.get('/health', async (req, res) => {
  const dbUp = await db.healthy();

  res.status(dbUp ? 200 : 503).json({
    status: dbUp ? 'ok' : 'degraded',
    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
    database: { connected: dbUp, driver: db.kind() },
    timestamp: new Date().toISOString(),
  });
});

/**
 * Everything the browser needs to configure itself: which map provider to use,
 * the tile URL, and the geographic bounds. Serving this from the API means the
 * frontend has no hardcoded configuration — changing config.js changes the
 * frontend's behaviour with no frontend edit.
 */
router.get('/api/config', (req, res) => {
  res.json(publicConfig());
});

export default router;
