/**
 * Configuration tests.
 *
 * The Supabase dashboard shows several URLs for one project, and copying the
 * Data API endpoint instead of the Project URL is an easy mistake — it failed a
 * real deploy. These lock in the normalisation that now tolerates it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSupabaseUrl } from '../server/config.js';

test('accepts a correct project URL unchanged', () => {
  const result = normalizeSupabaseUrl('https://hhbkporgafmvmgrmltuf.supabase.co');
  assert.equal(result.url, 'https://hhbkporgafmvmgrmltuf.supabase.co');
  assert.equal(result.corrected, false, 'a correct value should not warn');
});

test('strips the Data API path that Render failed on', () => {
  // The exact value that broke the first deploy.
  const result = normalizeSupabaseUrl('https://hhbkporgafmvmgrmltuf.supabase.co/rest/v1/');
  assert.equal(result.url, 'https://hhbkporgafmvmgrmltuf.supabase.co');
  assert.equal(result.corrected, true, 'should warn that it was corrected');
});

test('strips a bare trailing slash', () => {
  // Not cosmetic: it would produce https://x.supabase.co//auth/v1/... and break
  // JWT issuer matching.
  const result = normalizeSupabaseUrl('https://abc.supabase.co/');
  assert.equal(result.url, 'https://abc.supabase.co');
  assert.equal(result.corrected, true);
});

test('strips other stray paths', () => {
  for (const input of [
    'https://abc.supabase.co/auth/v1',
    'https://abc.supabase.co/storage/v1/object',
    'https://abc.supabase.co/dashboard',
  ]) {
    assert.equal(normalizeSupabaseUrl(input).url, 'https://abc.supabase.co', `failed on ${input}`);
  }
});

test('tolerates surrounding whitespace from a sloppy paste', () => {
  assert.equal(normalizeSupabaseUrl('  https://abc.supabase.co  ').url, 'https://abc.supabase.co');
});

test('handles absent values', () => {
  assert.equal(normalizeSupabaseUrl(null).url, null);
  assert.equal(normalizeSupabaseUrl('').url, null);
  assert.equal(normalizeSupabaseUrl(undefined).url, null);
});

test('returns unparseable input untouched so validation can report it', () => {
  // Better to show the user exactly what they set than a mangled version.
  assert.equal(normalizeSupabaseUrl('not-a-url').url, 'not-a-url');
});
