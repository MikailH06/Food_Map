/**
 * Crawler manners.
 *
 * Everything in this file exists so that fetching restaurant websites stays
 * something a reasonable site owner would not object to. These are not
 * decoration — if they are removed, the crawler becomes something that should
 * not be pointed at other people's servers.
 *
 * The rules:
 *   - honour robots.txt for our own user agent
 *   - identify ourselves honestly, with a URL explaining what the bot is
 *   - one in-flight request per domain, with a minimum gap between them
 *   - cap response size and time so one bad site cannot stall the worker
 *   - back off exponentially rather than hammering something that is failing
 */

import robotsParser from 'robots-parser';
import { enrichment } from '../../config.js';

/** Cached robots.txt rules per origin. */
const robotsCache = new Map();
/** When each host may next be contacted. */
const nextAllowedAt = new Map();
/** Serialises requests per host. */
const hostQueues = new Map();

const ROBOTS_TTL_MS = 60 * 60 * 1000;

/** Wipe all caches. Used by tests. */
export function resetPolitenessState() {
  robotsCache.clear();
  nextAllowedAt.clear();
  hostQueues.clear();
}

/**
 * Fetch and cache a host's robots.txt.
 *
 * A missing or unreadable robots.txt means "no restrictions stated", which is
 * the correct reading of the standard. A 5xx, though, means the server is
 * struggling — so we stay away rather than assume permission.
 */
async function loadRobots(origin) {
  const cached = robotsCache.get(origin);
  if (cached && Date.now() - cached.fetchedAt < ROBOTS_TTL_MS) {
    return cached.robots;
  }

  const robotsUrl = `${origin}/robots.txt`;
  let robots = null;

  try {
    const response = await fetch(robotsUrl, {
      headers: { 'User-Agent': enrichment.userAgent },
      signal: AbortSignal.timeout(5_000),
      redirect: 'follow',
    });

    if (response.ok) {
      const text = await response.text();
      robots = robotsParser(robotsUrl, text);
    } else if (response.status >= 500) {
      // Server in trouble: treat as disallowed for now.
      robots = robotsParser(robotsUrl, 'User-agent: *\nDisallow: /');
    }
    // 404 and other 4xx leave robots as null == unrestricted.
  } catch {
    // Unreachable robots.txt is not itself a reason to refuse the site.
    robots = null;
  }

  robotsCache.set(origin, { robots, fetchedAt: Date.now() });
  return robots;
}

/** Whether robots.txt permits us to fetch this URL. */
export async function isAllowed(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;

  const robots = await loadRobots(parsed.origin);
  if (!robots) return true;

  // robots-parser returns undefined when no rule applies, which means allowed.
  const allowed = robots.isAllowed(url, enrichment.userAgent);
  return allowed !== false;
}

/**
 * Run `fn` such that only one request is in flight per host, and consecutive
 * requests to the same host are at least perDomainDelayMs apart.
 */
function perHostQueue(host, fn) {
  const previous = hostQueues.get(host) ?? Promise.resolve();

  const next = previous.then(async () => {
    const waitUntil = nextAllowedAt.get(host) ?? 0;
    const wait = waitUntil - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));

    try {
      return await fn();
    } finally {
      nextAllowedAt.set(host, Date.now() + enrichment.perDomainDelayMs);
    }
  });

  // Keep the chain alive after a rejection, and let it be garbage collected
  // once this host goes quiet.
  hostQueues.set(
    host,
    next.catch(() => {})
  );
  return next;
}

/**
 * Read a response body, aborting if it exceeds maxResponseBytes.
 *
 * Streaming rather than calling .text() means a site serving a 500MB file
 * cannot exhaust our memory before we notice.
 */
async function readCapped(response, maxBytes) {
  const declared = Number.parseInt(response.headers.get('content-length') ?? '', 10);
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error(`response too large (${declared} bytes)`);
  }

  const reader = response.body?.getReader();
  if (!reader) return '';

  const chunks = [];
  let total = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maxBytes) {
        throw new Error(`response exceeded ${maxBytes} bytes`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock?.();
  }

  return new TextDecoder('utf-8', { fatal: false }).decode(
    chunks.length === 1 ? chunks[0] : Buffer.concat(chunks)
  );
}

/**
 * Politely fetch a page and return its HTML.
 *
 * @param {string} url
 * @returns {Promise<{html: string, finalUrl: string}>}
 * @throws when robots.txt disallows it, it is not HTML, or the request fails
 */
export async function politeFetch(url) {
  const parsed = new URL(url);

  if (!(await isAllowed(url))) {
    throw new Error('disallowed by robots.txt');
  }

  return perHostQueue(parsed.host, async () => {
    const response = await fetch(url, {
      headers: {
        'User-Agent': enrichment.userAgent,
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(enrichment.requestTimeoutMs),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('html')) {
      throw new Error(`not HTML (${contentType || 'no content-type'})`);
    }

    const html = await readCapped(response, enrichment.maxResponseBytes);
    return { html, finalUrl: response.url || url };
  });
}

/**
 * Delay before retry N, growing exponentially.
 * Capped at six hours so a permanently broken site does not schedule a retry
 * years away.
 */
export function backoffMs(attempts) {
  const delay = enrichment.backoffBaseMs * 2 ** Math.max(0, attempts - 1);
  return Math.min(delay, 6 * 60 * 60 * 1000);
}
