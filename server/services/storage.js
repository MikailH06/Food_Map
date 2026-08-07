/**
 * Supabase Storage helpers.
 *
 * Only URL construction and lookups live here. Uploads go straight from the
 * browser to Supabase — see routes/photos.js for why.
 */

import { supabase as supabaseConfig } from '../config.js';
import * as db from '../db/pool.js';

/** Public URL for an object in the photos bucket, or null if storage is unconfigured. */
export function publicUrl(path) {
  if (!path || !supabaseConfig.url) return null;
  return `${supabaseConfig.url}/storage/v1/object/public/${supabaseConfig.storageBucket}/${path}`;
}

/**
 * Best photo per restaurant, for a batch of restaurants.
 *
 * Prefers one explicitly marked primary, then the most recent. Batched so a map
 * with 200 pins costs one query rather than 200.
 *
 * @param {string[]} restaurantIds
 * @returns {Promise<Map<string, string>>} restaurant id -> public URL
 */
export async function getPrimaryPhotos(restaurantIds) {
  if (!restaurantIds || restaurantIds.length === 0) return new Map();

  const { rows } = await db.query(
    `SELECT DISTINCT ON (restaurant_id) restaurant_id, storage_path
     FROM restaurant_photos
     WHERE restaurant_id = ANY($1)
     ORDER BY restaurant_id, is_primary DESC, created_at DESC`,
    [restaurantIds]
  );

  return new Map(rows.map((r) => [r.restaurant_id, publicUrl(r.storage_path)]));
}

/**
 * A given user's own ratings across a batch of restaurants, so the interface can
 * show their stars already filled in.
 *
 * @param {string|null} userId
 * @param {string[]} restaurantIds
 * @returns {Promise<Map<string, object>>}
 */
export async function getViewerRatings(userId, restaurantIds) {
  if (!userId || !restaurantIds || restaurantIds.length === 0) return new Map();

  const { rows } = await db.query(
    `SELECT restaurant_id, stars, price_level, comment
     FROM ratings WHERE user_id = $1 AND restaurant_id = ANY($2)`,
    [userId, restaurantIds]
  );

  return new Map(rows.map((r) => [r.restaurant_id, r]));
}
