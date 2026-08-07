/**
 * Rating routes.
 *
 * Ratings are the community layer of the resolver, and — given that restaurant
 * websites publish a usable rating only 0.7% of the time — they are where
 * almost every rating in this app will come from until Google is enabled.
 *
 * One rating per user per restaurant, editable. Averaged across ALL users of
 * the platform, so a restaurant pinned by several people accumulates a genuinely
 * shared score rather than a private one.
 */

import { Router } from 'express';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import * as db from '../db/pool.js';
import { requireAuth } from '../middleware/auth.js';
import { validateBody, validateParams, validateQuery } from '../middleware/validate.js';
import { notFound } from '../middleware/errors.js';
import { ratings as ratingsConfig, rateLimits } from '../config.js';

const router = Router();

const uuid = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, 'must be a UUID');

const restaurantParams = z.object({ id: uuid });

const writeLimiter = rateLimit({
  windowMs: rateLimits.windowMs,
  max: rateLimits.writeMax,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
});

async function requireRestaurant(id) {
  const { rows } = await db.query('SELECT id FROM restaurants WHERE id = $1', [id]);
  if (rows.length === 0) throw notFound('No such restaurant');
}

/**
 * Create or update the caller's rating.
 *
 * PUT rather than POST because it is idempotent: rating a place twice replaces
 * the first rating instead of adding a second.
 */
router.put(
  '/restaurants/:id/rating',
  requireAuth,
  writeLimiter,
  validateParams(restaurantParams),
  validateBody(
    z.object({
      stars: z
        .number()
        .int()
        .min(ratingsConfig.minStars, `Rate between ${ratingsConfig.minStars} and ${ratingsConfig.maxStars} stars`)
        .max(ratingsConfig.maxStars, `Rate between ${ratingsConfig.minStars} and ${ratingsConfig.maxStars} stars`),
      priceLevel: z
        .number()
        .int()
        .min(ratingsConfig.minPriceLevel)
        .max(ratingsConfig.maxPriceLevel)
        .nullable()
        .optional(),
      comment: z.string().trim().max(ratingsConfig.maxCommentLength).nullable().optional(),
    })
  ),
  async (req, res) => {
    await requireRestaurant(req.params.id);

    const { rows } = await db.query(
      `INSERT INTO ratings (user_id, restaurant_id, stars, price_level, comment)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id, restaurant_id)
       DO UPDATE SET stars = EXCLUDED.stars,
                     price_level = EXCLUDED.price_level,
                     comment = EXCLUDED.comment,
                     updated_at = now()
       RETURNING *`,
      [
        req.user.id,
        req.params.id,
        req.body.stars,
        req.body.priceLevel ?? null,
        req.body.comment ?? null,
      ]
    );

    // Return the fresh aggregate so the client can update without re-fetching.
    const stats = await db.query('SELECT * FROM restaurant_stats WHERE restaurant_id = $1', [
      req.params.id,
    ]);

    res.json({
      rating: rows[0],
      stats: stats.rows[0] ?? { avg_stars: null, rating_count: 0, modal_price_level: null },
    });
  }
);

router.delete(
  '/restaurants/:id/rating',
  requireAuth,
  writeLimiter,
  validateParams(restaurantParams),
  async (req, res) => {
    const { rowCount } = await db.query(
      'DELETE FROM ratings WHERE user_id = $1 AND restaurant_id = $2',
      [req.user.id, req.params.id]
    );

    if (rowCount === 0) throw notFound('You have not rated this restaurant');
    res.status(204).end();
  }
);

/** Everyone's ratings for a restaurant, newest first. */
router.get(
  '/restaurants/:id/ratings',
  validateParams(restaurantParams),
  validateQuery(
    z.object({
      limit: z.coerce.number().int().positive().max(100).optional().default(20),
      offset: z.coerce.number().int().min(0).optional().default(0),
    })
  ),
  async (req, res) => {
    await requireRestaurant(req.params.id);
    const { limit, offset } = req.validatedQuery;

    const { rows } = await db.query(
      `SELECT r.id, r.stars, r.price_level, r.comment, r.created_at, r.updated_at,
              p.display_name
       FROM ratings r
       LEFT JOIN profiles p ON p.id = r.user_id
       WHERE r.restaurant_id = $1
       ORDER BY r.updated_at DESC
       LIMIT $2 OFFSET $3`,
      [req.params.id, limit, offset]
    );

    const stats = await db.query('SELECT * FROM restaurant_stats WHERE restaurant_id = $1', [
      req.params.id,
    ]);

    res.json({
      ratings: rows,
      stats: stats.rows[0] ?? { avg_stars: null, rating_count: 0, modal_price_level: null },
    });
  }
);

export default router;
