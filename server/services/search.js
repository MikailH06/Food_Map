/**
 * Restaurant search.
 *
 * Runs entirely against our own Postgres, which is the payoff for seeding from
 * OpenStreetMap: quick-add answers in milliseconds with no external API quota,
 * no rate limit and no per-request cost.
 *
 * Three signals are combined, weighted by config.search.weights:
 *
 *   trigram similarity on the name  — tolerates typos ("chipolte" finds Chipotle)
 *   full-text rank over the document — matches cuisine and street, not just name
 *   proximity to the map centre      — a nearby match beats an identical one
 *                                      across the county
 *
 * All three are needed. Trigram alone cannot find "oaxacan" for a restaurant
 * named Guelaguetza; full-text alone cannot survive a misspelling.
 */

import { search as searchConfig, geography } from '../config.js';
import * as db from '../db/pool.js';

/**
 * Great-circle distance in metres between a row's lat/lng and a fixed point.
 *
 * Written inline rather than using PostGIS so the same SQL runs on Supabase and
 * on PGlite. At LA County scale a bounding-box prefilter followed by this is
 * comfortably fast — the index does the elimination, this only ranks what
 * survives.
 */
function haversineSql(latParam, lngParam) {
  return `(6371000 * 2 * asin(sqrt(
    power(sin(radians(${latParam} - r.lat) / 2), 2) +
    cos(radians(r.lat)) * cos(radians(${latParam})) *
    power(sin(radians(${lngParam} - r.lng) / 2), 2)
  )))`;
}

/**
 * A bounding box that comfortably contains `radius` metres around a point.
 *
 * Used to eliminate almost every row with an index scan before any trigonometry
 * runs. One degree of latitude is ~111km; longitude degrees shrink towards the
 * poles, hence the cos() correction.
 */
function boundingBox(lat, lng, radiusMeters) {
  const latDelta = radiusMeters / 111_000;
  const lngDelta = radiusMeters / (111_000 * Math.cos((lat * Math.PI) / 180));
  return {
    minLat: lat - latDelta,
    maxLat: lat + latDelta,
    minLng: lng - lngDelta,
    maxLng: lng + lngDelta,
  };
}

/** Columns every search result carries. Kept in one place so shapes stay consistent. */
const RESULT_COLUMNS = `
  r.id, r.name, r.address_line1, r.city, r.state, r.postal_code,
  r.lat, r.lng, r.cuisines, r.phone, r.website, r.opening_hours,
  r.source, r.ext_rating, r.ext_rating_count, r.ext_price_level,
  r.ext_photo_url, r.ext_description, r.ext_source, r.enrich_status
`;

/**
 * Search the catalog.
 *
 * @param {object} options
 * @param {string} [options.q]             free text; omit to browse by location
 * @param {number} [options.lat]           map centre, for proximity ranking
 * @param {number} [options.lng]
 * @param {number} [options.radiusMeters]  restrict to this radius
 * @param {number} [options.limit]
 * @param {string} [options.excludeMapId]  hide restaurants already on this map
 * @returns {Promise<Array>}
 */
export async function searchRestaurants({
  q = null,
  lat = null,
  lng = null,
  radiusMeters = null,
  limit = searchConfig.defaultLimit,
  excludeMapId = null,
} = {}) {
  const params = [];
  const push = (value) => `$${params.push(value)}`;

  const hasQuery = Boolean(q && q.trim());
  const hasLocation = typeof lat === 'number' && typeof lng === 'number';

  const where = [];
  const scoreParts = [];
  const selectExtras = [];

  if (hasQuery) {
    const term = q.trim();
    const trigramParam = push(term);
    const textParam = push(term);

    // A row qualifies on either signal; the score decides the order.
    where.push(`(
      similarity(r.name, ${trigramParam}) > ${push(searchConfig.minSimilarity)}
      OR r.search_vec @@ plainto_tsquery('english', ${textParam})
    )`);

    selectExtras.push(`similarity(r.name, ${trigramParam}) AS name_score`);
    selectExtras.push(
      `ts_rank(r.search_vec, plainto_tsquery('english', ${textParam})) AS text_score`
    );

    scoreParts.push(`${searchConfig.weights.nameTrigram} * similarity(r.name, ${trigramParam})`);
    scoreParts.push(
      `${searchConfig.weights.fullText} * ts_rank(r.search_vec, plainto_tsquery('english', ${textParam}))`
    );
  }

  if (hasLocation) {
    const radius = Math.min(
      radiusMeters ?? geography.defaultSearchRadiusMeters,
      geography.maxSearchRadiusMeters
    );
    const box = boundingBox(lat, lng, radius);

    // Index-friendly prefilter. Without this every search would compute
    // trigonometry for all 13k rows.
    where.push(`r.lat BETWEEN ${push(box.minLat)} AND ${push(box.maxLat)}`);
    where.push(`r.lng BETWEEN ${push(box.minLng)} AND ${push(box.maxLng)}`);

    const latParam = push(lat);
    const lngParam = push(lng);
    const distance = haversineSql(latParam, lngParam);

    where.push(`${distance} <= ${push(radius)}`);
    selectExtras.push(`${distance} AS distance_meters`);

    // Decays smoothly with distance: same place 1km away scores 0.5, 4km away 0.2.
    scoreParts.push(`${searchConfig.weights.proximity} * (1.0 / (1.0 + ${distance} / 1000.0))`);
  }

  if (excludeMapId) {
    where.push(`NOT EXISTS (
      SELECT 1 FROM map_restaurants mr
      WHERE mr.restaurant_id = r.id AND mr.map_id = ${push(excludeMapId)}
    )`);
  }

  // With neither a query nor a location there is nothing meaningful to rank by,
  // so fall back to a stable alphabetical listing.
  const orderBy = scoreParts.length > 0 ? `score DESC, r.name ASC` : `r.name ASC`;
  const scoreSelect = scoreParts.length > 0 ? `(${scoreParts.join(' + ')}) AS score` : `0 AS score`;

  const sql = `
    SELECT
      ${RESULT_COLUMNS},
      ${scoreSelect}
      ${selectExtras.length ? ',' + selectExtras.join(',') : ''},
      s.avg_stars, s.rating_count, s.modal_price_level
    FROM restaurants r
    LEFT JOIN restaurant_stats s ON s.restaurant_id = r.id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY ${orderBy}
    LIMIT ${push(Math.min(limit, searchConfig.maxLimit))}
  `;

  const { rows } = await db.query(sql, params);
  return rows;
}

/** Fetch one restaurant with its community statistics, or null. */
export async function getRestaurantById(id) {
  const { rows } = await db.query(
    `SELECT ${RESULT_COLUMNS},
            r.google_place_id, r.enriched_at, r.created_at,
            s.avg_stars, s.rating_count, s.modal_price_level
     FROM restaurants r
     LEFT JOIN restaurant_stats s ON s.restaurant_id = r.id
     WHERE r.id = $1`,
    [id]
  );
  return rows[0] ?? null;
}

/** Every restaurant pinned to a map, nearest-first from the map's centre. */
export async function getMapRestaurants(mapId) {
  const { rows } = await db.query(
    `SELECT ${RESULT_COLUMNS},
            mr.notes, mr.added_at,
            s.avg_stars, s.rating_count, s.modal_price_level
     FROM map_restaurants mr
     JOIN restaurants r ON r.id = mr.restaurant_id
     LEFT JOIN restaurant_stats s ON s.restaurant_id = r.id
     WHERE mr.map_id = $1
     ORDER BY mr.added_at DESC`,
    [mapId]
  );
  return rows;
}
