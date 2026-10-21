import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { sha256Hex } from '../src/sha256.js';
import { canonicalUrl, reacjiKey } from '../src/schema.js';

const node = text => crypto.createHash('sha256').update(text, 'utf8').digest('hex');

test('SHA-256 matches node:crypto across block boundaries and Unicode', () => {
  for (const text of ['', 'abc', 'a'.repeat(55), 'a'.repeat(56), 'a'.repeat(64), 'a'.repeat(1000), 'naïve — ünïcødé 🎉', 'https://bsky.app/profile/bsky.app/post/3mycttvih722i']) {
    assert.equal(sha256Hex(text), node(text), JSON.stringify(text.slice(0, 20)));
  }
});

test('post keys follow reacji.to: x and linkedin by ID, everything else by canonical URL hash', () => {
  assert.equal(reacjiKey('x', '2112662021884043494', 'https://x.com/a/status/2112662021884043494'), 'x:2112662021884043494');
  assert.equal(reacjiKey('linkedin', '7518335312863961088', 'https://www.linkedin.com/feed/update/urn:li:activity:7518335312863961088/'), 'linkedin:7518335312863961088');
  const bsky = 'https://bsky.app/profile/bsky.app/post/3mycttvih722i';
  assert.equal(reacjiKey('bluesky', 'at://did:plc:x/app.bsky.feed.post/3mycttvih722i', bsky), `web:${node(bsky)}`);
  const hn = 'https://news.ycombinator.com/item?id=50170593';
  assert.equal(reacjiKey('hackernews', '50170593', hn), `web:${node(hn)}`);
  // LinkedIn comments are not activities, so reacji.to treats them as pages.
  assert.match(reacjiKey('linkedin', 'urn:li:comment:(activity:1,2)', 'https://www.linkedin.com/feed/update/urn:li:activity:1/?commentUrn=x'), /^web:/);
  // Same canonicalization as reacji.to: tracking parameters and plain fragments don't change identity.
  assert.equal(canonicalUrl('https://example.com/a?utm_source=x&b=1&fbclid=z#top'), 'https://example.com/a?b=1');
  assert.equal(canonicalUrl('https://example.com/#/route'), 'https://example.com/#/route');
});
