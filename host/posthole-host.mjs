// posthole's native messaging helper. The browser starts it on demand and
// talks to it over stdin/stdout (4-byte little-endian length + JSON). It is the
// only part that touches the filesystem, and it only writes inside the root
// folder the extension names in each request.
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';

const VERSION = '0.3.0';

// ---- paths ----------------------------------------------------------------

export function resolveRoot(root) {
  if (typeof root !== 'string' || !root.trim()) throw new Error('No save folder configured.');
  const expanded = root.trim().replace(/^~(?=$|\/)/, os.homedir());
  if (!path.isAbsolute(expanded)) throw new Error(`Save folder must be an absolute path: ${root}`);
  return path.resolve(expanded);
}

// Every relative path comes from page data at some remove; never let one escape the root.
function inside(root, ...parts) {
  const target = path.resolve(root, ...parts);
  if (target !== root && !target.startsWith(root + path.sep)) throw new Error(`Path escapes the save folder: ${parts.join('/')}`);
  return target;
}

async function writeAtomic(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, data);
  await fs.rename(tmp, file);
}

async function readJson(file) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return null; }
}

// ---- record merge -----------------------------------------------------------

const empty = v => v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0);

// New values win, but never erase what an earlier, richer capture knew
// (including downloaded file names, which only the helper fills in).
export function merge(before, after) {
  if (Array.isArray(after)) {
    return Array.isArray(before) ? after.map((value, i) => merge(before[i], value)) : after;
  }
  if (after && typeof after === 'object') {
    const out = { ...(before && typeof before === 'object' && !Array.isArray(before) ? before : {}) };
    for (const [key, value] of Object.entries(after)) out[key] = empty(value) && !empty(out[key]) ? out[key] : merge(out[key], value);
    return out;
  }
  return after;
}

function setPointer(obj, pointer, value) {
  const keys = pointer.split('/').slice(1);
  let node = obj;
  for (const key of keys.slice(0, -1)) {
    if (!node || typeof node !== 'object') return false;
    node = node[key];
  }
  if (!node || typeof node !== 'object') return false;
  node[keys.at(-1)] = value;
  return true;
}

// Media order is stable in practice, but match by URL so a reordered capture can't mislabel files.
function attachFile(record, ref, url, file) {
  const media = ref.match(/^\/media\/(\d+)\/(file|thumbnail_file)$/);
  if (media && Array.isArray(record.media)) {
    const urlKey = media[2] === 'file' ? 'url' : 'thumbnail_url';
    const byUrl = record.media.findIndex(m => m?.[urlKey] === url);
    const index = byUrl >= 0 ? byUrl : Number(media[1]);
    if (record.media[index]) { record.media[index][media[2]] = file; return true; }
    return false;
  }
  return setPointer(record, ref, file);
}

async function existing(postDir, base) {
  const dir = path.dirname(path.resolve(postDir, base));
  const stem = path.basename(base);
  try {
    const names = await fs.readdir(dir);
    return names.find(n => n.startsWith(`${stem}.`) && !n.endsWith('.part') && !n.endsWith('.tmp')) ?? null;
  } catch { return null; }
}

const relFile = (base, name) => path.posix.join(path.posix.dirname(base), name).replace(/^\.\//, '');

// ---- file types -------------------------------------------------------------

const MIME_EXT = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/avif': 'avif', 'image/heic': 'heic', 'image/svg+xml': 'svg',
  'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov', 'video/mp2t': 'ts', 'application/pdf': 'pdf', 'application/vnd.apple.mpegurl': 'm3u8',
};

async function sniff(file, mime) {
  const handle = await fs.open(file, 'r');
  const head = Buffer.alloc(16);
  try { await handle.read(head, 0, 16, 0); } finally { await handle.close(); }
  if (head[0] === 0xff && head[1] === 0xd8) return 'jpg';
  if (head.subarray(0, 4).toString('hex') === '89504e47') return 'png';
  if (head.subarray(0, 4).toString() === 'RIFF' && head.subarray(8, 12).toString() === 'WEBP') return 'webp';
  if (head.subarray(0, 3).toString() === 'GIF') return 'gif';
  if (head.subarray(4, 8).toString() === 'ftyp') {
    const brand = head.subarray(8, 12).toString();
    if (/avif|avis/.test(brand)) return 'avif';
    if (/heic|heix|mif1/.test(brand)) return 'heic';
    return brand.startsWith('qt') ? 'mov' : 'mp4';
  }
  if (head.subarray(0, 4).toString('hex') === '1a45dfa3') return 'webm';
  if (head.subarray(0, 4).toString() === '%PDF') return 'pdf';
  return MIME_EXT[(mime ?? '').split(';')[0].trim().toLowerCase()] ?? 'bin';
}

// ---- git sync -------------------------------------------------------------------
// When the save folder is a git repository, everything posthole saved is committed
// and pushed, and the GitHub Pages workflow that builds the card site is installed.

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const GIT_ENV = { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${process.env.PATH ?? ''}`, GIT_TERMINAL_PROMPT: '0' };
const MAX_FILE = 95 * 1024 * 1024;      // GitHub rejects files over 100 MB in git;
const LFS_MAX = 1950 * 1024 * 1024;     // larger ones go through Git LFS (2 GB per file on GitHub).
const BATCH = 400 * 1024 * 1024;        // and pushes over 2 GB; push in smaller commits.

function git(cwd, args, { input, allowFail = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, env: GIT_ENV });
    let stdout = '', stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('error', reject);
    child.on('close', code => (code === 0 || allowFail ? resolve({ code, stdout, stderr }) : reject(new Error(`git ${args[0]}: ${stderr.trim() || stdout.trim()}`))));
    if (input !== undefined) child.stdin.end(input); else child.stdin.end();
  });
}

// Files the workflow needs, copied from this checkout so the repository builds the same cards.
const SCAFFOLD = [
  ['github/posthole.yml', '.github/workflows/posthole.yml'],
  ['github/embed.py', '.posthole/embed.py'],
  ['github/requirements.txt', '.posthole/requirements.txt'],
  ['github/README.md', '.posthole/README.md'],
  ...['icons.tsx', 'card-interactions.js', 'assets/icons.json', 'assets/chirp-regular.woff2', 'assets/chirp-bold.woff2', 'store.ts', 'views.tsx', 'render.tsx', 'build-static.tsx', 'style.css', 'client-static.js', 'package.json', 'bun.lock', 'tsconfig.json'].map(f => [`viewer/${f}`, `.posthole/viewer/${f}`]),
  ['src/schema.js', '.posthole/src/schema.js'],
  ['src/parsers/x.js', '.posthole/src/parsers/x.js'],
  ['src/sha256.js', '.posthole/src/sha256.js'],
  ['icons/128.png', '.posthole/icons/128.png'],
];
async function installScaffold(top) {
  let changed = 0;
  for (const [from, to] of SCAFFOLD) {
    const source = await fs.readFile(path.join(REPO, from)).catch(() => null);
    if (!source) continue;
    const target = path.join(top, to);
    const current = await fs.readFile(target).catch(() => null);
    if (current && current.equals(source)) continue;
    await writeAtomic(target, source);
    changed++;
  }
  return changed;
}

const IGNORE_START = '# posthole (managed)';
const IGNORE_END = '# end posthole';
async function ignoredLarge(root) {
  const text = await fs.readFile(path.join(root, '.gitignore'), 'utf8').catch(() => '');
  const start = text.indexOf(IGNORE_START), end = text.indexOf(IGNORE_END);
  return start >= 0 && end > start ? text.slice(start, end).split('\n').filter(l => l.startsWith('/')).map(l => l.slice(1)) : [];
}

async function updateIgnore(root, tooLarge) {
  const file = path.join(root, '.gitignore');
  const text = await fs.readFile(file, 'utf8').catch(() => '');
  const start = text.indexOf(IGNORE_START), end = text.indexOf(IGNORE_END);
  const large = [...new Set(tooLarge)].sort().map(f => `/${f}`);
  const block = [
    IGNORE_START, '*.part', '*.tmp', '.DS_Store',
    '# Responses that can carry sign-in material are never pushed:',
    ...['jwt', 'Jwt', 'token', 'Token', 'oauth', 'login', 'session', 'password', 'csrf', 'account_settings'].map(w => `raw/**/*${w}*`),
    '# Files too large even for Git LFS; they stay on this computer only:', ...large, IGNORE_END,
  ].join('\n');
  const next = start >= 0 && end > start ? text.slice(0, start) + block + text.slice(end + IGNORE_END.length) : `${text}${text && !text.endsWith('\n') ? '\n' : ''}${block}\n`;
  if (next !== text) await fs.writeFile(file, next);
  return large.length;
}

let syncing = null;
let lastSync = null;

export async function runSync(root) {
  const startedAt = new Date().toISOString();
  const inside = await git(root, ['rev-parse', '--show-toplevel'], { allowFail: true });
  if (inside.code !== 0) return { status: 'not-a-repo', at: startedAt };
  const top = inside.stdout.trim();
  // Only ever commit posthole's own folder: it must be the repository itself.
  if (path.resolve(top) !== path.resolve(await fs.realpath(root))) return { status: 'not-repo-root', at: startedAt, top };
  const scaffold = await installScaffold(top);
  // Changed files under the save folder (and the scaffold), with sizes.
  // Git LFS takes files GitHub won't accept in git, when it's installed.
  const lfs = (await git(top, ['lfs', 'version'], { allowFail: true })).code === 0;
  if (lfs) await git(top, ['lfs', 'install', '--local'], { allowFail: true });
  const status = await git(top, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames']);
  const entries = status.stdout.split('\0').filter(Boolean).map(e => e.slice(3));
  const tooLarge = [];
  const viaLfs = [];
  const files = [];
  const place = (rel, size) => {
    if (size > MAX_FILE && lfs && size <= LFS_MAX) { viaLfs.push(rel); files.push({ rel, size }); }
    else if (size > MAX_FILE) tooLarge.push(rel);
    else files.push({ rel, size });
  };
  for (const rel of entries) {
    if (/\.(part|tmp)$/.test(rel)) continue;
    const stat = await fs.stat(path.join(top, rel)).catch(() => null);
    place(rel, stat?.size ?? 0);
  }
  // Files an earlier sync kept local may fit through LFS now.
  for (const rel of await ignoredLarge(top)) {
    const stat = await fs.stat(path.join(top, rel)).catch(() => null);
    if (stat && !files.some(f => f.rel === rel) && !tooLarge.includes(rel)) place(rel, stat.size);
  }
  if (viaLfs.length) {
    await git(top, ['lfs', 'track', '--filename', ...viaLfs]);
    if (!files.some(f => f.rel === '.gitattributes')) files.unshift({ rel: '.gitattributes', size: 0 });
  }
  const skipped = await updateIgnore(top, tooLarge);
  if (!files.some(f => f.rel === '.gitignore')) files.unshift({ rel: '.gitignore', size: 0 });
  // Drop anything the ignore rules (just updated) now exclude.
  const ignored = new Set((await git(top, ['check-ignore', '-z', '--stdin'], { input: files.map(f => f.rel).join('\0'), allowFail: true })).stdout.split('\0').filter(Boolean));
  for (let i = files.length - 1; i >= 0; i--) if (ignored.has(files[i].rel)) files.splice(i, 1);
  const identity = (await git(top, ['config', 'user.email'], { allowFail: true })).stdout.trim() ? [] : ['-c', 'user.name=posthole', '-c', 'user.email=posthole@localhost'];
  // symbolic-ref also names the branch of a repository with no commits yet.
  const branch = (await git(top, ['symbolic-ref', '--short', 'HEAD'], { allowFail: true })).stdout.trim() || 'main';
  const remote = (await git(top, ['remote', 'get-url', 'origin'], { allowFail: true })).stdout.trim() || null;
  let commits = 0, committedFiles = 0, bytes = 0;
  // Batches keep each push well under GitHub's 2 GB limit.
  const batches = [];
  for (const file of files) {
    if (!batches.length || batches.at(-1).size + file.size > BATCH) batches.push({ size: 0, files: [] });
    batches.at(-1).files.push(file.rel);
    batches.at(-1).size += file.size;
  }
  for (const batch of batches) {
    await git(top, ['add', '-A', '--pathspec-from-file=-', '--pathspec-file-nul'], { input: batch.files.join('\0') });
    const staged = await git(top, ['diff', '--cached', '--quiet'], { allowFail: true });
    if (staged.code === 0) continue;
    const count = batch.files.length;
    await git(top, [...identity, 'commit', '-q', '-m', `posthole: ${count} file${count === 1 ? '' : 's'} (${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC)`]);
    commits++; committedFiles += count; bytes += batch.size;
    if (remote) await push(top, branch);
  }
  if (remote && !commits) {
    // Nothing new, but earlier commits may not have reached the remote yet.
    const ahead = await git(top, ['rev-list', '--count', `origin/${branch}..HEAD`], { allowFail: true });
    if (ahead.code !== 0 || Number(ahead.stdout.trim()) > 0) await push(top, branch);
  }
  return { status: commits ? (remote ? 'pushed' : 'committed') : 'clean', at: startedAt, finished_at: new Date().toISOString(), commits, files: committedFiles, bytes, skipped, lfs: viaLfs.length, scaffold, remote, branch };
}

async function push(top, branch) {
  const first = await git(top, ['push', '-u', 'origin', `HEAD:${branch}`], { allowFail: true });
  if (first.code === 0) return;
  // Someone else pushed (another computer): replay ours on top and try once more.
  if (/rejected|fetch first|non-fast-forward/.test(first.stderr)) {
    await git(top, ['pull', '--rebase', '--autostash', 'origin', branch]);
    await git(top, ['push', '-u', 'origin', `HEAD:${branch}`]);
    return;
  }
  throw new Error(`git push: ${first.stderr.trim()}`);
}

// ---- operations -------------------------------------------------------------

const open = new Map();

export const ops = {
  async hello({ root }) {
    let resolved = null, writable = false, rootError = null;
    try {
      resolved = resolveRoot(root);
      await fs.mkdir(resolved, { recursive: true });
      await fs.access(resolved, fs.constants.W_OK);
      writable = true;
    } catch (error) { rootError = error.message; }
    return { version: VERSION, node: process.version, root: resolved, writable, rootError };
  },

  async save({ root: rawRoot, day, posts }) {
    const root = resolveRoot(rawRoot);
    const results = [];
    const lines = [];
    for (const post of posts) {
      const postDir = inside(root, post.dir);
      const file = path.join(postDir, 'post.json');
      const before = await readJson(file);
      const capture = post.captured ?? {};
      const record = merge(before, post.record);
      record.captured = {
        first_at: before?.captured?.first_at ?? capture.at,
        last_at: capture.at,
        times_seen: (before?.captured?.times_seen ?? 0) + 1,
        first_page: before?.captured?.first_page ?? capture.page ?? null,
        endpoint: capture.endpoint ?? before?.captured?.endpoint ?? null,
        // Set when the post came from fetching another post's reply thread rather than from your scrolling.
        thread_of: before?.captured?.thread_of !== undefined && !capture.thread_of ? before.captured.thread_of : capture.thread_of ?? null,
      };
      const need = [];
      for (const [index, asset] of (post.assets ?? []).entries()) {
        inside(root, post.dir, asset.base);
        const found = await existing(postDir, asset.base);
        if (found) attachFile(record, asset.ref, asset.url, relFile(asset.base, found));
        else need.push(index);
      }
      await writeAtomic(file, `${JSON.stringify(record, null, 2)}\n`);
      if (post.source !== undefined) await writeAtomic(path.join(postDir, 'source.json'), `${JSON.stringify(post.source, null, 2)}\n`);
      lines.push(JSON.stringify({
        at: capture.at, key: record.key ?? null, platform: record.platform, id: record.id, kind: record.kind, url: record.url,
        author: record.author?.handle ?? record.author?.name ?? null, created_at: record.created_at,
        title: record.title, text: (record.text ?? '').slice(0, 280), path: `${post.dir}/post.json`,
        page: capture.page ?? null, ...(capture.reposted_by ? { reposted_by: capture.reposted_by } : {}),
        ...(capture.thread_of ? { thread_of: capture.thread_of } : {}), new: !before,
      }));
      results.push({ dir: post.dir, isNew: !before, need });
    }
    if (lines.length) {
      const indexFile = inside(root, 'index', `${/^\d{4}-\d{2}-\d{2}$/.test(day) ? day : new Date().toISOString().slice(0, 10)}.jsonl`);
      await fs.mkdir(path.dirname(indexFile), { recursive: true });
      await fs.appendFile(indexFile, `${lines.join('\n')}\n`);
    }
    return { posts: results };
  },

  async asset({ root: rawRoot, dir, base, ref, url, seq, data, done, mime }) {
    const root = resolveRoot(rawRoot);
    const postDir = inside(root, dir);
    const stem = inside(root, dir, base);
    const part = `${stem}.part`;
    if (seq === 0) {
      await open.get(part)?.close().catch(() => {});
      await fs.mkdir(path.dirname(part), { recursive: true });
      open.set(part, await fs.open(part, 'w'));
    }
    const handle = open.get(part);
    if (!handle) throw new Error('Asset upload out of order.');
    if (data) await handle.write(Buffer.from(data, 'base64'));
    if (!done) return { ok: true };
    await handle.close();
    open.delete(part);
    const name = `${path.basename(stem)}.${await sniff(part, mime)}`;
    await fs.rename(part, path.join(path.dirname(stem), name));
    const file = relFile(base, name);
    const postFile = path.join(postDir, 'post.json');
    const record = await readJson(postFile);
    if (record && attachFile(record, ref, url, file)) await writeAtomic(postFile, `${JSON.stringify(record, null, 2)}\n`);
    return { file };
  },

  async assetAbort({ root: rawRoot, dir, base }) {
    const part = `${inside(resolveRoot(rawRoot), dir, base)}.part`;
    await open.get(part)?.close().catch(() => {});
    open.delete(part);
    await fs.rm(part, { force: true });
    return { ok: true };
  },

  // Raw API responses, gzipped: raw/<platform>/<day>/<time>-<seq>-<label>.json.gz
  async raw({ root: rawRoot, platform, day, name, record }) {
    const root = resolveRoot(rawRoot);
    const date = /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : new Date().toISOString().slice(0, 10);
    const file = inside(root, 'raw', String(platform).replace(/[^a-z]/g, ''), date, `${String(name).replace(/[^A-Za-z0-9._-]/g, '-')}.json.gz`);
    await writeAtomic(file, gzipSync(JSON.stringify(record)));
    return { file: path.relative(root, file) };
  },

  // The newest build in this checkout's dist/, so a running extension can reload itself after `npm run build`.
  async build() {
    const file = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'dist', 'build.json');
    return readJson(file) ?? {};
  },

  // Starts a sync in the background (pushes can take minutes) and reports the last result.
  async sync({ root: rawRoot }) {
    const root = resolveRoot(rawRoot);
    if (!syncing) {
      syncing = runSync(root)
        .then(result => { lastSync = result; }, error => { lastSync = { status: 'error', at: new Date().toISOString(), error: error.message }; })
        .finally(() => { syncing = null; });
    }
    return { running: true, last: lastSync };
  },

  async syncStatus() {
    return { running: Boolean(syncing), last: lastSync };
  },

  async pickFolder() {
    if (process.platform !== 'darwin') throw new Error('Folder picker is only available on macOS; type a path instead.');
    const script = 'POSIX path of (choose folder with prompt "Choose where posthole saves posts")';
    return new Promise(resolve => execFile('osascript', ['-e', script], (error, stdout) => resolve({ path: error ? null : stdout.trim().replace(/\/$/, '') || null })));
  },

  async open({ root: rawRoot }) {
    const root = resolveRoot(rawRoot);
    await fs.mkdir(root, { recursive: true });
    const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
    return new Promise((resolve, reject) => execFile(opener, [root], error => (error ? reject(error) : resolve({ ok: true }))));
  },
};

// ---- native messaging transport ------------------------------------------------

function send(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  process.stdout.write(Buffer.concat([header, body]));
}

export async function handle(message) {
  const op = ops[message?.op];
  if (!op) return { id: message?.id, error: `Unknown operation: ${message?.op}` };
  try { return { id: message.id, result: await op(message) }; } catch (error) { return { id: message.id, error: error.message }; }
}

function serve() {
  let buffer = Buffer.alloc(0);
  let chain = Promise.resolve();
  // Messages are handled strictly in order, so a post.json is always written before its assets.
  createReadStream(null, { fd: 0 }).on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4) {
      const length = buffer.readUInt32LE(0);
      if (buffer.length < 4 + length) break;
      const message = JSON.parse(buffer.subarray(4, 4 + length).toString('utf8'));
      buffer = buffer.subarray(4 + length);
      chain = chain.then(() => handle(message)).then(send);
    }
  }).on('end', () => chain.then(() => syncing).then(() => process.exit(0)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) serve();
