import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseHTML } from 'linkedom';
import { SCHEMA } from '../src/schema.js';
import { parseDocument, parsePayload } from '../src/parsers/index.js';
import { platformFor, responseMatches } from '../src/match.js';
import { expandTarget } from '../src/expand.js';

const fixture = name => fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const byId = items => Object.fromEntries(items.map(i => [i.record.id, i]));

// Every platform must produce the same record shape.
function assertSchema(items) {
  assert.ok(items.length > 0, 'expected posts');
  const keys = ['schema', 'key', 'platform', 'id', 'url', 'kind', 'author', 'created_at', 'title', 'text', 'lang', 'links', 'mentions', 'hashtags', 'media', 'link_card', 'reply_to', 'thread_root', 'quote_of', 'metrics', 'extra'];
  for (const { record, dir, assets } of items) {
    assert.deepEqual(Object.keys(record), keys);
    assert.equal(record.schema, SCHEMA);
    assert.equal(typeof record.id, 'string');
    assert.match(record.url, /^https:\/\//);
    assert.ok(['post', 'reply', 'quote', 'article', 'story', 'comment'].includes(record.kind), record.kind);
    assert.equal(typeof record.text, 'string');
    assert.ok(record.created_at === null || !Number.isNaN(Date.parse(record.created_at)));
    assert.match(record.key, /^(x|linkedin):[1-9]\d{5,24}$|^web:[a-f\d]{64}$/);
    assert.equal(dir, record.key.replace(':', '/'));
    for (const m of record.media) {
      assert.ok(['image', 'video', 'gif', 'document'].includes(m.type));
      assert.equal(m.file, null);
      assert.equal('_fetch' in m, false, 'fetch hints must not leak into the saved record');
    }
    for (const a of assets) assert.match(a.url, /^https:\/\//);
  }
}

test('platforms and API URLs are recognized', () => {
  assert.equal(platformFor('x.com'), 'x');
  assert.equal(platformFor('www.linkedin.com'), 'linkedin');
  assert.equal(platformFor('bsky.app'), 'bluesky');
  assert.equal(platformFor('www.threads.com'), 'threads');
  assert.equal(platformFor('www.threads.net'), 'threads');
  assert.equal(platformFor('news.ycombinator.com'), 'hackernews');
  assert.equal(platformFor('example.com'), null);
  assert.ok(responseMatches('x', 'https://x.com/i/api/graphql/abc/HomeTimeline?variables=1'));
  assert.ok(responseMatches('bluesky', 'https://puffball.us-east.host.bsky.network/xrpc/app.bsky.feed.getTimeline?limit=30'));
  assert.ok(!responseMatches('bluesky', 'https://bsky.app/static/app.js'));
});

test('X: timeline posts, reposts, quotes, long posts, cards, articles; ads skipped', () => {
  const items = parsePayload('x', { url: 'https://x.com/i/api/graphql/q/HomeTimeline', body: fixture('x-home-timeline.synthetic.json') });
  assertSchema(items);
  const posts = byId(items);
  assert.deepEqual(Object.keys(posts).sort(), ['1001', '1003', '1004', '1006', '1007', '800', '900'].sort());

  const photo = posts['1001'].record;
  assert.equal(photo.url, 'https://x.com/ada/status/1001');
  assert.equal(photo.text, 'Notes on #engines with @charles & friends https://example.com/notes');
  assert.deepEqual(photo.hashtags, ['engines']);
  assert.deepEqual(photo.mentions, ['charles']);
  assert.equal(photo.author.avatar_url, 'https://pbs.twimg.com/profile_images/1/ada_400x400.jpg');
  assert.equal(photo.media[0].url, 'https://pbs.twimg.com/media/PHOTO1.jpg?name=orig');
  assert.equal(photo.media[0].alt, 'A difference engine');
  assert.equal(photo.metrics.views, 1000);
  assert.equal(photo.created_at, '2026-10-20T18:00:00.000Z');

  assert.equal(posts['900'].context.reposted_by, 'charles');
  assert.equal(posts['900'].record.author.handle, 'grace');

  const quote = posts['1003'].record;
  assert.equal(quote.kind, 'quote');
  assert.deepEqual(quote.quote_of, { platform: 'x', id: '800', url: 'https://x.com/lin/status/800' });
  const video = posts['800'].record.media[0];
  assert.equal(video.type, 'video');
  assert.equal(video.url, 'https://video.twimg.com/amplify_video/800/vid/avc1/1280x720/high.mp4');
  assert.equal(video.duration_ms, 15000);

  assert.ok(posts['1004'].record.text.startsWith('A long post. A long post.'));
  assert.ok(posts['1004'].record.text.endsWith('See https://example.com/more'));
  assert.equal(posts['1004'].record.extra.long_post, true);

  const reply = posts['1006'].record;
  assert.equal(reply.kind, 'reply');
  assert.equal(reply.text, 'Great read https://blog.example.org/post');
  assert.equal(reply.reply_to.id, '1001');
  assert.equal(reply.link_card.title, 'A blog post');
  assert.equal(reply.link_card.url, 'https://blog.example.org/post');
  assert.match(reply.link_card.image_url, /card_img/);

  const article = posts['1007'].record;
  assert.equal(article.kind, 'article');
  assert.equal(article.title, 'On Engines');
  assert.equal(article.text, 'First paragraph.\n\nSecond paragraph.');
});

test('Bluesky: real feed responses with every embed type', () => {
  const items = parsePayload('bluesky', { url: 'https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed', body: fixture('bluesky-feed.json') });
  assertSchema(items);
  const records = items.map(i => i.record);
  const withImages = records.find(r => r.media.some(m => m.type === 'image'));
  assert.match(withImages.media[0].url, /^https:\/\/cdn\.bsky\.app\/img\/feed_fullsize\//);
  const video = items.find(i => i.record.media.some(m => m.type === 'video'));
  const videoAsset = video.assets.find(a => a.kind === 'video');
  assert.ok(videoAsset.fetch.bsky_blob.did.startsWith('did:'), 'video downloads the original blob');
  assert.ok(records.some(r => r.link_card?.url?.startsWith('http')));
  assert.ok(records.some(r => r.quote_of?.platform === 'bluesky'));
  assert.ok(records.some(r => r.kind === 'reply' && r.reply_to.id.startsWith('at://')));
  assert.ok(items.some(i => i.context.reposted_by), 'reposts record who reposted');
  for (const r of records) {
    assert.match(r.url, /^https:\/\/bsky\.app\/profile\/[^/]+\/post\/[a-z0-9]+$/);
    assert.ok(r.created_at);
  }
  const faceted = records.find(r => r.links.length || r.mentions.length || r.hashtags.length);
  assert.ok(faceted, 'facets become links, mentions or hashtags');
});

test('Threads: guarded GraphQL, thread chains, carousels, video, quotes; reposts and ads', () => {
  const items = parsePayload('threads', { url: 'https://www.threads.com/graphql/query', body: fixture('threads-feed.synthetic.txt') });
  assertSchema(items);
  const posts = byId(items);
  assert.deepEqual(Object.keys(posts).sort(), ['3001', '3002', '3003', '3004', '3005']);
  const first = posts['3001'].record;
  assert.equal(first.url, 'https://www.threads.com/@zuck/post/DA1');
  assert.equal(first.author.avatar_url, 'https://scontent-sjc3-1.cdninstagram.com/v/t51/zuck_1080.jpg');
  assert.equal(first.media[0].url, 'https://scontent-sjc3-1.cdninstagram.com/v/t51/photo1_full.jpg');
  assert.equal(first.link_card.url, 'https://example.com/lake');
  assert.deepEqual(first.links, [{ url: 'https://example.com/lake', text: 'example.com/lake' }]);
  assert.deepEqual(first.mentions, ['mosseri']);
  assert.equal(posts['3002'].record.reply_to.id, '3001');
  assert.equal(posts['3003'].record.media[0].url, 'https://scontent-sjc3-1.cdninstagram.com/o1/v/t16/video3_high.mp4');
  assert.equal(posts['3003'].context.reposted_by, 'zuck');
  assert.equal(posts['3004'].record.media.length, 2);
  assert.equal(posts['3004'].record.quote_of.id, '3005');
});

test('LinkedIn: Voyager updates with images, video, articles, reshares; sponsored skipped', () => {
  const items = parsePayload('linkedin', { url: 'https://www.linkedin.com/voyager/api/graphql?queryId=voyagerFeedDashMainFeed', body: fixture('linkedin-feed.synthetic.json') });
  assertSchema(items);
  const posts = byId(items);
  assert.deepEqual(Object.keys(posts).sort(), ['7254000000000000001', '7254000000000000002', '7254000000000000003']);
  const a = posts['7254000000000000001'].record;
  assert.equal(a.author.name, 'Ada Lovelace');
  assert.equal(a.author.handle, 'ada');
  assert.equal(a.author.url, 'https://www.linkedin.com/in/ada');
  assert.match(a.author.avatar_url, /avatar-ada\/800/);
  assert.match(a.media[0].url, /photoA\/1280/);
  assert.deepEqual(a.hashtags, ['engines']);
  assert.deepEqual(a.mentions, ['Charles Babbage']);
  assert.equal(a.metrics.likes, 42);
  assert.equal(a.created_at, '2024-10-21T05:26:12.802Z', 'activity IDs carry their timestamp');
  assert.match(posts['7254000000000000002'].record.media[0].url, /mp4-720p/);
  const c = posts['7254000000000000003'].record;
  assert.equal(c.link_card.title, 'The Analytical Engine');
  assert.equal(c.quote_of.id, '7254000000000000001');
});

test('Hacker News: real front page and item page', () => {
  const front = parseDocument('hackernews', parseHTML(fixture('hn-front.html')).document);
  assertSchema(front);
  assert.equal(front.length, 30);
  const top = front[0].record;
  assert.equal(top.kind, 'story');
  assert.ok(top.title.length > 5);
  assert.ok(top.metrics.score > 0);
  assert.ok(top.author.handle);
  assert.ok(top.created_at.endsWith('Z'));

  const item = parseDocument('hackernews', parseHTML(fixture('hn-item.html')).document);
  assertSchema(item);
  const [story, ...comments] = item;
  assert.equal(story.record.kind, 'story');
  assert.ok(comments.length > 20);
  assert.ok(comments.every(c => c.record.kind === 'comment' && c.record.reply_to?.id));
  assert.ok(comments.filter(c => c.record.extra.depth === 0).every(c => c.record.reply_to.id === story.record.id));
  const nested = comments.find(c => c.record.extra.depth > 0);
  assert.notEqual(nested.record.reply_to.id, story.record.id);
  assert.equal(nested.record.thread_root.id, story.record.id);

  const noComments = parseDocument('hackernews', parseHTML(fixture('hn-item.html')).document, { hnComments: false });
  assert.equal(noComments.length, 1);
});

test('LinkedIn server-driven feed: posts, reshares, media, counts and comment requests; ads and modules skipped', () => {
  const body = fixture('linkedin-feed-sdui.synthetic.rsc');
  const items = parsePayload('linkedin', { url: 'https://www.linkedin.com/flagship-web/rsc-action/actions/pagination?sduiid=com.linkedin.sdui.pagers.feed.mainFeed', body });
  assertSchema(items);
  const posts = byId(items);
  assert.deepEqual(Object.keys(posts).sort(), ['7518100000000000000', '7518335312863961088', '7518400000000000000']);
  const a = posts['7518335312863961088'].record;
  assert.equal(a.url, 'https://www.linkedin.com/feed/update/urn:li:activity:7518335312863961088/');
  assert.deepEqual([a.author.name, a.author.handle, a.author.url, a.author.description], ['Ada Lovelace', 'ada', 'https://www.linkedin.com/in/ada/', 'Analyst at Engines']);
  assert.match(a.author.avatar_url, /400_400\/a$/);
  assert.equal(a.text, 'Shipping the engine with Charles Babbage today.\nexample.com/notes #engines');
  assert.deepEqual(a.mentions, ['Charles Babbage']);
  assert.deepEqual(a.hashtags, ['engines']);
  assert.deepEqual(a.links, [{ url: 'https://example.com/notes', text: 'example.com/notes' }]);
  assert.deepEqual(a.media.map(m => [m.type, m.url]), [
    ['image', 'https://media.licdn.com/dms/image/v2/Y/feedshare-shrink_2048/b'],
    ['video', 'https://dms.licdn.com/playlist/vid/v2/V/mp4-720p-30fp-crf28/1'],
  ]);
  assert.equal(a.media[1].duration_ms, 12500);
  assert.match(a.media[1].thumbnail_url, /videocover-high\/1$/);
  assert.deepEqual([a.metrics.likes, a.metrics.replies, a.metrics.reposts], [22, 4, 1]);
  assert.equal(a.extra.edited, true);
  assert.match(a.extra.permalink, /\/posts\/ada_shipping/);
  assert.equal(a.extra.comments_request.requestId, 'com.linkedin.sdui.feed.update.comments.fetchComment');
  assert.equal(a.created_at, '2026-10-20T15:40:22.502Z');
  assert.deepEqual(expandTarget(a), { id: a.id, request: a.extra.comments_request });

  const outer = posts['7518400000000000000'].record;
  assert.equal(outer.kind, 'quote');
  assert.equal(outer.author.name, 'Grace Hopper');
  assert.equal(outer.author.url, 'https://www.linkedin.com/in/grace/');
  assert.equal(outer.text, 'Look at this');
  assert.equal(outer.quote_of.id, '7518100000000000000');
  const inner = posts['7518100000000000000'].record;
  assert.equal(inner.author.name, 'Engine Co');
  assert.equal(inner.author.description, '1,203 followers');
  assert.equal(inner.text, 'Original announcement');
});
