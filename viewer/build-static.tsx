/** @jsxImportSource hono/jsx */
// Builds the static card site incrementally: each run appends only the posts seen
// since the last run and refreshes reply threads that gained replies.
//   bun build-static.tsx --dir <data repo> --out <site dir> [--media-base https://raw.githubusercontent.com/o/r/main/]
// Without --media-base the cards use each site's original media URLs.
import { parseArgs } from 'node:util';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile, copyFile, appendFile, rm, cp } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { cardsFor, replyTree } from './render';
import { createStore } from './store';
import { reacjiKey } from '../src/schema.js';
import { files, ReplyTree, StaticPage, type FileKind } from './views';
import sharp from 'sharp';

const { values } = parseArgs({ options: { dir: { type: 'string' }, out: { type: 'string' }, 'media-base': { type: 'string' }, 'db-url': { type: 'string' }, chunk: { type: 'string' }, 'copy-media': { type: 'boolean' }, rebuild: { type: 'boolean' } } });
if (!values.dir || !values.out) { console.error('Usage: bun build-static.tsx --dir <data> --out <site> [--media-base URL]'); process.exit(1); }
const out = path.resolve(values.out);
const CHUNK = Number(values.chunk ?? 100);
files.base = values['media-base'] ? values['media-base'].replace(/\/?$/, '/') : null;

// --copy-media (private repositories): the public site can't load files from the repository,
// so the images it shows are copied in, resized to WebP. Videos link to their original.
// Reply threads copy only avatars, which keeps the site within GitHub Pages' size limit.
const pendingCopies = new Map<string, { bytes: Buffer; kind: FileKind }>();
let copyImages = true;
const dataDir = path.resolve(values.dir!);
function readSaved(rel: string): Buffer | null {
  try { return readFileSync(path.join(dataDir, rel)); } catch { /* not on disk: sparse checkout */ }
  const shown = Bun.spawnSync(['git', '-C', dataDir, 'show', `HEAD:${rel}`]);
  if (shown.exitCode !== 0) return null;
  const bytes = Buffer.from(shown.stdout);
  return bytes.subarray(0, 40).toString().startsWith('version https://git-lfs') ? null : bytes;
}
if (values['copy-media']) {
  files.resolve = (rel: string, kind: FileKind) => {
    if (kind === 'video' || (kind === 'image' && !copyImages)) return null;
    const target = `media/${rel.replace(/\.[a-z0-9]+$/i, '')}.webp`;
    if (pendingCopies.has(target) || existsSync(path.join(out, target))) return target;
    const bytes = readSaved(rel);
    if (!bytes) return null;
    pendingCopies.set(target, { bytes, kind });
    return target;
  };
}
// In a partial clone (the workflow's checkout has no media), fetch every image this run
// will copy in one request rather than one request per file.
async function prefetch(keys: string[], imagesFor: Set<string>) {
  const paths = new Set<string>();
  for (const key of keys) {
    const post = await store.post(key);
    if (!post) continue;
    const folder = store.folderOf(key);
    const add = (file: string | null) => { if (file) paths.add(path.posix.normalize(path.posix.join(folder, file))); };
    add(post.author.avatar_file);
    if (!imagesFor.has(key)) continue;
    for (const m of post.media) { if (m.type === 'image') add(m.file); add(m.thumbnail_file); }
    add(post.link_card?.image_file ?? null);
  }
  const missing = [...paths].filter(p => !existsSync(path.join(dataDir, p)) && !existsSync(path.join(out, `media/${p.replace(/\.[a-z0-9]+$/i, '')}.webp`)));
  if (!missing.length) return 0;
  const oids: string[] = [];
  for (let i = 0; i < missing.length; i += 500) {
    const listed = Bun.spawnSync(['git', '-C', dataDir, 'ls-tree', '-z', 'HEAD', '--', ...missing.slice(i, i + 500)]);
    for (const entry of listed.stdout.toString().split('\0')) {
      const oid = entry.match(/^\d+ blob ([0-9a-f]{40,64})\t/)?.[1];
      if (oid) oids.push(oid);
    }
  }
  if (!oids.length) return 0;
  Bun.spawnSync(['git', '-C', dataDir, '-c', 'fetch.negotiationAlgorithm=noop', 'fetch', 'origin', '--no-tags', '--no-write-fetch-head', '--recurse-submodules=no', '--filter=blob:none', '--stdin'],
    { stdin: Buffer.from(`${oids.join('\n')}\n`) });
  return oids.length;
}

async function writeCopies() {
  for (const [target, { bytes, kind }] of pendingCopies) {
    const file = path.join(out, target);
    await mkdir(path.dirname(file), { recursive: true });
    const size = kind === 'avatar' ? { width: 96, height: 96, fit: 'cover' as const } : { width: 1200, height: 1600, fit: 'inside' as const };
    try {
      await sharp(bytes, { animated: kind !== 'avatar' }).rotate().resize({ ...size, withoutEnlargement: true }).webp({ quality: 78 }).toFile(file);
    } catch {
      await writeFile(file, bytes);
    }
  }
}

type Chunk = { file: string; count: number; first_at: string; last_at: string };
type State = { last_at: string; replies_at: string; total: number; chunks: Chunk[]; updated_at?: string; renderer_hash?: string };

const readJson = async <T,>(file: string, fallback: T): Promise<T> => { try { return JSON.parse(await readFile(file, 'utf8')); } catch { return fallback; } };
const repliesFile = (key: string) => `replies/${key.replace(':', '-')}.html`;

const store = createStore(path.resolve(values.dir));
await store.refresh();
// Existing chunks contain HTML: updating CSS alone leaves old markup behind.
// Invalidate them whenever the renderer or its asset configuration changes.
const here = import.meta.dir;
const hash = createHash('sha256');
for (const file of ['views.tsx', 'render.tsx', 'store.ts', 'icons.tsx', 'style.css', 'client-static.js', 'card-interactions.js', 'assets/icons.json', 'assets/chirp-regular.woff2', 'assets/chirp-bold.woff2', '../src/parsers/x.js']) hash.update(await readFile(path.join(here, file)));
hash.update(JSON.stringify({ media: files.base, copy: values['copy-media'] ?? false, chunk: CHUNK }));
const rendererHash = hash.digest('hex');
const previous = await readJson<State>(path.join(out, 'state.json'), { last_at: '', replies_at: '', total: 0, chunks: [] });
const rebuild = values.rebuild || previous.renderer_hash !== rendererHash;
if (rebuild) for (const dir of ['chunks', 'replies']) await rm(path.join(out, dir), { recursive: true, force: true });
const state: State = rebuild
  ? { last_at: '', replies_at: '', total: 0, chunks: [] }
  : previous;
state.renderer_hash = rendererHash;
const fresh = store.sightings().filter(s => s.at > state.last_at);
const changedThreads = store.threadsChangedSince(state.replies_at);
await mkdir(path.join(out, 'chunks'), { recursive: true });
await mkdir(path.join(out, 'replies'), { recursive: true });

if (values['copy-media']) {
  const quoted = (await Promise.all(fresh.map(async s => (await store.post(s.key ?? `${s.platform}:${s.id}`))?.quote_of))).filter(Boolean);
  const seenKeys = fresh.map(s => s.key ?? `${s.platform}:${s.id}`);
  const replyKeys = [...new Set([...changedThreads, ...seenKeys])].flatMap(k => store.threadKeys(k));
  const quotedKeys = quoted.map(q => reacjiKey(q!.platform, q!.id, q!.url));
  const fetched = await prefetch([...seenKeys, ...quotedKeys, ...replyKeys], new Set([...seenKeys, ...quotedKeys]));
  if (fetched) console.log(`Fetched ${fetched} media files in one request.`);
}

// Append cards, filling the last chunk before starting a new one.
let previousAt: string | null = state.last_at || null;
for (let i = 0; i < fresh.length;) {
  let chunk = state.chunks.at(-1);
  if (!chunk || chunk.count >= CHUNK) {
    chunk = { file: `chunks/${String(state.chunks.length + 1).padStart(6, '0')}.html`, count: 0, first_at: fresh[i].at, last_at: fresh[i].at };
    state.chunks.push(chunk);
    await writeFile(path.join(out, chunk.file), '');
  }
  const take = fresh.slice(i, i + (CHUNK - chunk.count));
  const html = (await cardsFor(store, take, previousAt, repliesFile)).map(String).join('');
  await appendFile(path.join(out, chunk.file), html);
  chunk.count += take.length;
  chunk.last_at = take.at(-1)!.at;
  previousAt = chunk.last_at;
  i += take.length;
}

// Reply threads: refresh those that changed, and any for posts appended now.
copyImages = false;
const threadRoots = new Set([...changedThreads, ...fresh.map(s => s.key ?? `${s.platform}:${s.id}`)]);
let threadsWritten = 0;
for (const rootKey of threadRoots) {
  const top = await replyTree(store, rootKey);
  if (!top.length) continue;
  await writeFile(path.join(out, repliesFile(rootKey)), String(<ReplyTree nodes={top} />));
  threadsWritten++;
}

state.total += fresh.length;
if (fresh.length) state.last_at = fresh.at(-1)!.at;
// The newest reply sighting seen so far; the next run refreshes only threads that grew after it.
for (const s of store.allLines()) if (s.thread_of && s.at > state.replies_at) state.replies_at = s.at;
state.updated_at = new Date().toISOString();

await writeCopies();
await writeFile(path.join(out, 'state.json'), JSON.stringify(state, null, 1));
await writeFile(path.join(out, 'chunks.json'), JSON.stringify({ total: state.total, updated_at: state.updated_at, chunks: state.chunks }));
await writeFile(path.join(out, 'index.html'), '<!doctype html>' + String(<StaticPage total={state.total} updatedAt={state.updated_at} dbUrl={values['db-url']} />));
await copyFile(path.join(here, 'style.css'), path.join(out, 'style.css'));
await cp(path.join(here, 'assets'), path.join(out, 'assets'), { recursive: true });
await copyFile(path.join(here, 'client-static.js'), path.join(out, 'client.js'));
await copyFile(path.join(here, 'card-interactions.js'), path.join(out, 'card-interactions.js'));
await copyFile(path.join(here, '..', 'icons', '128.png'), path.join(out, 'icon.png')).catch(() => {});
await writeFile(path.join(out, '.nojekyll'), '');

const changed = rebuild || fresh.length > 0 || threadsWritten > 0;
console.log(`${fresh.length} new posts, ${threadsWritten} reply threads updated, ${pendingCopies.size} images copied, ${state.total} posts in the site.`);
if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `changed=${changed}\nnew=${fresh.length}\n`);
