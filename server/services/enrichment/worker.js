/**
 * Enrichment worker.
 *
 * Drains the enrichment_jobs queue, fetching each restaurant's own website and
 * reading the structured data it publishes. Runs in-process on a timer rather
 * than as a separate service, because a second service would need a second
 * (paid) host.
 *
 * Jobs are created when a restaurant is PINNED, not when it is imported, so the
 * crawler only ever visits places somebody actually cares about — a few hundred
 * rather than all 13k in the catalog.
 */

import { enrichment as config, providers } from '../../config.js';
import * as db from '../../db/pool.js';
import { politeFetch, backoffMs } from './politeness.js';
import { extractFromHtml } from './structuredData.js';
import { getPlaceDetails } from '../../providers/places/index.js';

let timer = null;
let running = false;

/**
 * Claim up to `limit` due jobs.
 *
 * Marking them 'running' in the same statement that selects them means two
 * workers — or two Render instances — cannot pick up the same job.
 */
async function claimJobs(limit) {
  const { rows } = await db.query(
    `UPDATE enrichment_jobs
     SET status = 'running', updated_at = now()
     WHERE id IN (
       SELECT id FROM enrichment_jobs
       WHERE status IN ('pending', 'failed')
         AND next_attempt_at <= now()
         AND attempts < $1
       ORDER BY next_attempt_at ASC
       LIMIT $2
     )
     RETURNING id, restaurant_id, attempts`,
    [config.maxAttempts, limit]
  );
  return rows;
}

async function finishJob(jobId, restaurantId, status, error = null) {
  await db.query(
    `UPDATE enrichment_jobs
     SET status = $2, last_error = $3, attempts = attempts + 1,
         next_attempt_at = CASE WHEN $2 = 'failed'
           THEN now() + ($4 || ' milliseconds')::interval
           ELSE now() END,
         updated_at = now()
     WHERE id = $1`,
    [jobId, status, error, String(backoffMs(1))]
  );

  await db.query('UPDATE restaurants SET enrich_status = $2 WHERE id = $1', [restaurantId, status]);
}

/**
 * Enrich one restaurant.
 *
 * Layer order matters: Google first when it is configured, because it is
 * strictly better data; otherwise the restaurant's own website.
 *
 * @returns {Promise<{status: string, found: string[]}>}
 */
export async function enrichRestaurant(restaurant) {
  // --- Layer 1: Google Places (only when a key is configured) -------------
  if (providers.googleEnabled && restaurant.google_place_id) {
    const details = await getPlaceDetails(restaurant.google_place_id);
    if (details) {
      await db.query(
        `UPDATE restaurants SET
           ext_rating = $2, ext_rating_count = $3, ext_price_level = $4,
           ext_photo_url = $5, ext_description = $6,
           ext_source = 'google', enriched_at = now(), enrich_status = 'done'
         WHERE id = $1`,
        [
          restaurant.id,
          details.rating,
          details.ratingCount,
          details.priceLevel,
          details.photoUrl,
          details.description,
        ]
      );
      return { status: 'done', found: ['google'] };
    }
  }

  // --- Layer 2: the restaurant's own website ------------------------------
  if (!restaurant.website) {
    return { status: 'skipped', found: [] };
  }

  const { html, finalUrl } = await politeFetch(restaurant.website);
  const extracted = extractFromHtml(html, finalUrl);

  // Nothing usable found. Recording 'done' rather than 'failed' is deliberate:
  // the fetch worked, the site simply publishes no structured data, and
  // retrying would produce the same nothing.
  const foundAnything =
    extracted.rating !== null ||
    extracted.priceLevel !== null ||
    extracted.photoUrl !== null ||
    extracted.description !== null;

  await db.query(
    `UPDATE restaurants SET
       ext_rating = $2, ext_rating_count = $3, ext_price_level = $4,
       ext_photo_url = $5, ext_description = $6,
       ext_source = CASE WHEN $7 THEN 'website' ELSE NULL END,
       enriched_at = now(), enrich_status = 'done'
     WHERE id = $1`,
    [
      restaurant.id,
      extracted.rating,
      extracted.ratingCount,
      extracted.priceLevel,
      extracted.photoUrl,
      extracted.description,
      foundAnything,
    ]
  );

  return { status: 'done', found: extracted.found };
}

/** Process one batch of due jobs. Exported so tests can drive it directly. */
export async function processBatch(limit = config.jobsPerTick) {
  const jobs = await claimJobs(limit);
  if (jobs.length === 0) return { processed: 0, succeeded: 0, failed: 0 };

  let succeeded = 0;
  let failed = 0;

  // Run a bounded number at a time. politeness.js separately guarantees only
  // one request per host, so this concurrency is across different domains.
  const queue = [...jobs];
  const runners = Array.from({ length: Math.min(config.concurrency, queue.length) }, async () => {
    for (;;) {
      const job = queue.shift();
      if (!job) return;

      const { rows } = await db.query('SELECT * FROM restaurants WHERE id = $1', [
        job.restaurant_id,
      ]);
      const restaurant = rows[0];

      if (!restaurant) {
        await finishJob(job.id, job.restaurant_id, 'skipped', 'restaurant no longer exists');
        continue;
      }

      try {
        const result = await enrichRestaurant(restaurant);
        await finishJob(job.id, restaurant.id, result.status);
        succeeded += 1;
      } catch (err) {
        const willRetry = job.attempts + 1 < config.maxAttempts;
        await finishJob(job.id, restaurant.id, willRetry ? 'failed' : 'skipped', err.message);
        failed += 1;
      }
    }
  });

  await Promise.all(runners);
  return { processed: jobs.length, succeeded, failed };
}

/** Start the background loop. No-op when enrichment is disabled. */
export function startWorker() {
  if (!config.enabled) {
    console.log('[enrich] disabled (ENRICHMENT_ENABLED=false)');
    return;
  }
  if (timer) return;

  const tick = async () => {
    // Skip if the previous tick is still going, so a slow batch cannot stack up.
    if (running) return;
    running = true;
    try {
      const result = await processBatch();
      if (result.processed > 0) {
        console.log(
          `[enrich] processed ${result.processed} (${result.succeeded} ok, ${result.failed} failed)`
        );
      }
    } catch (err) {
      console.error('[enrich] batch error:', err.message);
    } finally {
      running = false;
    }
  };

  timer = setInterval(tick, config.pollIntervalMs);
  // Do not hold the process open just for the worker.
  timer.unref?.();

  console.log(
    `[enrich] worker started — every ${config.pollIntervalMs / 1000}s, ` +
      `concurrency ${config.concurrency}`
  );
}

export function stopWorker() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

/**
 * Queue restaurants that are pinned somewhere, have a website, and have either
 * never been enriched or are past the refresh window.
 *
 * @returns {Promise<number>} how many jobs were created
 */
export async function enqueueStale() {
  const { rowCount } = await db.query(
    `INSERT INTO enrichment_jobs (restaurant_id)
     SELECT DISTINCT r.id
     FROM restaurants r
     JOIN map_restaurants mr ON mr.restaurant_id = r.id
     WHERE r.website IS NOT NULL
       AND (r.enriched_at IS NULL OR r.enriched_at < now() - ($1 || ' days')::interval)
     ON CONFLICT (restaurant_id) DO NOTHING`,
    [String(config.refreshAfterDays)]
  );
  return rowCount;
}
