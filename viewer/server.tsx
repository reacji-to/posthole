/** @jsxImportSource hono/jsx */
// posthole viewer: every post you scrolled past, as cards, in the order you saw them.
//   bun server.tsx [--dir ~/posthole] [--port 4747]
import { Hono } from 'hono';
import { parseArgs } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { cardsFor, replyTree } from './render';
import { createStore } from './store';
import { Page, ReplyTree } from './views';

const { values } = parseArgs({ options: { dir: { type: 'string' }, port: { type: 'string' } } });
const root = path.resolve((values.dir ?? process.env.POSTHOLE_DIR ?? '~/posthole').replace(/^~(?=$|\/)/, os.homedir()));
const port = Number(values.port ?? process.env.PORT ?? 4747);
const store = createStore(root);
const BATCH = 30;

// The list a request asks for: your sightings, filtered and ordered.
function selection(query: URLSearchParams) {
  const platforms = new Set(query.getAll('p'));
  const q = query.get('q')?.toLowerCase().trim();
  let list = store.sightings().filter(s => !platforms.size || platforms.has(s.platform));
  if (q) list = list.filter(s => `${s.author ?? ''} ${s.title ?? ''} ${s.text ?? ''}`.toLowerCase().includes(q));
  return query.get('order') === 'recent' ? [...list].reverse() : list;
}

async function batch(query: URLSearchParams, offset: number) {
  const list = selection(query);
  if (!list.length && query.get('q')?.trim()) {
    const clear = new URLSearchParams(query);
    clear.delete('q');
    const platform = query.getAll('p').length === 1 ? query.get('p') : null;
    const label = platform === 'linkedin' ? 'LinkedIn' : platform === 'x' ? 'X' : platform === 'bluesky' ? 'Bluesky' : platform === 'threads' ? 'Threads' : platform === 'hackernews' ? 'Hacker News' : 'saved';
    return [<div class="empty"><p>No {label} posts match “{query.get('q')}”.</p><a href={`/?${clear}`}>Clear search</a></div>];
  }
  const out = await cardsFor(store, list.slice(offset, offset + BATCH), list[offset - 1]?.at ?? null);
  const next = offset + BATCH < list.length ? `/cards?${new URLSearchParams([...query, ['offset', String(offset + BATCH)]])}` : null;
  out.push(next ? <div class="more" data-next={next}>Loading…</div> : <div class="end">That's everything you've seen{list.length ? ` · ${list.length} posts` : ''}.</div>);
  return out;
}

const app = new Hono();

app.use(async (_c, next) => { await store.refresh(); await next(); });

app.get('/', async c => {
  const query = new URL(c.req.url).searchParams;
  query.delete('offset');
  const counts = store.platforms();
  return c.html('<!doctype html>' + (
    <Page counts={counts} total={store.sightings().length} query={query}>{await batch(query, 0)}</Page>
  ));
});

app.get('/cards', async c => {
  const query = new URL(c.req.url).searchParams;
  const offset = Number(query.get('offset') ?? 0);
  query.delete('offset');
  return c.html(<>{await batch(query, offset)}</>);
});

// Saved replies under a post, nested by who replied to whom.
app.get('/replies', async c => {
  const top = await replyTree(store, c.req.query('key') ?? '');
  return c.html(top.length ? <ReplyTree nodes={top} /> : <p class="empty">No saved replies.</p>);
});

// Saved media, with byte ranges so videos can seek.
app.get('/files/*', async c => {
  const rel = decodeURIComponent(c.req.path.slice('/files/'.length));
  const file = path.resolve(root, rel);
  if (!file.startsWith(root + path.sep)) return c.text('Not found', 404);
  const blob = Bun.file(file);
  if (!(await blob.exists())) return c.text('Not found', 404);
  const size = blob.size;
  const range = c.req.header('range')?.match(/^bytes=(\d*)-(\d*)$/);
  const headers = { 'accept-ranges': 'bytes', 'content-type': blob.type, 'cache-control': 'public, max-age=86400' };
  if (!range) return new Response(blob, { headers: { ...headers, 'content-length': String(size) } });
  const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
  const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
  if (start >= size || start > end) return new Response(null, { status: 416, headers: { 'content-range': `bytes */${size}` } });
  return new Response(blob.slice(start, end + 1), { status: 206, headers: { ...headers, 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': String(end - start + 1) } });
});

const here = import.meta.dir;
app.get('/style.css', () => new Response(Bun.file(path.join(here, 'style.css'))));
app.get('/card-interactions.js', () => new Response(Bun.file(path.join(here, 'card-interactions.js'))));
app.get('/client.js', () => new Response(Bun.file(path.join(here, 'client.js'))));
app.get('/icon.png', () => new Response(Bun.file(path.join(here, '..', 'icons', '128.png'))));
app.get('/assets/:file', async c => {
  const name = c.req.param('file');
  if (!/^[a-z0-9-]+\.woff2$/.test(name)) return c.notFound();
  const file = Bun.file(path.join(here, 'assets', name));
  return await file.exists() ? new Response(file) : c.notFound();
});

console.log(`posthole viewer: http://localhost:${port}  (reading ${root})`);
export default { port, hostname: '127.0.0.1', fetch: app.fetch };
