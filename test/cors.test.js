/**
 * CORS tests.
 *
 * A stale CORS_ORIGINS once stopped the deployed site loading its own
 * JavaScript: browsers send an Origin header when fetching a module script, the
 * allowlist did not contain the app's real URL, and the rejection surfaced as an
 * HTTP 500 on /js/main.js. The page rendered blank with one opaque error.
 *
 * These lock in the three fixes: same-origin is always allowed, refusals are
 * quiet rather than 500s, and static assets are not gated at all.
 */

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupDb, teardownDb } from './helpers/db.js';

const { createApp } = await import('../server/index.js');

let baseUrl;
let httpServer;

before(async () => {
  await setupDb();
  httpServer = createApp().listen(0);
  await new Promise((r) => httpServer.once('listening', r));
  baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
});

after(async () => {
  await new Promise((r) => httpServer.close(r));
  await teardownDb();
});

/** The app's own origin, as a browser would send it. */
function ownOrigin() {
  return `http://127.0.0.1:${httpServer.address().port}`;
}

test('a same-origin API request is allowed even though the allowlist lacks it', async () => {
  // CORS_ORIGINS defaults to localhost:3000 here, which does NOT match the
  // ephemeral test port — exactly the stale-config situation that broke prod.
  const res = await fetch(`${baseUrl}/api/config`, {
    headers: { Origin: ownOrigin() },
  });

  assert.equal(res.status, 200);
  assert.equal(res.headers.get('access-control-allow-origin'), ownOrigin());
});

test('a request with no Origin is allowed', async () => {
  const res = await fetch(`${baseUrl}/api/config`);
  assert.equal(res.status, 200);
});

test('a disallowed origin is refused quietly, not with a 500', async () => {
  const res = await fetch(`${baseUrl}/api/config`, {
    headers: { Origin: 'https://evil.example.com' },
  });

  // The request still completes; the browser enforces the block by noticing
  // there is no matching CORS header. Returning 500 told the user their server
  // was broken when it was doing its job.
  assert.notEqual(res.status, 500, 'a refused origin must never surface as a server error');
  assert.equal(res.headers.get('access-control-allow-origin'), null);
});

test('static assets are never gated by CORS', async () => {
  // This is the regression that mattered: a module script carries an Origin
  // header, so gating static files meant the app could not load its own code.
  for (const path of ['/', '/js/main.js', '/js/api.js', '/css/style.css']) {
    const res = await fetch(`${baseUrl}${path}`, {
      headers: { Origin: 'https://some-unrelated-origin.example.com' },
    });
    assert.equal(res.status, 200, `${path} should serve regardless of Origin`);
  }
});

test('the app serves its own JavaScript to its own page', async () => {
  const res = await fetch(`${baseUrl}/js/main.js`, {
    headers: { Origin: ownOrigin(), 'Sec-Fetch-Dest': 'script' },
  });

  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /javascript/);
  assert.match(await res.text(), /import/, 'should be the real module, not an error page');
});
