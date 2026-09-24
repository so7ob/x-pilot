/**
 * Published-post URL contract tests (Closes #67).
 *
 * The session log must record the permalink of the post the extension just
 * published. These tests pin the pure extraction contract:
 *   - canonicalization strips /analytics, /photo/1, query and hash suffixes
 *   - author guard is case-insensitive and @-tolerant
 *   - `/i/web/status/{id}` counts as an own-post permalink (X internal redirect)
 *   - sanitize drops everything that is not a canonical status permalink
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalStatusUrl, isAuthoredBy, isOwnPermalink, parseStatusUrl, sanitizePublishedPostUrl } from '../src/domain/published-post-url.ts';

test('parseStatusUrl extracts author and numeric status id', () => {
  assert.deepEqual(parseStatusUrl('https://x.com/so7ob/status/2103265707043835909'), { author: 'so7ob', statusId: '2103265707043835909', internal: false });
  assert.deepEqual(parseStatusUrl('http://www.twitter.com/Alice/status/42'), { author: 'Alice', statusId: '42', internal: false });
  assert.deepEqual(parseStatusUrl('https://x.com/i/web/status/199'), { author: 'i', statusId: '199', internal: true });
});

test('parseStatusUrl rejects non-status and malformed URLs', () => {
  assert.equal(parseStatusUrl('https://x.com/so7ob'), undefined);
  assert.equal(parseStatusUrl('https://x.com/status/123'), undefined);
  assert.equal(parseStatusUrl('https://x.com/so7ob/status/abc'), undefined);
  assert.equal(parseStatusUrl('https://x.com/so7ob/status/'), undefined);
  assert.equal(parseStatusUrl('https://cdn.x.com/media/1'), undefined);
  assert.equal(parseStatusUrl('javascript:alert(1)'), undefined);
  assert.equal(parseStatusUrl(''), undefined);
  assert.equal(parseStatusUrl(undefined), undefined);
  assert.equal(parseStatusUrl(42), undefined);
});

test('canonicalStatusUrl strips /analytics, /photo/1, query and hash suffixes', () => {
  assert.equal(canonicalStatusUrl('https://x.com/so7ob/status/2103265707043835909/analytics'), 'https://x.com/so7ob/status/2103265707043835909');
  assert.equal(canonicalStatusUrl('https://x.com/so7ob/status/42/photo/1'), 'https://x.com/so7ob/status/42');
  assert.equal(canonicalStatusUrl('https://x.com/so7ob/status/42?foo=bar'), 'https://x.com/so7ob/status/42');
  assert.equal(canonicalStatusUrl('https://x.com/so7ob/status/42#m'), 'https://x.com/so7ob/status/42');
  assert.equal(canonicalStatusUrl('https://www.twitter.com/so7ob/status/42/analytics?s=20'), 'https://x.com/so7ob/status/42');
  assert.equal(canonicalStatusUrl('https://x.com/i/web/status/199/analytics'), 'https://x.com/i/web/status/199', 'the internal own-post shape is kept intact');
});

test('isAuthoredBy is case-insensitive and @-tolerant, false without a screen name', () => {
  assert.equal(isAuthoredBy('https://x.com/So7ob/status/1', 'so7ob'), true);
  assert.equal(isAuthoredBy('https://x.com/so7ob/status/1', '@So7ob'), true);
  assert.equal(isAuthoredBy('https://x.com/so7ob/status/1', 'so7ob '), true);
  assert.equal(isAuthoredBy('https://x.com/Minahil42298354/status/2103137624256885245', 'so7ob'), false);
  assert.equal(isAuthoredBy('https://x.com/so7ob/status/1', undefined), false);
  assert.equal(isAuthoredBy('not-a-url', 'so7ob'), false);
});

test('isOwnPermalink accepts the internal /i/web/status/{id} own-post redirect', () => {
  assert.equal(isOwnPermalink('https://x.com/i/web/status/199', 'so7ob'), true);
  assert.equal(isOwnPermalink('https://x.com/i/web/status/199'), true);
  assert.equal(isOwnPermalink('https://x.com/so7ob/status/199', 'so7ob'), true);
  assert.equal(isOwnPermalink('https://x.com/stranger/status/199', 'so7ob'), false);
  assert.equal(isOwnPermalink('https://x.com/i/other/199', 'so7ob'), false);
});

test('sanitizePublishedPostUrl keeps only canonical status permalinks', () => {
  assert.equal(sanitizePublishedPostUrl('https://x.com/so7ob/status/2103265707043835909/analytics'), 'https://x.com/so7ob/status/2103265707043835909');
  assert.equal(sanitizePublishedPostUrl('https://x.com/so7ob/status/2103265707043835909'), 'https://x.com/so7ob/status/2103265707043835909');
  assert.equal(sanitizePublishedPostUrl('javascript:alert(1)'), undefined);
  assert.equal(sanitizePublishedPostUrl('garbage'), undefined);
  assert.equal(sanitizePublishedPostUrl(undefined), undefined);
});
