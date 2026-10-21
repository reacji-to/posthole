import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { cookie, expandTarget, linkedInCommentsUrl, threadsReplayBody, xCursors, xDetailUrl } from '../src/expand.js';
import { parsePayload } from '../src/parsers/index.js';

const fixture = name => fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

test('cookies are read by name', () => {
  assert.equal(cookie('a=1; ct0=abc%3D; b=2', 'ct0'), 'abc=');
  assert.equal(cookie('a=1', 'ct0'), null);
});

test('only posts with replies get a thread fetch', () => {
  const r = (platform, fields) => ({ platform, kind: 'post', metrics: { replies: 3 }, extra: {}, ...fields });
  assert.deepEqual(expandTarget(r('x', { id: '1' })), { id: '1' });
  assert.equal(expandTarget(r('x', { id: '1', metrics: { replies: 0 } })), null);
  assert.deepEqual(expandTarget(r('bluesky', { id: 'at://d/app.bsky.feed.post/r' })), { uri: 'at://d/app.bsky.feed.post/r' });
  assert.deepEqual(expandTarget(r('hackernews', { id: '9', kind: 'story' })), { id: '9' });
  assert.equal(expandTarget(r('hackernews', { id: '9', kind: 'comment' })), null);
  assert.equal(expandTarget(r('linkedin', { id: '7' })), null, 'LinkedIn needs the social detail URN');
  assert.deepEqual(expandTarget(r('linkedin', { id: '7', extra: { social_detail_urn: 'urn:li:fsd_socialDetail:(x)' } })), { id: '7', socialDetailUrn: 'urn:li:fsd_socialDetail:(x)' });
});

test('X TweetDetail requests copy the client shape and page through cursors', () => {
  const own = 'https://x.com/i/api/graphql/QID/TweetDetail?variables=%7B%22focalTweetId%22%3A%22111%22%2C%22withVoice%22%3Atrue%2C%22cursor%22%3A%22old%22%7D&features=%7B%22f%22%3Atrue%7D&fieldToggles=%7B%22t%22%3Atrue%7D';
  const url = new URL(xDetailUrl({ queryId: 'QID', focal: '222', cursor: null, shapeFrom: own }));
  assert.equal(url.pathname, '/i/api/graphql/QID/TweetDetail');
  assert.deepEqual(JSON.parse(url.searchParams.get('variables')), { focalTweetId: '222', withVoice: true });
  assert.equal(url.searchParams.get('features'), '{"f":true}');
  assert.equal(url.searchParams.get('fieldToggles'), '{"t":true}');
  const paged = new URL(xDetailUrl({ queryId: 'QID', focal: '222', cursor: 'C1', shapeFrom: own }));
  assert.equal(JSON.parse(paged.searchParams.get('variables')).cursor, 'C1');
  // Shaped from another operation: default variables, that operation's features.
  const home = 'https://x.com/i/api/graphql/HQ/HomeTimeline?variables=%7B%22count%22%3A20%7D&features=%7B%22g%22%3Atrue%7D';
  const fromHome = new URL(xDetailUrl({ queryId: 'QID', focal: '333', cursor: null, shapeFrom: home }));
  assert.equal(JSON.parse(fromHome.searchParams.get('variables')).focalTweetId, '333');
  assert.equal(JSON.parse(fromHome.searchParams.get('variables')).count, undefined);
  assert.equal(fromHome.searchParams.get('features'), '{"g":true}');
  assert.deepEqual(xCursors(fixture('x-tweet-detail-cursors.synthetic.json')).sort(), ['BOTTOM1', 'SHOWMORE1']);
});

test('LinkedIn comment requests swap the post and page', () => {
  const template = 'https://www.linkedin.com/voyager/api/graphql?includeWebMetadata=true&variables=(count:10,numReplies:1,socialDetailUrn:urn%3Ali%3Afsd_socialDetail%3A%28urn%3Ali%3Aactivity%3A1%2Curn%3Ali%3Aactivity%3A1%2Curn%3Ali%3AhighlightedReply%3A-%29,sortOrder:RELEVANCE,start:0)&queryId=voyagerSocialDashComments.abc';
  const url = linkedInCommentsUrl(template, 'urn:li:fsd_socialDetail:(urn:li:activity:2,urn:li:activity:2,urn:li:highlightedReply:-)', 20);
  assert.match(url, /socialDetailUrn:urn%3Ali%3Afsd_socialDetail%3A%28urn%3Ali%3Aactivity%3A2%2Curn%3Ali%3Aactivity%3A2%2Curn%3Ali%3AhighlightedReply%3A-%29,/);
  assert.match(url, /,start:20\)/);
  assert.match(url, /queryId=voyagerSocialDashComments\.abc$/);
});

test('Threads replays keep the query but use the live session tokens', () => {
  const body = threadsReplayBody('lsd=OLD&fb_dtsg=OLD&doc_id=99&variables=%7B%22postID%22%3A%221%22%2C%22x%22%3Atrue%7D', new URLSearchParams('lsd=NEW&fb_dtsg=NEW2'), '555');
  const params = new URLSearchParams(body);
  assert.equal(params.get('lsd'), 'NEW');
  assert.equal(params.get('fb_dtsg'), 'NEW2');
  assert.equal(params.get('doc_id'), '99');
  assert.deepEqual(JSON.parse(params.get('variables')), { postID: '555', x: true });
});

test('LinkedIn comments and replies become comment records that can be expanded', () => {
  const items = parsePayload('linkedin', { body: fixture('linkedin-comments.synthetic.json') });
  assert.equal(items.length, 2);
  const [top, reply] = items.sort((a, b) => a.record.text.localeCompare(b.record.text));
  assert.equal(top.record.kind, 'comment');
  assert.equal(top.record.text, 'Congrats!');
  assert.equal(top.record.author.name, 'Grace Hopper');
  assert.equal(top.record.reply_to.id, '7254000000000000001');
  assert.equal(top.record.metrics.replies, 1);
  assert.match(top.record.extra.social_detail_urn, /fsd_socialDetail/);
  assert.match(top.record.key, /^web:[a-f\d]{64}$/, 'comments are web pages to reacji.to');
  assert.equal(top.dir, top.record.key.replace(':', '/'));
  assert.equal(reply.record.reply_to.id, 'urn:li:comment:(activity:7254000000000000001,7254000000000000101)');
  assert.equal(reply.record.thread_root.id, '7254000000000000001');
  assert.ok(expandTarget(top.record), 'comments with replies are expanded too');
});

test('Bluesky thread responses yield every post in the tree', () => {
  const items = parsePayload('bluesky', { body: fixture('bluesky-thread.json') });
  const thread = JSON.parse(fixture('bluesky-thread.json')).thread;
  const count = node => 1 + (node.replies ?? []).filter(r => r.post).reduce((n, r) => n + count(r), 0);
  assert.equal(items.length, count(thread));
  const root = items.find(i => i.record.id === thread.post.uri);
  assert.ok(items.filter(i => i.record.reply_to?.id === root.record.id).length > 10);
});
