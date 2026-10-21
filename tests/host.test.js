import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { merge } from '../host/posthole-host.mjs';

const HOST = fileURLToPath(new URL('../host/posthole-host.mjs', import.meta.url));

// Talks to the helper exactly as the browser does: length-prefixed JSON over stdio.
function startHost() {
  const child = spawn(process.execPath, [HOST], { stdio: ['pipe', 'pipe', 'inherit'] });
  let buffer = Buffer.alloc(0);
  const waiting = new Map();
  child.stdout.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4 && buffer.length >= 4 + buffer.readUInt32LE(0)) {
      const length = buffer.readUInt32LE(0);
      const message = JSON.parse(buffer.subarray(4, 4 + length));
      buffer = buffer.subarray(4 + length);
      waiting.get(message.id)?.(message);
    }
  });
  let id = 0;
  const call = (op, args = {}) => new Promise(resolve => {
    const body = Buffer.from(JSON.stringify({ id: ++id, op, ...args }));
    const header = Buffer.alloc(4);
    header.writeUInt32LE(body.length);
    waiting.set(id, resolve);
    child.stdin.write(Buffer.concat([header, body]));
  });
  return { call, stop: () => child.stdin.end() };
}

const record = (extra = {}) => ({
  schema: 'posthole.post/1', platform: 'x', id: '1001', url: 'https://x.com/ada/status/1001', kind: 'post',
  author: { id: '11', handle: 'ada', name: 'Ada', url: null, description: null, verified: true, avatar_url: 'https://pbs.twimg.com/a.jpg', avatar_file: null },
  created_at: '2026-10-20T18:00:00.000Z', title: null, text: 'hello', lang: 'en', links: [], mentions: [], hashtags: [],
  media: [{ type: 'image', url: 'https://pbs.twimg.com/media/P.jpg?name=orig', file: null, mime: null, alt: null, width: 1, height: 1, duration_ms: null, thumbnail_url: null, thumbnail_file: null }],
  link_card: null, reply_to: null, thread_root: null, quote_of: null,
  metrics: { likes: 1, reposts: 0, quotes: 0, replies: 0, views: 10, bookmarks: 0, score: null }, extra: {}, ...extra,
});
const assets = [
  { url: 'https://pbs.twimg.com/media/P.jpg?name=orig', ref: '/media/0/file', base: '01', kind: 'image' },
  { url: 'https://pbs.twimg.com/a.jpg', ref: '/author/avatar_file', base: '../_avatars/11-abcd1234', kind: 'avatar' },
];
const JPEG = Buffer.from('ffd8ffe000104a46494600010100000100010000ffd9', 'hex');

test('helper saves posts, streams assets, merges re-sightings and stays inside the root', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'posthole-'));
  const { call, stop } = startHost();
  try {
    const hello = await call('hello', { root });
    assert.equal(hello.result.writable, true);

    const first = await call('save', { root, day: '2026-10-20', posts: [{ dir: 'x/1001', record: record(), source: { raw: true }, captured: { at: '2026-10-20T18:01:00.000Z', page: 'https://x.com/home', endpoint: 'graphql:HomeTimeline' }, assets }] });
    assert.deepEqual(first.result.posts, [{ dir: 'x/1001', isNew: true, need: [0, 1] }]);

    // Two chunks for the image, one for the avatar.
    await call('asset', { root, dir: 'x/1001', ...assets[0], seq: 0, data: JPEG.subarray(0, 10).toString('base64'), done: false });
    const done = await call('asset', { root, dir: 'x/1001', ...assets[0], seq: 1, data: JPEG.subarray(10).toString('base64'), done: true, mime: 'image/jpeg' });
    assert.equal(done.result.file, '01.jpg');
    await call('asset', { root, dir: 'x/1001', ...assets[1], seq: 0, data: JPEG.toString('base64'), done: true, mime: 'image/jpeg' });

    const saved = JSON.parse(fs.readFileSync(path.join(root, 'x/1001/post.json')));
    assert.equal(saved.media[0].file, '01.jpg');
    assert.equal(saved.author.avatar_file, '../_avatars/11-abcd1234.jpg');
    assert.deepEqual(fs.readFileSync(path.join(root, 'x/1001/01.jpg')), JPEG);
    assert.ok(fs.existsSync(path.join(root, 'x/_avatars/11-abcd1234.jpg')));
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'x/1001/source.json'))), { raw: true });

    // Seen again later: new metrics win, files and first sighting are kept, nothing re-downloads.
    const again = await call('save', { root, day: '2026-10-21', posts: [{ dir: 'x/1001', record: record({ metrics: { ...record().metrics, likes: 99 } }), captured: { at: '2026-10-21T09:00:00.000Z', page: 'https://x.com/ada' }, assets }] });
    assert.deepEqual(again.result.posts[0], { dir: 'x/1001', isNew: false, need: [] });
    const merged = JSON.parse(fs.readFileSync(path.join(root, 'x/1001/post.json')));
    assert.equal(merged.metrics.likes, 99);
    assert.equal(merged.media[0].file, '01.jpg');
    assert.equal(merged.captured.first_at, '2026-10-20T18:01:00.000Z');
    assert.equal(merged.captured.last_at, '2026-10-21T09:00:00.000Z');
    assert.equal(merged.captured.times_seen, 2);

    const index = fs.readFileSync(path.join(root, 'index/2026-10-20.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(index[0].path, 'x/1001/post.json');
    assert.equal(index[0].new, true);
    assert.ok(fs.existsSync(path.join(root, 'index/2026-10-21.jsonl')));

    const raw = await call('raw', { root, platform: 'x', day: '2026-10-20', name: '120000-000-00001-graphql-HomeTimeline', record: { url: 'https://x.com/i/api/graphql/q/HomeTimeline', body: '{"data":1}' } });
    assert.equal(raw.result.file, 'raw/x/2026-10-20/120000-000-00001-graphql-HomeTimeline.json.gz');
    assert.equal(JSON.parse(gunzipSync(fs.readFileSync(path.join(root, raw.result.file)))).body, '{"data":1}');

    const escape = await call('save', { root, day: '2026-10-20', posts: [{ dir: '../outside', record: record(), captured: {}, assets: [] }] });
    assert.match(escape.error, /escapes/);
    const sneaky = await call('asset', { root, dir: 'x/1001', base: '../../../evil', ref: '/x', url: 'https://x', seq: 0, data: '', done: true });
    assert.match(sneaky.error, /escapes/);
    assert.ok(!fs.existsSync(path.join(path.dirname(root), 'outside')));
  } finally {
    stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('merge keeps earlier knowledge when a later capture is sparser', () => {
  const before = { text: 'full', media: [{ url: 'a', file: '01.jpg' }], metrics: { likes: 1, views: 5 } };
  const after = { text: '', media: [{ url: 'a2', file: null }], metrics: { likes: 2, views: null } };
  assert.deepEqual(merge(before, after), { text: 'full', media: [{ url: 'a2', file: '01.jpg' }], metrics: { likes: 2, views: 5 } });
});

test('sync commits and pushes the save folder, installs the site workflow, and is a no-op when clean', async () => {
  const { runSync } = await import('../host/posthole-host.mjs');
  const { execFileSync } = await import('node:child_process');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'posthole-git-'));
  const root = path.join(base, 'data');
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  try {
    git(base, 'init', '-q', '--bare', 'remote.git');
    fs.mkdirSync(root);
    git(root, 'init', '-q', '-b', 'main');
    git(root, 'remote', 'add', 'origin', path.join(base, 'remote.git'));
    assert.equal((await runSync(path.join(base))).status, 'not-a-repo');
    fs.mkdirSync(path.join(root, 'x', '1001'), { recursive: true });
    fs.writeFileSync(path.join(root, 'x', '1001', 'post.json'), '{"key":"x:1001"}');
    fs.writeFileSync(path.join(root, 'x', '1001', '01.jpg.part'), 'partial download');
    const first = await runSync(root);
    assert.equal(first.status, 'pushed');
    assert.equal(first.branch, 'main');
    const pushed = git(path.join(base, 'remote.git'), 'ls-tree', '-r', '--name-only', 'main').split('\n');
    assert.ok(pushed.includes('x/1001/post.json'));
    assert.ok(pushed.includes('.github/workflows/posthole.yml'));
    assert.ok(pushed.includes('.posthole/viewer/build-static.tsx'));
    assert.ok(!pushed.some(f => f.endsWith('.part')), 'partial downloads stay local');
    assert.equal((await runSync(root)).status, 'clean');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
