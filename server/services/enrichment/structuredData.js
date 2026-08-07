/**
 * Structured-data extraction.
 *
 * Reads the machine-readable description a restaurant publishes about ITSELF on
 * its own website — schema.org JSON-LD and Open Graph tags. This is data the
 * business deliberately emits for search engines to consume; reading it is the
 * documented purpose of the markup, not scraping of a third party.
 *
 * It is also stable in a way that scraping is not: the schema is a published
 * standard, so a site redesign does not break us the way a changed CSS class
 * would.
 *
 * What it can find, in rough order of how often it appears:
 *
 *   og:image / image     a real photo of the place
 *   description          a sentence or two about it
 *   priceRange           "$$" or "$15 - $30"
 *   aggregateRating      rating value and review count
 *   servesCuisine        cuisine tags
 *
 * Pure parsing only — no network. The fetching, robots.txt checks and rate
 * limiting live in politeness.js, so this file is testable against fixtures.
 */

import * as cheerio from 'cheerio';
import { enrichment } from '../../config.js';
import { normalizePriceLevel } from './priceNormalizer.js';

/**
 * Pull every JSON-LD object out of a document.
 *
 * Sites nest these in several shapes: a bare object, an array of objects, or —
 * most commonly on WordPress and Yoast-powered sites — an `@graph` array
 * holding a dozen loosely related nodes. All three are flattened here.
 */
export function extractJsonLdNodes(html) {
  const $ = cheerio.load(html);
  const nodes = [];

  $('script[type="application/ld+json"]').each((_, element) => {
    const raw = $(element).contents().text().trim();
    if (!raw) return;

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Hand-written JSON-LD is frequently malformed. One bad block should not
      // discard the valid ones alongside it.
      return;
    }

    const visit = (node) => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) {
        node.forEach(visit);
        return;
      }
      nodes.push(node);
      if (Array.isArray(node['@graph'])) node['@graph'].forEach(visit);
    };

    visit(parsed);
  });

  return nodes;
}

/** Normalise `@type`, which may be a string or an array, to a lowercase list. */
function typesOf(node) {
  const type = node['@type'];
  if (!type) return [];
  return (Array.isArray(type) ? type : [type]).map((t) => String(t).toLowerCase());
}

/**
 * Find the node that describes the restaurant.
 *
 * Prefers a specific type (`Restaurant`) over the generic `LocalBusiness`,
 * because a page can carry both and the specific one is the better source.
 */
export function findRestaurantNode(nodes) {
  const accepted = enrichment.acceptedSchemaTypes.map((t) => t.toLowerCase());
  const matches = nodes.filter((node) => typesOf(node).some((t) => accepted.includes(t)));

  if (matches.length === 0) return null;

  // Rank by how early the type appears in the configured list, which is
  // ordered most-specific first.
  const rank = (node) => {
    const positions = typesOf(node)
      .map((t) => accepted.indexOf(t))
      .filter((i) => i !== -1);
    return positions.length ? Math.min(...positions) : Number.MAX_SAFE_INTEGER;
  };

  // Among equals, prefer the node carrying an aggregateRating — that is the
  // field we can least often get elsewhere.
  return matches.sort((a, b) => {
    const byRank = rank(a) - rank(b);
    if (byRank !== 0) return byRank;
    return (b.aggregateRating ? 1 : 0) - (a.aggregateRating ? 1 : 0);
  })[0];
}

/**
 * Extract an image URL.
 *
 * schema.org allows a string, an array, or an ImageObject with a `url`.
 */
export function extractImageUrl(value) {
  if (!value) return null;

  if (typeof value === 'string') return value.trim() || null;

  if (Array.isArray(value)) {
    for (const entry of value) {
      const url = extractImageUrl(entry);
      if (url) return url;
    }
    return null;
  }

  if (typeof value === 'object') {
    return extractImageUrl(value.url ?? value.contentUrl ?? null);
  }

  return null;
}

/** Parse aggregateRating into a value and a count, tolerating string numbers. */
export function extractRating(aggregate) {
  if (!aggregate || typeof aggregate !== 'object') return { rating: null, ratingCount: null };

  const rating = Number.parseFloat(aggregate.ratingValue);
  if (!Number.isFinite(rating)) return { rating: null, ratingCount: null };

  // Almost always out of 5, but a handful of sites use 10 or 100.
  const best = Number.parseFloat(aggregate.bestRating ?? 5);
  const scale = Number.isFinite(best) && best > 0 ? best : 5;
  const normalized = (rating / scale) * 5;

  if (normalized < 0 || normalized > 5) return { rating: null, ratingCount: null };

  const countRaw = aggregate.reviewCount ?? aggregate.ratingCount;
  const count = Number.parseInt(countRaw, 10);

  return {
    rating: Math.round(normalized * 10) / 10,
    ratingCount: Number.isFinite(count) && count >= 0 ? count : null,
  };
}

/** schema.org `servesCuisine` may be a string, a comma list, or an array. */
export function extractCuisines(value) {
  if (!value) return [];

  const list = Array.isArray(value) ? value : String(value).split(',');
  return [
    ...new Set(
      list
        .map((c) => String(c).trim().toLowerCase())
        .filter((c) => c && c.length <= 50)
    ),
  ];
}

/** Resolve a possibly-relative URL against the page it came from. */
function absoluteUrl(url, baseUrl) {
  if (!url) return null;
  try {
    return new URL(url, baseUrl).toString();
  } catch {
    return null;
  }
}

/** Collapse whitespace and cap length so descriptions stay presentable. */
function cleanText(text, maxLength = 500) {
  if (!text || typeof text !== 'string') return null;
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (!collapsed) return null;
  return collapsed.length > maxLength ? `${collapsed.slice(0, maxLength - 1)}…` : collapsed;
}

/**
 * Read Open Graph and standard meta tags.
 *
 * These are the fallback, and in practice the most reliably present source of a
 * photo: a restaurant site with no JSON-LD at all usually still has og:image
 * because social sharing depends on it.
 */
export function extractOpenGraph(html) {
  const $ = cheerio.load(html);

  const meta = (selector) => $(selector).attr('content')?.trim() || null;

  return {
    image:
      meta('meta[property="og:image"]') ??
      meta('meta[property="og:image:url"]') ??
      meta('meta[name="twitter:image"]'),
    description:
      meta('meta[property="og:description"]') ??
      meta('meta[name="description"]') ??
      meta('meta[name="twitter:description"]'),
    title: meta('meta[property="og:title"]') ?? cleanText($('title').first().text(), 200),
  };
}

/**
 * Extract everything usable from one page.
 *
 * @param {string} html
 * @param {string} baseUrl  the URL the HTML came from, for resolving relative links
 * @returns {{
 *   rating: number|null, ratingCount: number|null, priceLevel: number|null,
 *   photoUrl: string|null, description: string|null, cuisines: string[],
 *   source: 'website', found: string[]
 * }}
 */
export function extractFromHtml(html, baseUrl) {
  const result = {
    rating: null,
    ratingCount: null,
    priceLevel: null,
    photoUrl: null,
    description: null,
    cuisines: [],
    source: 'website',
    // Which fields came from where — used by the coverage measurement and
    // useful when a result looks wrong.
    found: [],
  };

  if (!html || typeof html !== 'string') return result;

  // --- schema.org JSON-LD (richest source) --------------------------------
  const node = findRestaurantNode(extractJsonLdNodes(html));

  if (node) {
    result.found.push('jsonld');

    const { rating, ratingCount } = extractRating(node.aggregateRating);
    if (rating !== null) {
      result.rating = rating;
      result.ratingCount = ratingCount;
      result.found.push('jsonld:rating');
    }

    const priceLevel = normalizePriceLevel(node.priceRange);
    if (priceLevel !== null) {
      result.priceLevel = priceLevel;
      result.found.push('jsonld:price');
    }

    const image = absoluteUrl(extractImageUrl(node.image), baseUrl);
    if (image) {
      result.photoUrl = image;
      result.found.push('jsonld:image');
    }

    const description = cleanText(node.description);
    if (description) {
      result.description = description;
      result.found.push('jsonld:description');
    }

    const cuisines = extractCuisines(node.servesCuisine);
    if (cuisines.length > 0) {
      result.cuisines = cuisines;
      result.found.push('jsonld:cuisine');
    }
  }

  // --- Open Graph fallback -------------------------------------------------
  const og = extractOpenGraph(html);

  if (!result.photoUrl) {
    const image = absoluteUrl(og.image, baseUrl);
    if (image) {
      result.photoUrl = image;
      result.found.push('og:image');
    }
  }

  if (!result.description) {
    const description = cleanText(og.description);
    if (description) {
      result.description = description;
      result.found.push('og:description');
    }
  }

  return result;
}
