/**
 * The three-layer resolver.
 *
 * Every displayed field is resolved independently, taking the first layer that
 * actually has a value:
 *
 *   1. Google        real ratings, prices and photos — only when a key is set
 *   2. Website       what the restaurant publishes about itself in JSON-LD / OG
 *   3. Community     what this app's own users have contributed
 *
 * Resolution is PER FIELD, not per record. A restaurant can legitimately show a
 * community rating alongside a photo pulled from its website, and that is the
 * normal case rather than an edge case.
 *
 * Measured reality, which is why the layering matters (200 real LA restaurant
 * sites, see scripts/measure-enrichment.js):
 *
 *   description  71.3%  from the website
 *   photo        62.9%  from the website
 *   price         7.7%  from the website
 *   rating        0.7%  from the website  <- so ratings are community-driven
 *
 * Ratings are near-absent from restaurant websites for a structural reason:
 * Google's 2019 policy made self-serving aggregateRating ineligible for star
 * rich results, so sites stopped publishing it. Setting GOOGLE_MAPS_API_KEY
 * moves ratings to layer 1 and fixes this — no code change required.
 *
 * Every resolved field carries the layer it came from, so the interface can
 * attribute it honestly instead of implying all ratings are equivalent.
 */

import { priceLevelToSymbols } from './enrichment/priceNormalizer.js';

/** @typedef {'google'|'website'|'community'|'owner'} SourceLayer */

/**
 * Resolve a restaurant row (as returned by the search service, joined against
 * restaurant_stats) into what the interface should display.
 *
 * @param {object} row
 * @param {object} [extra]
 * @param {string|null} [extra.userPhotoUrl] a photo uploaded by a user
 * @param {object|null} [extra.viewerRating] this viewer's own rating, if any
 */
export function resolveRestaurant(row, { userPhotoUrl = null, viewerRating = null } = {}) {
  if (!row) return null;

  return {
    id: row.id,
    name: row.name,

    address: {
      line1: row.address_line1 ?? null,
      city: row.city ?? null,
      state: row.state ?? null,
      postalCode: row.postal_code ?? null,
      // Pre-joined for display, so the interface never has to assemble it.
      full: [row.address_line1, row.city, row.state].filter(Boolean).join(', ') || null,
    },

    // Coordinates are needed to place the pin, but the user never types them.
    position: { lat: row.lat, lng: row.lng },

    cuisines: row.cuisines ?? [],
    phone: row.phone ?? null,
    website: row.website ?? null,
    openingHours: row.opening_hours ?? null,

    rating: resolveRating(row),
    price: resolvePrice(row),
    photo: resolvePhoto(row, userPhotoUrl),
    description: resolveDescription(row),

    // What this particular viewer said, so the UI can show their own stars
    // filled in rather than an empty form.
    yourRating: viewerRating
      ? {
          stars: viewerRating.stars,
          priceLevel: viewerRating.price_level ?? null,
          comment: viewerRating.comment ?? null,
        }
      : null,

    meta: {
      source: row.source,
      enrichStatus: row.enrich_status ?? null,
      enrichedAt: row.enriched_at ?? null,
      addedAt: row.added_at ?? null,
      notes: row.notes ?? null,
      distanceMeters: row.distance_meters ?? null,
    },
  };
}

/**
 * Rating: external (Google or website) wins over community, because an
 * aggregate over thousands of reviews beats an aggregate over three.
 */
function resolveRating(row) {
  if (row.ext_rating !== null && row.ext_rating !== undefined) {
    return {
      value: Number(row.ext_rating),
      count: row.ext_rating_count ?? null,
      source: row.ext_source ?? 'website',
    };
  }

  if (row.avg_stars !== null && row.avg_stars !== undefined) {
    return {
      value: Number(row.avg_stars),
      count: row.rating_count ?? 0,
      source: 'community',
    };
  }

  // Distinguished from a zero rating: nobody has said anything yet.
  return null;
}

function resolvePrice(row) {
  const level = row.ext_price_level ?? row.modal_price_level ?? null;
  if (level === null || level === undefined) return null;

  const numeric = Number(level);
  return {
    level: numeric,
    symbols: priceLevelToSymbols(numeric),
    source: row.ext_price_level ? (row.ext_source ?? 'website') : 'community',
  };
}

/**
 * Photo: a user-uploaded picture outranks anything scraped.
 *
 * og:image is the most commonly available source but is frequently the
 * restaurant's logo rather than its food, so a photo a human deliberately
 * uploaded is the better choice when one exists.
 */
function resolvePhoto(row, userPhotoUrl) {
  if (userPhotoUrl) {
    return { url: userPhotoUrl, source: 'community' };
  }

  if (row.ext_photo_url) {
    return { url: row.ext_photo_url, source: row.ext_source ?? 'website' };
  }

  // The interface falls back to a cuisine-based placeholder.
  return null;
}

function resolveDescription(row) {
  if (!row.ext_description) return null;
  return { text: row.ext_description, source: row.ext_source ?? 'website' };
}

/** Resolve a list, attaching each restaurant's user photo and viewer rating. */
export function resolveMany(rows, { photosByRestaurant = new Map(), ratingsByRestaurant = new Map() } = {}) {
  return rows.map((row) =>
    resolveRestaurant(row, {
      userPhotoUrl: photosByRestaurant.get(row.id) ?? null,
      viewerRating: ratingsByRestaurant.get(row.id) ?? null,
    })
  );
}
