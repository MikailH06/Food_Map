/**
 * Photo routes.
 *
 * The browser uploads the file DIRECTLY to Supabase Storage using its own
 * session, then tells this endpoint where it landed. The bytes never pass
 * through our server.
 *
 * That is deliberate on three counts: Render's free tier has limited memory and
 * bandwidth, proxying uploads would need multipart parsing and a temp-file
 * strategy, and Supabase's own storage policies can enforce per-user folders
 * far more reliably than we could by inspecting request bodies.
 *
 * What is left for us is the part the client cannot be trusted with: confirming
 * the claimed path really belongs to the caller, and confirming the object
 * actually exists before we record it.
 */

import { Router } from 'express';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import * as db from '../db/pool.js';
import { requireAuth } from '../middleware/auth.js';
import { validateBody, validateParams } from '../middleware/validate.js';
import { notFound, badRequest, forbidden } from '../middleware/errors.js';
import { supabase as supabaseConfig, photos as photoConfig, rateLimits } from '../config.js';

const router = Router();

const uuid = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, 'must be a UUID');

const uploadLimiter = rateLimit({
  windowMs: rateLimits.windowMs,
  max: rateLimits.writeMax,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
});

/** Lazily created service-role client. Never reaches the browser. */
let storageClient = null;

async function getStorage() {
  if (!supabaseConfig.url || !supabaseConfig.serviceRoleKey) return null;

  if (!storageClient) {
    const { createClient } = await import('@supabase/supabase-js');
    storageClient = createClient(supabaseConfig.url, supabaseConfig.serviceRoleKey, {
      auth: { persistSession: false },
    });
  }
  return storageClient;
}

/**
 * The path a user is allowed to write to.
 *
 * Namespacing by user id means one user cannot claim another's upload, and it
 * matches the storage policy you configure in Supabase.
 */
function expectedPrefix(userId, restaurantId) {
  return `${userId}/${restaurantId}/`;
}

/** Public URL for a stored object. */
function publicUrl(path) {
  return `${supabaseConfig.url}/storage/v1/object/public/${supabaseConfig.storageBucket}/${path}`;
}

/**
 * Record a photo the client has already uploaded.
 *
 * Body: { storagePath: "<userId>/<restaurantId>/<filename>", isPrimary?: boolean }
 */
router.post(
  '/restaurants/:id/photos',
  requireAuth,
  uploadLimiter,
  validateParams(z.object({ id: uuid })),
  validateBody(
    z.object({
      storagePath: z.string().trim().min(1).max(500),
      isPrimary: z.boolean().optional().default(false),
    })
  ),
  async (req, res) => {
    const storage = await getStorage();
    if (!storage) {
      throw badRequest(
        'Photo uploads need Supabase Storage configured (SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY).'
      );
    }

    const restaurant = await db.query('SELECT id FROM restaurants WHERE id = $1', [req.params.id]);
    if (restaurant.rows.length === 0) throw notFound('No such restaurant');

    const { storagePath, isPrimary } = req.body;

    // A client could otherwise claim any path in the bucket, including someone
    // else's upload.
    const prefix = expectedPrefix(req.user.id, req.params.id);
    if (!storagePath.startsWith(prefix)) {
      throw forbidden(`Uploads must be stored under ${prefix}`);
    }
    // Defeat traversal like "alice/rest/../../bob/secret.jpg".
    if (storagePath.includes('..')) {
      throw badRequest('Invalid storage path');
    }

    const existing = await db.query(
      'SELECT count(*)::int AS c FROM restaurant_photos WHERE restaurant_id = $1 AND user_id = $2',
      [req.params.id, req.user.id]
    );
    if (existing.rows[0].c >= photoConfig.maxPerRestaurantPerUser) {
      throw badRequest(
        `You can add at most ${photoConfig.maxPerRestaurantPerUser} photos per restaurant`
      );
    }

    // Confirm the object is really there, so a failed upload cannot leave a
    // database row pointing at nothing.
    const folder = storagePath.slice(0, storagePath.lastIndexOf('/'));
    const filename = storagePath.slice(storagePath.lastIndexOf('/') + 1);

    const { data: listed, error: listError } = await storage.storage
      .from(supabaseConfig.storageBucket)
      .list(folder, { search: filename, limit: 1 });

    if (listError) throw badRequest(`Could not verify the upload: ${listError.message}`);

    const object = listed?.[0];
    if (!object) throw badRequest('No uploaded file found at that path');

    const size = object.metadata?.size ?? 0;
    if (size > photoConfig.maxBytes) {
      // Remove it rather than leaving an oversized object consuming the 1GB.
      await storage.storage.from(supabaseConfig.storageBucket).remove([storagePath]);
      throw badRequest(`Photos must be under ${Math.round(photoConfig.maxBytes / 1024 / 1024)}MB`);
    }

    const mimeType = object.metadata?.mimetype;
    if (mimeType && !photoConfig.allowedMimeTypes.includes(mimeType)) {
      await storage.storage.from(supabaseConfig.storageBucket).remove([storagePath]);
      throw badRequest(`Photos must be one of: ${photoConfig.allowedMimeTypes.join(', ')}`);
    }

    const saved = await db.transaction(async (tx) => {
      if (isPrimary) {
        await tx.query('UPDATE restaurant_photos SET is_primary = false WHERE restaurant_id = $1', [
          req.params.id,
        ]);
      }

      const inserted = await tx.query(
        `INSERT INTO restaurant_photos (restaurant_id, user_id, storage_path, is_primary)
         VALUES ($1, $2, $3, $4) RETURNING *`,
        [req.params.id, req.user.id, storagePath, isPrimary]
      );
      return inserted.rows[0];
    });

    res.status(201).json({ photo: { ...saved, url: publicUrl(saved.storage_path) } });
  }
);

router.get('/restaurants/:id/photos', validateParams(z.object({ id: uuid })), async (req, res) => {
  const { rows } = await db.query(
    `SELECT id, storage_path, is_primary, created_at, user_id
     FROM restaurant_photos WHERE restaurant_id = $1
     ORDER BY is_primary DESC, created_at DESC`,
    [req.params.id]
  );

  res.json({
    photos: rows.map((p) => ({ ...p, url: publicUrl(p.storage_path) })),
  });
});

router.delete(
  '/restaurants/:restaurantId/photos/:photoId',
  requireAuth,
  validateParams(z.object({ restaurantId: uuid, photoId: uuid })),
  async (req, res) => {
    const { rows } = await db.query('SELECT * FROM restaurant_photos WHERE id = $1', [
      req.params.photoId,
    ]);
    const photo = rows[0];

    if (!photo) throw notFound('No such photo');
    if (photo.user_id !== req.user.id) throw forbidden('You can only remove your own photos');

    const storage = await getStorage();
    if (storage) {
      // Best effort: a storage failure should not block removing the record,
      // or the user could never get rid of it.
      await storage.storage
        .from(supabaseConfig.storageBucket)
        .remove([photo.storage_path])
        .catch(() => {});
    }

    await db.query('DELETE FROM restaurant_photos WHERE id = $1', [req.params.photoId]);
    res.status(204).end();
  }
);

export default router;
