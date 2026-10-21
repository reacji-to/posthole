/** @jsxImportSource hono/jsx */
import { test, expect } from 'bun:test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseHTML } from 'linkedom';
import { Card } from './views';
import { createStore } from './store';
import { makePost } from '../src/schema.js';
import { presentationOf } from '../src/parsers/x.js';

const captured = { first_at: '2026-10-20T12:00:00Z', last_at: '2026-10-20T12:00:00Z', times_seen: 1, first_page: null, thread_of: null };
const sample = (platform = 'x') => ({ ...makePost(platform, {
  id: '2112662021884043494', url: 'https://example.com/post', author: { name: 'Ada', handle: 'ada', verified: true },
  created_at: '2026-10-20T10:00:00Z', text: 'Full text <script>alert(1)</script>',
  metrics: { likes: 1200, replies: 3 }, extra: { display: { preview_text: 'Saved feed preview' } },
}), captured });

for (const platform of ['x', 'linkedin', 'bluesky', 'threads', 'hackernews']) {
  test(`${platform}: renders selectable text and SVG controls, keeps archive UI outside card`, () => {
    const post = sample(platform);
    const { document } = parseHTML(String(<Card post={post} folder="x/123" key="x:123" saved={3} />));
    expect(document.querySelector(`article.${platform}`)).not.toBeNull();
    expect(document.querySelector('script')).toBeNull();
    expect(document.querySelector('.card .replies-toggle')).toBeNull();
    expect(document.querySelector('.replies-toggle')?.nextElementSibling?.className).toBe('replies');
    expect(document.querySelector('.text')?.textContent).toContain(platform === 'x' ? 'Saved feed preview' : 'Full text');
  });
}

test('X preview, saved age, media path and quote remain data driven', () => {
  const post = sample();
  post.media = [{ type: 'video', file: '01.mp4', url: 'https://example.com/video.mp4', thumbnail_file: '01-thumb.jpg', thumbnail_url: null, alt: null, width: 1280, height: 720, duration_ms: 1000 }];
  const html = String(<Card post={post} folder="x/123" key="x:123" saved={0} quoted={{post: sample(), folder: 'x/456'}} />);
  const { document } = parseHTML(html);
  expect(document.querySelector('time')?.textContent).toBe('2h');
  expect(document.querySelector('time')?.hasAttribute('data-format')).toBe(false);
  expect(document.querySelector('video')?.getAttribute('src')).toBe('/files/x/123/01.mp4');
  expect(document.querySelector('video')?.getAttribute('poster')).toBe('/files/x/123/01-thumb.jpg');
  expect(document.querySelector('[data-full]')?.textContent).toBe(post.text);
  expect(document.querySelector('.quoted .name')?.textContent).toBe('Ada');
});

test('old source records recover note previews; static builds invalidate obsolete markup and ship fonts', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'posthole-viewer-'));
  try {
    const data = path.join(root, 'data'); const out = path.join(root, 'site');
    await mkdir(path.join(data, 'index'), { recursive: true });
    await mkdir(path.join(data, 'x/123'), { recursive: true });
    const post = sample(); post.extra = {};
    const source = { legacy: { full_text: 'Native preview', display_text_range: [0, 14], entities: {} }, note_tweet: { note_tweet_results: { result: { text: 'The entire note' } } } };
    expect(presentationOf(source).preview_text).toBe('Native preview');
    await writeFile(path.join(data, 'x/123/post.json'), JSON.stringify(post));
    await writeFile(path.join(data, 'x/123/source.json'), JSON.stringify(source));
    await writeFile(path.join(data, 'index/2026-10-20.jsonl'), JSON.stringify({ at: captured.first_at, key: 'x:123', platform: 'x', id: '123', path: 'x/123/post.json' }) + '\n');
    const store = createStore(data); await store.refresh();
    expect((await store.post('x:123'))?.extra.display.preview_text).toBe('Native preview');
    const build = () => {
      const result = Bun.spawnSync(['bun', path.join(import.meta.dir, 'build-static.tsx'), '--dir', data, '--out', out]);
      expect(result.stderr.toString()).toBe('');
      expect(result.exitCode).toBe(0);
    };
    build();
    expect((await readFile(path.join(out, 'chunks/000001.html'), 'utf8'))).toContain('Native preview');
    expect((await readFile(path.join(out, 'assets/chirp-regular.woff2'))).length).toBeGreaterThan(1000);
    expect((await readFile(path.join(out, 'card-interactions.js'), 'utf8'))).toContain('aria-expanded');
    build();
    expect(JSON.parse(await readFile(path.join(out, 'state.json'), 'utf8')).total).toBe(1);
    const state = JSON.parse(await readFile(path.join(out, 'state.json'), 'utf8'));
    state.renderer_hash = 'obsolete';
    await writeFile(path.join(out, 'state.json'), JSON.stringify(state));
    await writeFile(path.join(out, 'chunks/000001.html'), 'OLD MARKUP');
    build();
    expect((await readFile(path.join(out, 'chunks/000001.html'), 'utf8'))).not.toContain('OLD MARKUP');
    expect(JSON.parse(await readFile(path.join(out, 'state.json'), 'utf8')).total).toBe(1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

import { Page } from './views';
import { INTERFACES, interfaceOf } from './interfaces';
for (const view of Object.keys(INTERFACES)) {
  test(`${view}: presentation preserves source, media, escaped text and reply lookup`, () => {
    const post = sample('linkedin');
    post.media = [{ type:'video', file:'01.mp4',url:null,thumbnail_file:'01-thumb.jpg',thumbnail_url:null,alt:null,width:800,height:600,duration_ms:2000 }];
    const { document } = parseHTML(String(<Card post={post} folder="linkedin/123" key="linkedin:123" archiveKey="linkedin:123" saved={2} view={interfaceOf(view)} />));
    expect(document.querySelector('script')).toBeNull();
    expect(document.querySelector('video')?.getAttribute('src')).toBe('/files/linkedin/123/01.mp4');
    expect(document.querySelector('.text')?.textContent).toContain('<script>alert(1)</script>');
    const toggle = document.querySelector('.replies-toggle');
    expect(toggle?.nextElementSibling?.className).toBe('replies');
    expect(toggle?.getAttribute('data-href')).toContain('linkedin%3A123');
    if (view !== 'original') {
      expect(document.querySelector('.interface-author')?.textContent).toContain('LinkedIn');
      expect(document.querySelector('.original-link')?.getAttribute('href')).toBe(post.url);
    }
  });
}
test('interface selection keeps search, order and source filters independent', () => {
  const query = new URLSearchParams('view=ipod-color&p=linkedin&q=hello&order=recent');
  const { document } = parseHTML(String(<Page counts={{x:3,linkedin:2}} total={5} query={query}>posts</Page>));
  expect(document.body.dataset.view).toBe('ipod-color');
  expect(document.querySelector('.search [name=view]')?.getAttribute('value')).toBe('ipod-color');
  expect(document.querySelector('.interface-picker [name=q]')?.getAttribute('value')).toBe('hello');
  expect(document.querySelector('.interface-picker [name=p]')?.getAttribute('value')).toBe('linkedin');
  expect(document.querySelector('.interface-picker [name=order]')?.getAttribute('value')).toBe('recent');
  expect(document.querySelectorAll('.click-wheel button').length).toBe(5);
  expect(interfaceOf('__proto__')).toBe('original');
  expect(interfaceOf('<script>')).toBe('original');
});
