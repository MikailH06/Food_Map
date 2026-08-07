/**
 * Measure how much the enrichment crawler can actually find.
 *
 * This exists because the honest answer to "how many restaurants publish a
 * rating in their structured data?" was unknown — no reliable adoption figures
 * are published for restaurant schema markup. Rather than guess, measure.
 *
 * The result decides how much weight the community rating layer has to carry.
 *
 *   npm run measure                 sample 100 restaurants
 *   npm run measure -- --sample 500 sample more
 *   npm run measure -- --json out.json  save per-site detail
 *
 * Be considerate: this fetches one page per restaurant from real websites.
 * politeness.js applies throughout — robots.txt is honoured, requests are
 * spaced per domain, and the crawler identifies itself.
 */

import { writeFile } from 'node:fs/promises';
import * as db from '../server/db/pool.js';
import { politeFetch } from '../server/services/enrichment/politeness.js';
import { extractFromHtml } from '../server/services/enrichment/structuredData.js';
import { enrichment } from '../server/config.js';

function parseArgs(argv) {
  const sampleIndex = argv.indexOf('--sample');
  const jsonIndex = argv.indexOf('--json');
  return {
    sample: sampleIndex !== -1 ? Number.parseInt(argv[sampleIndex + 1], 10) : 100,
    json: jsonIndex !== -1 ? argv[jsonIndex + 1] : null,
  };
}

function pct(n, total) {
  return total === 0 ? '0.0' : ((n / total) * 100).toFixed(1);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  await db.init();

  const total = await db.query('SELECT count(*)::int AS c FROM restaurants');
  const withSite = await db.query(
    'SELECT count(*)::int AS c FROM restaurants WHERE website IS NOT NULL'
  );

  console.log(`\nCatalog: ${total.rows[0].c} restaurants`);
  console.log(
    `Have a website: ${withSite.rows[0].c} (${pct(withSite.rows[0].c, total.rows[0].c)}%) ` +
      `— the hard ceiling on what this layer can ever reach\n`
  );

  // Sample across distinct domains where possible, so a chain with 200
  // identical franchise pages cannot dominate the result.
  const { rows: sample } = await db.query(
    `SELECT DISTINCT ON (split_part(regexp_replace(website, '^https?://', ''), '/', 1))
            id, name, website
     FROM restaurants
     WHERE website IS NOT NULL
     ORDER BY split_part(regexp_replace(website, '^https?://', ''), '/', 1), random()
     LIMIT $1`,
    [args.sample]
  );

  console.log(`Sampling ${sample.length} restaurants across distinct domains...\n`);

  const stats = {
    attempted: 0,
    fetched: 0,
    failed: 0,
    blockedByRobots: 0,
    hasJsonLd: 0,
    hasRating: 0,
    hasPrice: 0,
    hasPhoto: 0,
    hasDescription: 0,
    anythingUseful: 0,
  };

  const details = [];
  const failures = new Map();

  // Bounded concurrency across different domains.
  const queue = [...sample];
  const runners = Array.from({ length: enrichment.concurrency }, async () => {
    for (;;) {
      const restaurant = queue.shift();
      if (!restaurant) return;

      stats.attempted += 1;

      try {
        const { html, finalUrl } = await politeFetch(restaurant.website);
        const found = extractFromHtml(html, finalUrl);
        stats.fetched += 1;

        if (found.found.includes('jsonld')) stats.hasJsonLd += 1;
        if (found.rating !== null) stats.hasRating += 1;
        if (found.priceLevel !== null) stats.hasPrice += 1;
        if (found.photoUrl) stats.hasPhoto += 1;
        if (found.description) stats.hasDescription += 1;
        if (found.rating !== null || found.priceLevel !== null || found.photoUrl) {
          stats.anythingUseful += 1;
        }

        details.push({
          name: restaurant.name,
          website: restaurant.website,
          rating: found.rating,
          ratingCount: found.ratingCount,
          priceLevel: found.priceLevel,
          hasPhoto: Boolean(found.photoUrl),
          found: found.found,
        });
      } catch (err) {
        stats.failed += 1;
        const reason = err.message.includes('robots')
          ? 'blocked by robots.txt'
          : err.message.slice(0, 60);
        if (reason.includes('robots')) stats.blockedByRobots += 1;
        failures.set(reason, (failures.get(reason) ?? 0) + 1);
      }

      const done = stats.attempted;
      if (done % 10 === 0) process.stdout.write(`\r  ${done}/${sample.length} checked`);
    }
  });

  const started = Date.now();
  await Promise.all(runners);
  const elapsed = ((Date.now() - started) / 1000).toFixed(0);
  process.stdout.write('\r'.padEnd(40) + '\r');

  const f = stats.fetched;
  console.log(`Completed in ${elapsed}s\n`);
  console.log(`  Fetched successfully   ${f}/${stats.attempted} (${pct(f, stats.attempted)}%)`);
  console.log(`  Failed                 ${stats.failed} (${stats.blockedByRobots} blocked by robots.txt)`);
  console.log('\nOf the pages we could read:');
  console.log(`  Any JSON-LD at all     ${stats.hasJsonLd} (${pct(stats.hasJsonLd, f)}%)`);
  console.log(`  Photo                  ${stats.hasPhoto} (${pct(stats.hasPhoto, f)}%)`);
  console.log(`  Description            ${stats.hasDescription} (${pct(stats.hasDescription, f)}%)`);
  console.log(`  Price range            ${stats.hasPrice} (${pct(stats.hasPrice, f)}%)`);
  console.log(`  RATING                 ${stats.hasRating} (${pct(stats.hasRating, f)}%)  <-- the go/no-go number`);
  console.log(`  Anything useful        ${stats.anythingUseful} (${pct(stats.anythingUseful, f)}%)`);

  if (failures.size > 0) {
    console.log('\nWhy fetches failed:');
    for (const [reason, count] of [...failures].sort((a, b) => b[1] - a[1]).slice(0, 8)) {
      console.log(`  ${String(count).padStart(4)}  ${reason}`);
    }
  }

  // Project the sample onto the whole catalog.
  const reachable = withSite.rows[0].c;
  const ratingRate = f > 0 ? stats.hasRating / f : 0;
  const photoRate = f > 0 ? stats.hasPhoto / f : 0;
  const fetchRate = stats.attempted > 0 ? stats.fetched / stats.attempted : 0;

  console.log('\nProjected across the whole catalog:');
  console.log(
    `  ~${Math.round(reachable * fetchRate * photoRate)} restaurants would get a photo ` +
      `(${pct(reachable * fetchRate * photoRate, total.rows[0].c)}% of the catalog)`
  );
  console.log(
    `  ~${Math.round(reachable * fetchRate * ratingRate)} would get a rating ` +
      `(${pct(reachable * fetchRate * ratingRate, total.rows[0].c)}% of the catalog)`
  );

  if (args.json) {
    await writeFile(args.json, JSON.stringify({ stats, details }, null, 2));
    console.log(`\nPer-site detail written to ${args.json}`);
  }

  const withRating = details.filter((d) => d.rating !== null).slice(0, 8);
  if (withRating.length > 0) {
    console.log('\nExamples that yielded a rating:');
    for (const d of withRating) {
      console.log(
        `  ${d.rating}★ ${d.ratingCount ? `(${d.ratingCount} reviews)` : ''} ` +
          `${d.priceLevel ? '$'.repeat(d.priceLevel) : ''}  ${d.name}`
      );
    }
  }
}

main()
  .then(() => db.close())
  .then(() => process.exit(0))
  .catch(async (err) => {
    console.error(`\nfailed: ${err.message}`);
    await db.close().catch(() => {});
    process.exit(1);
  });
