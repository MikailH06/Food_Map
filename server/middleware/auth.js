/**
 * Authentication.
 *
 * The browser signs in against Supabase Auth directly and receives a JWT. Every
 * API call carries it as `Authorization: Bearer <token>`. This module verifies
 * that token and attaches `req.user = { id, email }`.
 *
 * Verification is done LOCALLY against Supabase's published public keys
 * (JWKS), so a request costs no network round-trip to Supabase. Two details
 * matter:
 *
 *   - Supabase edge-caches its JWKS for 10 minutes. Caching longer on our side
 *     would keep us trusting a key after it had been rotated or revoked.
 *
 *   - Projects still on the legacy shared-secret (HS256) scheme publish no
 *     keys at that endpoint. Supabase explicitly advises against verifying
 *     those locally, so we fall back to asking the Auth server to validate the
 *     token for us.
 */

import { createRemoteJWKSet, jwtVerify } from 'jose';
import { supabase as supabaseConfig, server as serverConfig, geography } from '../config.js';
import { unauthorized } from './errors.js';
import * as db from '../db/pool.js';

/**
 * Local development without a Supabase project.
 *
 * When there is no Supabase URL and we are not in production, a request may
 * identify itself with an `X-Dev-User: <uuid>` header. This makes the entire
 * API exercisable with curl before any cloud account exists.
 *
 * Both conditions are required, so this can never be reachable in production
 * even if someone sets the header.
 */
export function devAuthEnabled() {
  return !serverConfig.isProduction && !supabaseConfig.url;
}

let jwks = null;

function getJwks() {
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`${supabaseConfig.url}/auth/v1/.well-known/jwks.json`), {
      cacheMaxAge: supabaseConfig.jwksCacheMs,
      cooldownDuration: 30_000,
    });
  }
  return jwks;
}

/**
 * Ask the Supabase Auth server to validate a token.
 *
 * Used only for projects on the legacy HS256 signing scheme, where local
 * verification is not advisable.
 */
async function verifyRemotely(token) {
  const response = await fetch(`${supabaseConfig.url}/auth/v1/user`, {
    headers: {
      Authorization: `Bearer ${token}`,
      apikey: supabaseConfig.anonKey ?? '',
    },
    signal: AbortSignal.timeout(5_000),
  });

  if (!response.ok) return null;

  const user = await response.json();
  return user?.id ? { id: user.id, email: user.email ?? null } : null;
}

/**
 * Verify a bearer token and return the user it identifies.
 * @returns {Promise<{id: string, email: string|null}|null>}
 */
export async function verifyToken(token) {
  if (!token || !supabaseConfig.url) return null;

  try {
    const { payload } = await jwtVerify(token, getJwks(), {
      issuer: `${supabaseConfig.url}/auth/v1`,
      audience: 'authenticated',
    });
    return { id: payload.sub, email: payload.email ?? null };
  } catch (err) {
    // No published keys means the project still signs with a shared secret.
    // Anything else is a genuinely invalid token.
    const legacyScheme =
      err?.code === 'ERR_JWKS_NO_MATCHING_KEY' ||
      err?.code === 'ERR_JWKS_INVALID' ||
      err?.code === 'ERR_JOSE_ALG_NOT_ALLOWED';

    if (legacyScheme) {
      return verifyRemotely(token).catch(() => null);
    }
    return null;
  }
}

/** Pull the bearer token out of the Authorization header. */
function bearerToken(req) {
  const header = req.get('authorization');
  if (!header) return null;
  const [scheme, token] = header.split(' ');
  return scheme?.toLowerCase() === 'bearer' && token ? token : null;
}

/**
 * Make sure a profiles row exists for this user.
 *
 * Done here rather than by a database trigger on auth.users so that it behaves
 * identically locally and on Supabase, and cannot silently fail if a trigger
 * was never installed. Also creates the user's first map, so a new account
 * always lands somewhere usable instead of on an empty screen.
 */
export async function ensureProfile(user) {
  await db.query(
    `INSERT INTO profiles (id, display_name)
     VALUES ($1, $2)
     ON CONFLICT (id) DO NOTHING`,
    [user.id, user.email?.split('@')[0] ?? null]
  );

  const { rows } = await db.query('SELECT count(*)::int AS c FROM maps WHERE owner_id = $1', [
    user.id,
  ]);

  if (rows[0].c === 0) {
    // Centre it explicitly rather than leaving nulls, so the frontend never has
    // to invent a fallback position for a brand-new map.
    await db.query(
      `INSERT INTO maps (owner_id, name, slug, center_lat, center_lng, zoom)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        user.id,
        'My Restaurant Map',
        `map-${user.id.slice(0, 8)}-${Date.now().toString(36)}`,
        geography.defaultCenter.lat,
        geography.defaultCenter.lng,
        geography.defaultZoom,
      ]
    );
  }
}

/**
 * Resolve the caller's identity without requiring it.
 * Sets `req.user` to the user or to null.
 */
export async function attachUser(req, res, next) {
  try {
    if (devAuthEnabled()) {
      const devUser = req.get('x-dev-user');
      req.user = devUser ? { id: devUser, email: `${devUser}@dev.local` } : null;
    } else {
      req.user = await verifyToken(bearerToken(req));
    }

    if (req.user) await ensureProfile(req.user);
    next();
  } catch (err) {
    next(err);
  }
}

/** Reject the request unless it carries a valid identity. */
export function requireAuth(req, res, next) {
  if (!req.user) {
    return next(unauthorized('Sign in to continue'));
  }
  next();
}
