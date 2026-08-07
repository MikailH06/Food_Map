/**
 * Seed the restaurant catalog from OpenStreetMap.
 *
 * Pulls every restaurant, fast-food place and cafe in the configured area from
 * the Overpass API and upserts it into the restaurants table. Because search
 * then runs against our own Postgres, the quick-add box answers in
 * milliseconds with no external quota, no rate limit and no per-request cost.
 *
 * Safe to re-run: rows are keyed on (source, source_id), so a second run
 * refreshes existing restaurants rather than duplicating them.
 *
 * Usage:
 *   npm run seed                  import into the database
 *   npm run seed -- --dry-run     fetch and report, write nothing
 *   npm run seed -- --bbox        use the bounding box instead of the county boundary
 *   npm run seed -- --limit 500   stop after N rows (useful for a quick test)
 *   npm run seed -- --save x.json cache the raw Overpass response to disk
 *   npm run seed -- --file x.json import from a cached response, no network
 *
 * Overpass is free and donation-funded. Prefer --save once followed by --file
 * over repeatedly re-running the live query.
 */

import { readFile, writeFile } from 'node:fs/promises';
import * as db from '../server/db/pool.js';
import { catalog, geography } from '../server/config.js';
import { buildOverpassQuery, elementsToRestaurants } from '../server/services/osm.js';

function parseArgs(argv) {
  const args = {
    dryRun: argv.includes('--dry-run'),
    useBbox: argv.includes('--bbox'),
    limit: null,
    file: null,
    save: null,
  };

  const saveIndex = argv.indexOf('--save');
  if (saveIndex !== -1 && argv[saveIndex + 1]) {
    args.save = argv[saveIndex + 1];
  }

  const limitIndex = argv.indexOf('--limit');
  if (limitIndex !== -1 && argv[limitIndex + 1]) {
    args.limit = Number.parseInt(argv[limitIndex + 1], 10);
  }

  const fileIndex = argv.indexOf('--file');
  if (fileIndex !== -1 && argv[fileIndex + 1]) {
    args.file = argv[fileIndex + 1];
  }

  return args;
}

/**
 * Ask Overpass for the data.
 *
 * This is a heavy query against a free, donation-funded service, so it runs
 * once and its result is reused. Be a good citizen: don't loop it.
 */
async function fetchFromOverpass(query) {
  console.log(`[seed] querying ${catalog.overpassUrl}`);
  console.log(`[seed] this usually takes 30-90 seconds for a county-sized area`);

  const started = Date.now();
  const response = await fetch(catalog.overpassUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'FoodMapSeeder/1.0 (+https://github.com/MikailH06/Food_Map)',
    },
    body: new URLSearchParams({ data: query }),
    // The query itself can legitimately run for minutes.
    signal: AbortSignal.timeout((catalog.overpassTimeoutSeconds + 60) * 1000),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(
      `Overpass returned ${response.status} ${response.statusText}. ` +
        `This is usually rate limiting or server load — wait a minute and retry.\n${body.slice(0, 500)}`
    );
  }

  const json = await response.json();
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`[seed] received ${json.elements?.length ?? 0} elements in ${seconds}s`);
  return json;
}

/**
 * Upsert a batch of restaurants.
 *
 * The ON CONFLICT target repeats the partial index's WHERE clause because
 * Postgres will not match a partial unique index without it.
 *
 * Enrichment columns are deliberately NOT overwritten: a re-seed refreshes
 * facts that came from OSM and leaves everything the crawler discovered alone.
 */
async function upsertBatch(rows) {
  if (rows.length === 0) return 0;

  const columns = [
    'source',
    'source_id',
    'name',
    'address_line1',
    'city',
    'state',
    'postal_code',
    'lat',
    'lng',
    'cuisines',
    'phone',
    'website',
    'opening_hours',
  ];

  const values = [];
  const placeholders = rows.map((row, rowIndex) => {
    const offset = rowIndex * columns.length;
    values.push(...columns.map((c) => row[c]));
    return `(${columns.map((_, i) => `$${offset + i + 1}`).join(', ')})`;
  });

  const sql = `
    INSERT INTO restaurants (${columns.join(', ')})
    VALUES ${placeholders.join(', ')}
    ON CONFLICT (source, source_id) WHERE source_id IS NOT NULL
    DO UPDATE SET
      name          = EXCLUDED.name,
      address_line1 = EXCLUDED.address_line1,
      city          = EXCLUDED.city,
      state         = EXCLUDED.state,
      postal_code   = EXCLUDED.postal_code,
      lat           = EXCLUDED.lat,
      lng           = EXCLUDED.lng,
      cuisines      = EXCLUDED.cuisines,
      phone         = EXCLUDED.phone,
      website       = EXCLUDED.website,
      opening_hours = EXCLUDED.opening_hours
  `;

  const result = await db.query(sql, values);
  return result.rowCount;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const query = buildOverpassQuery({
    bounds: args.useBbox ? geography.bounds : null,
  });

  console.log('[seed] Overpass query:');
  console.log(
    query
      .split('\n')
      .map((l) => `         ${l}`)
      .join('\n')
  );

  const payload = args.file
    ? JSON.parse(await readFile(args.file, 'utf8'))
    : await fetchFromOverpass(query);

  if (args.save && !args.file) {
    await writeFile(args.save, JSON.stringify(payload));
    console.log(`[seed] cached raw response to ${args.save}`);
  }

  const { rows, skipped } = elementsToRestaurants(payload.elements);

  console.log(`[seed] usable restaurants: ${rows.length}`);
  console.log(
    `[seed] skipped: ${skipped.unnamed} unnamed, ${skipped.noCoords} without coordinates, ` +
      `${skipped.outOfBounds} outside bounds, ${skipped.duplicate} duplicates`
  );

  const withWebsite = rows.filter((r) => r.website).length;
  const pct = rows.length ? ((withWebsite / rows.length) * 100).toFixed(1) : '0';
  // This number sets the ceiling on what the enrichment crawler can ever find:
  // no website means no structured data to read.
  console.log(`[seed] have a website: ${withWebsite} (${pct}%) — the enrichment crawler's ceiling`);

  const selected = args.limit ? rows.slice(0, args.limit) : rows;

  if (args.dryRun) {
    console.log(`\n[seed] DRY RUN — nothing written. Sample of what would be inserted:`);
    for (const row of selected.slice(0, 5)) {
      console.log(
        `  ${row.name} | ${row.address_line1 ?? '(no street)'}, ${row.city ?? '(no city)'} | ` +
          `${row.cuisines.join(', ') || '(no cuisine)'} | ${row.website ?? '(no website)'}`
      );
    }
    return;
  }

  await db.init();

  let written = 0;
  for (let i = 0; i < selected.length; i += catalog.seedBatchSize) {
    const batch = selected.slice(i, i + catalog.seedBatchSize);
    written += await upsertBatch(batch);
    process.stdout.write(`\r[seed] upserted ${Math.min(i + batch.length, selected.length)}/${selected.length}`);
  }
  process.stdout.write('\n');

  const total = await db.query(`SELECT count(*)::int AS c FROM restaurants WHERE source = 'osm'`);
  console.log(`[seed] done — ${written} rows written, ${total.rows[0].c} OSM restaurants in total`);
}

main()
  .then(() => db.close())
  .then(() => process.exit(0))
  .catch(async (err) => {
    console.error(`\n[seed] failed: ${err.message}`);
    await db.close().catch(() => {});
    process.exit(1);
  });
