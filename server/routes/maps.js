/**
 * Map routes.
 *
 * A map belongs to exactly one user and holds their pins. Restaurants
 * themselves are shared, so two users pinning the same place point at one row —
 * which is what lets ratings average across everybody.
 */

import { Router } from 'express';
import { z } from 'zod';
import * as db from '../db/pool.js';
import { requireAuth } from '../middleware/auth.js';
import { validateBody, validateParams } from '../middleware/validate.js';
import { notFound, forbidden, conflict, badRequest } from '../middleware/errors.js';
import { getMapRestaurants } from '../services/search.js';
import { geography } from '../config.js';

const router = Router();

const uuid = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, 'must be a UUID');

const mapIdParams = z.object({ id: uuid });
const pinParams = z.object({ id: uuid, restaurantId: uuid });

/** Turn a map name into a URL-safe slug with a short random suffix for uniqueness. */
function slugify(name) {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40) || 'map';
  return `${base}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Load a map and confirm the caller may see it.
 *
 * Read access: the owner, or anybody if the map is public.
 * Write access: the owner only.
 */
async function loadMap(mapId, user, { forWriting = false } = {}) {
  const { rows } = await db.query('SELECT * FROM maps WHERE id = $1', [mapId]);
  const map = rows[0];

  if (!map) throw notFound('That map does not exist');

  const isOwner = user && map.owner_id === user.id;
  if (forWriting && !isOwner) throw forbidden('Only the owner can change this map');
  if (!isOwner && !map.is_public) throw forbidden('That map is private');

  return { map, isOwner };
}

/** The signed-in user's profile and their maps. */
router.get('/me', requireAuth, async (req, res) => {
  const profile = await db.query('SELECT id, display_name, created_at FROM profiles WHERE id = $1', [
    req.user.id,
  ]);

  const maps = await db.query(
    `SELECT m.*, (SELECT count(*)::int FROM map_restaurants WHERE map_id = m.id) AS restaurant_count
     FROM maps m WHERE m.owner_id = $1 ORDER BY m.created_at ASC`,
    [req.user.id]
  );

  res.json({ profile: profile.rows[0] ?? null, maps: maps.rows });
});

router.post(
  '/maps',
  requireAuth,
  validateBody(
    z.object({
      name: z.string().trim().min(1, 'Give the map a name').max(100),
      isPublic: z.boolean().optional().default(false),
    })
  ),
  async (req, res) => {
    const { name, isPublic } = req.body;

    const { rows } = await db.query(
      `INSERT INTO maps (owner_id, name, slug, is_public, center_lat, center_lng, zoom)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        req.user.id,
        name,
        slugify(name),
        isPublic,
        geography.defaultCenter.lat,
        geography.defaultCenter.lng,
        geography.defaultZoom,
      ]
    );

    res.status(201).json({ map: rows[0] });
  }
);

/** A map and every pin on it. */
router.get('/maps/:id', validateParams(mapIdParams), async (req, res) => {
  const { map, isOwner } = await loadMap(req.params.id, req.user);
  const restaurants = await getMapRestaurants(map.id);

  res.json({ map, isOwner, restaurants });
});

router.patch(
  '/maps/:id',
  requireAuth,
  validateParams(mapIdParams),
  validateBody(
    z.object({
      name: z.string().trim().min(1).max(100).optional(),
      isPublic: z.boolean().optional(),
      zoom: z.number().int().min(geography.minZoom).max(geography.maxZoom).optional(),
    })
  ),
  async (req, res) => {
    await loadMap(req.params.id, req.user, { forWriting: true });

    // Build the update from whichever fields were actually supplied.
    const updates = [];
    const params = [];
    const set = (column, value) => {
      params.push(value);
      updates.push(`${column} = $${params.length}`);
    };

    if (req.body.name !== undefined) set('name', req.body.name);
    if (req.body.isPublic !== undefined) set('is_public', req.body.isPublic);
    if (req.body.zoom !== undefined) set('zoom', req.body.zoom);

    if (updates.length === 0) throw badRequest('No changes were supplied');

    params.push(req.params.id);
    const { rows } = await db.query(
      `UPDATE maps SET ${updates.join(', ')} WHERE id = $${params.length} RETURNING *`,
      params
    );

    res.json({ map: rows[0] });
  }
);

router.delete('/maps/:id', requireAuth, validateParams(mapIdParams), async (req, res) => {
  await loadMap(req.params.id, req.user, { forWriting: true });
  await db.query('DELETE FROM maps WHERE id = $1', [req.params.id]);
  res.status(204).end();
});

/**
 * Quick-add: pin an existing catalog restaurant to a map.
 *
 * This is the one-click path — the client sends only an id it got from search,
 * so the user never types restaurant details.
 */
router.post(
  '/maps/:id/restaurants',
  requireAuth,
  validateParams(mapIdParams),
  validateBody(
    z.object({
      restaurantId: uuid,
      notes: z.string().max(2000).optional(),
    })
  ),
  async (req, res) => {
    await loadMap(req.params.id, req.user, { forWriting: true });

    const exists = await db.query('SELECT id, website FROM restaurants WHERE id = $1', [
      req.body.restaurantId,
    ]);
    if (exists.rows.length === 0) throw notFound('That restaurant is not in the catalog');

    const inserted = await db.query(
      `INSERT INTO map_restaurants (map_id, restaurant_id, notes)
       VALUES ($1, $2, $3)
       ON CONFLICT (map_id, restaurant_id) DO NOTHING
       RETURNING *`,
      [req.params.id, req.body.restaurantId, req.body.notes ?? null]
    );

    if (inserted.rows.length === 0) {
      throw conflict('That restaurant is already on this map');
    }

    // Being pinned is what makes a restaurant worth enriching — we only crawl
    // places somebody actually cares about, not all 13k in the catalog.
    if (exists.rows[0].website) {
      await db.query(
        `INSERT INTO enrichment_jobs (restaurant_id) VALUES ($1)
         ON CONFLICT (restaurant_id) DO NOTHING`,
        [req.body.restaurantId]
      );
    }

    res.status(201).json({ pin: inserted.rows[0] });
  }
);

router.patch(
  '/maps/:id/restaurants/:restaurantId',
  requireAuth,
  validateParams(pinParams),
  validateBody(z.object({ notes: z.string().max(2000).nullable() })),
  async (req, res) => {
    await loadMap(req.params.id, req.user, { forWriting: true });

    const { rows } = await db.query(
      `UPDATE map_restaurants SET notes = $3
       WHERE map_id = $1 AND restaurant_id = $2 RETURNING *`,
      [req.params.id, req.params.restaurantId, req.body.notes]
    );

    if (rows.length === 0) throw notFound('That restaurant is not on this map');
    res.json({ pin: rows[0] });
  }
);

router.delete(
  '/maps/:id/restaurants/:restaurantId',
  requireAuth,
  validateParams(pinParams),
  async (req, res) => {
    await loadMap(req.params.id, req.user, { forWriting: true });

    const { rowCount } = await db.query(
      'DELETE FROM map_restaurants WHERE map_id = $1 AND restaurant_id = $2',
      [req.params.id, req.params.restaurantId]
    );

    if (rowCount === 0) throw notFound('That restaurant is not on this map');
    res.status(204).end();
  }
);

export default router;
