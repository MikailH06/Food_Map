/**
 * Restaurant routes: searching the catalog and reading one restaurant.
 */

import { Router } from 'express';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import { validateQuery, validateParams } from '../middleware/validate.js';
import { notFound } from '../middleware/errors.js';
import { searchRestaurants, getRestaurantById } from '../services/search.js';
import { resolveRestaurant, resolveMany } from '../services/resolver.js';
import { getPrimaryPhotos, getViewerRatings } from '../services/storage.js';
import { search as searchConfig, geography, rateLimits } from '../config.js';

const router = Router();

const uuid = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, 'must be a UUID');

/**
 * Search is cheap for us but the most-hit endpoint, since the UI queries it as
 * the user types. It gets its own, more generous limit.
 */
const searchLimiter = rateLimit({
  windowMs: rateLimits.windowMs,
  max: rateLimits.searchMax,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
});

const searchQuery = z.object({
  q: z.string().trim().max(200).optional(),
  lat: z.coerce.number().min(-90).max(90).optional(),
  lng: z.coerce.number().min(-180).max(180).optional(),
  radius: z.coerce.number().int().positive().max(geography.maxSearchRadiusMeters).optional(),
  limit: z.coerce.number().int().positive().max(searchConfig.maxLimit).optional(),
  excludeMapId: uuid.optional(),
});

/**
 * GET /api/restaurants/search
 *
 * Backs the quick-add box: the user types a name, picks a result and presses
 * add, never typing an address or any other detail.
 *
 *   ?q=pizza                       search by text
 *   ?q=pizza&lat=..&lng=..         prefer results near the map centre
 *   ?lat=..&lng=..&radius=2000     browse everything nearby
 *   ?excludeMapId=..               hide what is already pinned
 */
router.get('/restaurants/search', searchLimiter, validateQuery(searchQuery), async (req, res) => {
  const { q, lat, lng, radius, limit, excludeMapId } = req.validatedQuery;

  const results = await searchRestaurants({
    q,
    lat,
    lng,
    radiusMeters: radius,
    limit,
    excludeMapId,
  });

  const ids = results.map((r) => r.id);
  const [photos, viewerRatings] = await Promise.all([
    getPrimaryPhotos(ids),
    getViewerRatings(req.user?.id ?? null, ids),
  ]);

  res.json({
    count: results.length,
    restaurants: resolveMany(results, {
      photosByRestaurant: photos,
      ratingsByRestaurant: viewerRatings,
    }),
  });
});

router.get('/restaurants/:id', validateParams(z.object({ id: uuid })), async (req, res) => {
  const row = await getRestaurantById(req.params.id);
  if (!row) throw notFound('No such restaurant');

  const [photos, viewerRatings] = await Promise.all([
    getPrimaryPhotos([row.id]),
    getViewerRatings(req.user?.id ?? null, [row.id]),
  ]);

  res.json({
    restaurant: resolveRestaurant(row, {
      userPhotoUrl: photos.get(row.id) ?? null,
      viewerRating: viewerRatings.get(row.id) ?? null,
    }),
  });
});

export default router;
