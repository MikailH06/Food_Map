/**
 * Migration runner.
 *
 * Applies every .sql file in migrations/ in filename order, exactly once,
 * recording what it has applied in a schema_migrations table.
 *
 * Deliberately not an ORM. Migrations are plain SQL, so you can read them,
 * hand-edit them, or paste one straight into the Supabase SQL editor if
 * something needs fixing in production.
 *
 * Usage:
 *   npm run migrate            apply pending migrations
 *   npm run migrate -- --status  list applied / pending without changing anything
 */

import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import * as db from './pool.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

/** Escape a string for safe inlining into SQL. */
function quote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

async function ensureMigrationsTable() {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    text PRIMARY KEY,
      name       text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    );
  `);
}

/** All migration files on disk, sorted by their numeric prefix. */
async function loadMigrations() {
  const entries = await readdir(MIGRATIONS_DIR);
  return entries
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((file) => ({
      // "001_initial_schema.sql" -> version "001"
      version: file.split('_')[0],
      name: file,
      file: path.join(MIGRATIONS_DIR, file),
    }));
}

async function appliedVersions() {
  const { rows } = await db.query('SELECT version FROM schema_migrations');
  return new Set(rows.map((r) => r.version));
}

/**
 * Apply one migration inside a transaction.
 *
 * The whole file is sent as a single multi-statement query rather than being
 * split on semicolons — migrations contain dollar-quoted function bodies whose
 * internal semicolons would be shredded by naive splitting. Postgres DDL is
 * transactional, so a failure part-way leaves the schema untouched.
 */
async function apply(migration) {
  const sql = await readFile(migration.file, 'utf8');

  const wrapped = [
    'BEGIN;',
    sql,
    `INSERT INTO schema_migrations (version, name) VALUES (${quote(migration.version)}, ${quote(migration.name)});`,
    'COMMIT;',
  ].join('\n');

  try {
    await db.exec(wrapped);
  } catch (err) {
    // Leave the connection usable so a later migration or the status command
    // can still run; without this the session stays in an aborted state.
    try {
      await db.exec('ROLLBACK;');
    } catch {
      // Already rolled back by the failed COMMIT — nothing to recover.
    }
    throw new Error(`Migration ${migration.name} failed: ${err.message}`);
  }
}

/**
 * Apply all pending migrations.
 * @returns {Promise<string[]>} names of the migrations that were applied
 */
export async function migrate({ silent = false } = {}) {
  await db.init();
  await ensureMigrationsTable();

  const all = await loadMigrations();
  const done = await appliedVersions();
  const pending = all.filter((m) => !done.has(m.version));

  if (pending.length === 0) {
    if (!silent) console.log('[migrate] up to date, nothing to apply');
    return [];
  }

  const applied = [];
  for (const migration of pending) {
    if (!silent) process.stdout.write(`[migrate] applying ${migration.name} ... `);
    await apply(migration);
    if (!silent) console.log('ok');
    applied.push(migration.name);
  }

  if (!silent) console.log(`[migrate] applied ${applied.length} migration(s)`);
  return applied;
}

/** Print which migrations have run and which are pending. */
export async function status() {
  await db.init();
  await ensureMigrationsTable();

  const all = await loadMigrations();
  const done = await appliedVersions();

  console.log(`[migrate] driver: ${db.kind()}`);
  for (const m of all) {
    console.log(`  ${done.has(m.version) ? '[applied]' : '[pending]'} ${m.name}`);
  }
}

const invokedDirectly =
  process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (invokedDirectly) {
  const run = process.argv.includes('--status') ? status : migrate;
  run()
    .then(() => db.close())
    .then(() => process.exit(0))
    .catch(async (err) => {
      console.error(`[migrate] ${err.message}`);
      await db.close().catch(() => {});
      process.exit(1);
    });
}
