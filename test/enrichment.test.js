/**
 * Enrichment parsing tests.
 *
 * The fixtures below use JSON-LD shapes that genuinely occur on restaurant
 * sites, including the awkward ones: @graph wrappers from Yoast, ImageObject
 * instead of a plain URL string, ratings on a 10-point scale, and malformed
 * blocks sitting next to valid ones.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractJsonLdNodes,
  findRestaurantNode,
  extractImageUrl,
  extractRating,
  extractCuisines,
  extractOpenGraph,
  extractFromHtml,
} from '../server/services/enrichment/structuredData.js';
import {
  normalizePriceLevel,
  amountToPriceLevel,
  priceLevelToSymbols,
} from '../server/services/enrichment/priceNormalizer.js';
import { backoffMs } from '../server/services/enrichment/politeness.js';

/** Wrap JSON-LD in a minimal page. */
const page = (jsonLd, extraHead = '') => `
<!doctype html><html><head>
<title>Test Restaurant</title>
${extraHead}
<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
</head><body><h1>Hello</h1></body></html>`;

// --- price normalisation ---------------------------------------------------

test('reads dollar-sign price tiers', () => {
  assert.equal(normalizePriceLevel('$'), 1);
  assert.equal(normalizePriceLevel('$$'), 2);
  assert.equal(normalizePriceLevel('$$$'), 3);
  assert.equal(normalizePriceLevel('$$$$'), 4);
});

test('takes the top of a tier range', () => {
  // "$$ - $$$" means it spans two tiers; the longest run represents the ceiling.
  assert.equal(normalizePriceLevel('$$ - $$$'), 3);
});

test('handles non-dollar currency symbols', () => {
  assert.equal(normalizePriceLevel('££'), 2);
  assert.equal(normalizePriceLevel('€€€'), 3);
});

test('converts numeric price ranges using the midpoint', () => {
  // Midpoint 17.50 -> tier 2 (thresholds 15/30/60).
  assert.equal(normalizePriceLevel('$10 - $25'), 2);
  // Midpoint 7.50 -> tier 1.
  assert.equal(normalizePriceLevel('$5-$10'), 1);
  // Midpoint 70 -> tier 4.
  assert.equal(normalizePriceLevel('$40 - $100'), 4);
  // No currency symbol at all.
  assert.equal(normalizePriceLevel('20-40'), 2);

  // Foreign currency with amounts. The midpoint of 5 and 25 is exactly 15,
  // which is the tier-1 ceiling, so this lands on 1. Boundary cases like this
  // are inherently arbitrary — retune ratings.priceLevelThresholdsUsd in
  // config.js if the split should fall elsewhere.
  assert.equal(normalizePriceLevel('£5 - £25'), 1);
});

test('handles a single amount and open-ended ranges', () => {
  assert.equal(normalizePriceLevel('Under $15'), 1);
  assert.equal(normalizePriceLevel('About $30'), 2);
  assert.equal(normalizePriceLevel('$15+'), 1);
});

test('reads word forms and Google enum values', () => {
  assert.equal(normalizePriceLevel('Moderate'), 2);
  assert.equal(normalizePriceLevel('Inexpensive'), 1);
  assert.equal(normalizePriceLevel('PRICE_LEVEL_MODERATE'), 2);
  assert.equal(normalizePriceLevel('PRICE_LEVEL_VERY_EXPENSIVE'), 4);
  // The longer phrase must win over the substring "expensive".
  assert.equal(normalizePriceLevel('Very Expensive'), 4);
});

test('passes through an existing numeric level and rejects nonsense', () => {
  assert.equal(normalizePriceLevel(3), 3);
  assert.equal(normalizePriceLevel(0), null);
  assert.equal(normalizePriceLevel(9), null);
  assert.equal(normalizePriceLevel(''), null);
  assert.equal(normalizePriceLevel('call for pricing'), null);
  assert.equal(normalizePriceLevel(null), null);
  assert.equal(normalizePriceLevel(undefined), null);
});

test('maps amounts onto tiers at the configured thresholds', () => {
  assert.equal(amountToPriceLevel(10), 1);
  assert.equal(amountToPriceLevel(15), 1);
  assert.equal(amountToPriceLevel(16), 2);
  assert.equal(amountToPriceLevel(30), 2);
  assert.equal(amountToPriceLevel(45), 3);
  assert.equal(amountToPriceLevel(200), 4);
  assert.equal(amountToPriceLevel(-5), null);
});

test('renders tiers as dollar signs', () => {
  assert.equal(priceLevelToSymbols(2), '$$');
  assert.equal(priceLevelToSymbols(4), '$$$$');
  assert.equal(priceLevelToSymbols(0), null);
});

// --- JSON-LD ---------------------------------------------------------------

test('finds a plain Restaurant node', () => {
  const html = page({
    '@context': 'https://schema.org',
    '@type': 'Restaurant',
    name: 'Guelaguetza',
    priceRange: '$$',
  });

  const node = findRestaurantNode(extractJsonLdNodes(html));
  assert.equal(node.name, 'Guelaguetza');
});

test('unwraps an @graph array', () => {
  // The shape Yoast and most WordPress SEO plugins emit.
  const html = page({
    '@context': 'https://schema.org',
    '@graph': [
      { '@type': 'WebSite', name: 'Some Site' },
      { '@type': 'BreadcrumbList', itemListElement: [] },
      { '@type': 'Restaurant', name: 'Found In Graph', priceRange: '$$$' },
    ],
  });

  const node = findRestaurantNode(extractJsonLdNodes(html));
  assert.equal(node.name, 'Found In Graph');
});

test('prefers the specific type over generic LocalBusiness', () => {
  const html = page([
    { '@type': 'LocalBusiness', name: 'Generic Entry' },
    { '@type': 'Restaurant', name: 'Specific Entry' },
  ]);

  const node = findRestaurantNode(extractJsonLdNodes(html));
  assert.equal(node.name, 'Specific Entry');
});

test('handles @type given as an array', () => {
  const html = page({ '@type': ['LocalBusiness', 'Restaurant'], name: 'Multi Type' });
  assert.equal(findRestaurantNode(extractJsonLdNodes(html)).name, 'Multi Type');
});

test('a malformed block does not discard the valid one beside it', () => {
  const html = `<!doctype html><html><head>
    <script type="application/ld+json">{ this is not valid json ]</script>
    <script type="application/ld+json">${JSON.stringify({ '@type': 'Restaurant', name: 'Survivor' })}</script>
  </head><body></body></html>`;

  assert.equal(findRestaurantNode(extractJsonLdNodes(html)).name, 'Survivor');
});

test('returns null when nothing describes a restaurant', () => {
  const html = page({ '@type': 'WebSite', name: 'Just A Site' });
  assert.equal(findRestaurantNode(extractJsonLdNodes(html)), null);
  assert.equal(findRestaurantNode([]), null);
});

// --- individual fields -----------------------------------------------------

test('extracts an image from all three permitted shapes', () => {
  assert.equal(extractImageUrl('https://x.com/a.jpg'), 'https://x.com/a.jpg');
  assert.equal(extractImageUrl(['https://x.com/1.jpg', 'https://x.com/2.jpg']), 'https://x.com/1.jpg');
  assert.equal(
    extractImageUrl({ '@type': 'ImageObject', url: 'https://x.com/obj.jpg' }),
    'https://x.com/obj.jpg'
  );
  assert.equal(extractImageUrl({ contentUrl: 'https://x.com/c.jpg' }), 'https://x.com/c.jpg');
  assert.equal(extractImageUrl(null), null);
  assert.equal(extractImageUrl({}), null);
});

test('parses aggregateRating including string numbers', () => {
  assert.deepEqual(extractRating({ ratingValue: 4.5, reviewCount: 320 }), {
    rating: 4.5,
    ratingCount: 320,
  });

  // Values arrive as strings surprisingly often.
  assert.deepEqual(extractRating({ ratingValue: '4.2', reviewCount: '87' }), {
    rating: 4.2,
    ratingCount: 87,
  });

  assert.equal(extractRating({ ratingValue: 4.5, ratingCount: 12 }).ratingCount, 12);
});

test('rescales a rating that is not out of 5', () => {
  // 8/10 is 4/5.
  assert.equal(extractRating({ ratingValue: 8, bestRating: 10 }).rating, 4);
  assert.equal(extractRating({ ratingValue: 90, bestRating: 100 }).rating, 4.5);
});

test('rejects an unparseable rating', () => {
  assert.equal(extractRating({ ratingValue: 'excellent' }).rating, null);
  assert.equal(extractRating(null).rating, null);
  assert.equal(extractRating({}).rating, null);
});

test('splits servesCuisine however it is written', () => {
  assert.deepEqual(extractCuisines('Mexican, Oaxacan'), ['mexican', 'oaxacan']);
  assert.deepEqual(extractCuisines(['Italian', 'Pizza']), ['italian', 'pizza']);
  assert.deepEqual(extractCuisines('Thai'), ['thai']);
  assert.deepEqual(extractCuisines(null), []);
});

test('reads Open Graph and twitter meta tags', () => {
  const html = `<!doctype html><html><head>
    <meta property="og:image" content="https://x.com/photo.jpg">
    <meta property="og:description" content="Best tacos in LA">
    <meta property="og:title" content="Taco Place">
  </head><body></body></html>`;

  const og = extractOpenGraph(html);
  assert.equal(og.image, 'https://x.com/photo.jpg');
  assert.equal(og.description, 'Best tacos in LA');
  assert.equal(og.title, 'Taco Place');
});

// --- full extraction -------------------------------------------------------

test('extracts everything from a rich page', () => {
  const html = page(
    {
      '@context': 'https://schema.org',
      '@type': 'Restaurant',
      name: 'Guelaguetza',
      priceRange: '$$',
      servesCuisine: ['Oaxacan', 'Mexican'],
      description: 'Award-winning   Oaxacan\n  cooking in Koreatown.',
      image: { '@type': 'ImageObject', url: '/img/dining-room.jpg' },
      aggregateRating: { '@type': 'AggregateRating', ratingValue: '4.4', reviewCount: '2841' },
    },
    '<meta property="og:image" content="https://example.com/og.jpg">'
  );

  const result = extractFromHtml(html, 'https://guelaguetza.example.com/about');

  assert.equal(result.rating, 4.4);
  assert.equal(result.ratingCount, 2841);
  assert.equal(result.priceLevel, 2);
  // Relative image resolved against the page URL.
  assert.equal(result.photoUrl, 'https://guelaguetza.example.com/img/dining-room.jpg');
  // Whitespace collapsed.
  assert.equal(result.description, 'Award-winning Oaxacan cooking in Koreatown.');
  assert.deepEqual(result.cuisines, ['oaxacan', 'mexican']);
  assert.equal(result.source, 'website');
  assert.ok(result.found.includes('jsonld:rating'));
});

test('falls back to og:image when JSON-LD has no image', () => {
  const html = page(
    { '@type': 'Restaurant', name: 'No Image In Schema', priceRange: '$' },
    '<meta property="og:image" content="https://example.com/social.jpg">'
  );

  const result = extractFromHtml(html, 'https://example.com/');
  assert.equal(result.photoUrl, 'https://example.com/social.jpg');
  assert.ok(result.found.includes('og:image'));
});

test('a page with only Open Graph still yields a photo and description', () => {
  // The common case: no JSON-LD at all, but social tags present. This is why
  // photo coverage runs well ahead of rating coverage.
  const html = `<!doctype html><html><head>
    <meta property="og:image" content="https://example.com/food.jpg">
    <meta name="description" content="Neighbourhood pizza since 1974.">
  </head><body></body></html>`;

  const result = extractFromHtml(html, 'https://example.com/');
  assert.equal(result.photoUrl, 'https://example.com/food.jpg');
  assert.equal(result.description, 'Neighbourhood pizza since 1974.');
  assert.equal(result.rating, null, 'no rating is available from Open Graph');
});

test('an empty or junk page yields nothing rather than throwing', () => {
  for (const input of ['', '<html></html>', null, undefined]) {
    const result = extractFromHtml(input, 'https://example.com/');
    assert.equal(result.rating, null);
    assert.equal(result.photoUrl, null);
    assert.deepEqual(result.found, []);
  }
});

test('truncates an overlong description', () => {
  const html = page({ '@type': 'Restaurant', name: 'Wordy', description: 'x'.repeat(900) });
  const result = extractFromHtml(html, 'https://example.com/');
  assert.ok(result.description.length <= 500);
  assert.ok(result.description.endsWith('…'));
});

// --- backoff ---------------------------------------------------------------

test('backoff grows exponentially and is capped', () => {
  assert.ok(backoffMs(2) > backoffMs(1));
  assert.ok(backoffMs(3) > backoffMs(2));
  assert.ok(backoffMs(50) <= 6 * 60 * 60 * 1000, 'never schedules a retry years away');
});
