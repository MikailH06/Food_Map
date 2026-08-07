/**
 * Database access layer.
 *
 * Presents one small interface — query / transaction / close — over two very
 * different drivers:
 *
 *   - node-postgres  when DATABASE_URL is set (Supabase in production)
 *   - PGlite         when it is not (local development and tests)
 *
 * PGlite is real Postgres compiled to WebAssembly. It runs in this process with
 * no install, no service and no Docker, which is why the whole backend can be
 * built and tested before any cloud account exists. Because it is genuinely
 * Postgres, the SQL written against it is the SQL that runs in production.
 *
 * Both drivers use $1, $2 placeholders and return { rows }, so callers never
 * need to know which one is active.
 */

import { database } from '../config.js';

/** @typedef {{ rows: any[], rowCount: number }} QueryResult */

let driver = null;
let driverKind = null;
let initPromise = null;

/**
 * Postgres extensions we rely on. pg_trgm powers typo-tolerant restaurant
 * search ("chipolte" should still find Chipotle).
 */
const REQUIRED_EXTENSIONS = ['pg_trgm'];

async function initPostgres() {
  const pg = (await import('pg')).default;

  // Supabase terminates un-encrypted connections. Its pooler presents a
  // certificate that Node's default CA bundle does not chain to, so we encrypt
  // but skip chain verification — standard practice for Supabase's pooler.
  const isSupabase = /supabase\.(co|com)/.test(database.url);

  const pool = new pg.Pool({
    connectionString: database.url,
    max: database.poolMax,
    idleTimeoutMillis: database.idleTimeoutMs,
    connectionTimeoutMillis: database.connectionTimeoutMs,
    ssl: isSupabase ? { rejectUnauthorized: false } : undefined,
  });

  // A pooled client erroring in the background must not take the process down.
  pool.on('error', (err) => {
    console.error('[db] idle client error:', err.message);
  });

  driver = pool;
  driverKind = 'postgres';
  return pool;
}

async function initPglite() {
  const { PGlite } = await import('@electric-sql/pglite');
  const { pg_trgm } = await import('@electric-sql/pglite/contrib/pg_trgm');

  const dir = database.pgliteDir;
  // Note the two call shapes: passing `undefined` as the first positional
  // argument does NOT select an in-memory database, it breaks extension
  // loading. An in-memory database is requested by omitting the path entirely.
  const db =
    dir === 'memory://'
      ? await PGlite.create({ extensions: { pg_trgm } })
      : await PGlite.create(dir, { extensions: { pg_trgm } });

  for (const ext of REQUIRED_EXTENSIONS) {
    await db.exec(`CREATE EXTENSION IF NOT EXISTS ${ext};`);
  }

  driver = db;
  driverKind = 'pglite';
  return db;
}

/**
 * Connect on first use. Concurrent callers share one initialisation.
 * @returns {Promise<void>}
 */
export function init() {
  if (!initPromise) {
    initPromise = (database.url ? initPostgres() : initPglite()).catch((err) => {
      // Let a later call retry rather than caching a failed connection.
      initPromise = null;
      throw err;
    });
  }
  return initPromise;
}

/** Which driver is active: 'postgres' | 'pglite' | null (not yet connected). */
export function kind() {
  return driverKind;
}

/**
 * Run a parameterised query.
 *
 * @param {string} text  SQL using $1, $2 placeholders
 * @param {any[]} [params]
 * @returns {Promise<QueryResult>}
 */
export async function query(text, params = []) {
  await init();
  const result = await driver.query(text, params);
  return {
    rows: result.rows ?? [],
    // PGlite reports affectedRows; node-postgres reports rowCount.
    rowCount: result.rowCount ?? result.affectedRows ?? result.rows?.length ?? 0,
  };
}

/**
 * Run multiple statements. Used by the migration runner, which needs to execute
 * whole .sql files that contain several statements separated by semicolons.
 *
 * @param {string} sql
 */
export async function exec(sql) {
  await init();
  if (driverKind === 'pglite') {
    return driver.exec(sql);
  }
  // node-postgres sends a multi-statement string as a simple query, which is
  // exactly what we want here.
  return driver.query(sql);
}

/**
 * Run `fn` inside a transaction, committing on success and rolling back on any
 * thrown error.
 *
 * The callback receives an object with the same `query` shape as the module, so
 * code can be written once and used inside or outside a transaction.
 *
 * @template T
 * @param {(tx: { query: (text: string, params?: any[]) => Promise<QueryResult> }) => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function transaction(fn) {
  await init();

  if (driverKind === 'pglite') {
    // PGlite manages BEGIN/COMMIT/ROLLBACK itself.
    return driver.transaction(async (tx) => {
      return fn({
        query: async (text, params = []) => {
          const r = await tx.query(text, params);
          return { rows: r.rows ?? [], rowCount: r.affectedRows ?? r.rows?.length ?? 0 };
        },
      });
    });
  }

  const client = await driver.connect();
  try {
    await client.query('BEGIN');
    const result = await fn({
      query: async (text, params = []) => {
        const r = await client.query(text, params);
        return { rows: r.rows ?? [], rowCount: r.rowCount ?? 0 };
      },
    });
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // A rollback failure would mask the original error; the original is
      // the one worth surfacing.
    }
    throw err;
  } finally {
    client.release();
  }
}

/** Close the connection. Called on graceful shutdown and between test files. */
export async function close() {
  if (!driver) return;
  if (driverKind === 'pglite') {
    await driver.close();
  } else {
    await driver.end();
  }
  driver = null;
  driverKind = null;
  initPromise = null;
}

/** True if the database answers a trivial query. Backs the /health endpoint. */
export async function healthy() {
  try {
    await query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}

export default { init, kind, query, exec, transaction, close, healthy };
