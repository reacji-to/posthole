import { createAutoScroller } from './auto-scroll.js';
import { loadSettings, saveSettings } from './settings.js';
import { expandTarget } from './expand.js';
import { parsePayload } from './parsers/index.js';

// Owns the connection to the native helper (which writes files), de-duplicates
// posts across re-renders, and downloads assets in the background.
const autoScroller = createAutoScroller(chrome, loadSettings);
const HOST = 'com.imbue.posthole';
const DEDUPE_MS = 10 * 60 * 1000;
const CHUNK = 1024 * 1024;
const ASSET_HOSTS = /(^|\.)(twimg\.com|bsky\.app|bsky\.network|cdninstagram\.com|fbcdn\.net|licdn\.com)$/;

// ---- native helper --------------------------------------------------------

let port = null;
let nextId = 1;
const pending = new Map();
const state = { hostInfo: null, hostError: null };
// An open native port keeps the worker and helper alive; let both rest when idle.
let idleTimer = null;
const idleSoon = () => {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => { if (port && !pending.size && !assetsRunning && !assetJobs.length && !Object.values(threads.running).some(Boolean) && !git.running) { port.disconnect(); port = null; } }, 3 * 60 * 1000);
};

function connect() {
  port = chrome.runtime.connectNative(HOST);
  port.onMessage.addListener(message => {
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error)); else waiter.resolve(message.result);
    idleSoon();
  });
  port.onDisconnect.addListener(() => {
    state.hostError = chrome.runtime.lastError?.message ?? 'The posthole helper stopped.';
    port = null;
    for (const waiter of pending.values()) waiter.reject(new Error(state.hostError));
    pending.clear();
    badge();
  });
}

function call(op, args = {}, timeout = 120000) {
  if (!port) connect();
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => pending.delete(id) && reject(new Error(`${op} timed out`)), timeout);
    pending.set(id, {
      resolve: value => { clearTimeout(timer); if (state.hostError) { state.hostError = null; badge(); } resolve(value); },
      reject: error => { clearTimeout(timer); reject(error); },
    });
    try { port.postMessage({ id, op, ...args }); } catch (error) { pending.delete(id); clearTimeout(timer); reject(error); }
  });
}

// ---- stats + badge --------------------------------------------------------

const stats = { posts: 0, newPosts: 0, byPlatform: {}, assets: 0, assetBytes: 0, assetFailures: 0, lastSaved: null, errors: [] };
const statsReady = chrome.storage.session.get('stats').then(({ stats: saved }) => Object.assign(stats, saved));
let statsTimer = null;
function touchStats() {
  clearTimeout(statsTimer);
  statsTimer = setTimeout(() => chrome.storage.session.set({ stats }), 500);
  badge();
}
function noteError(where, error) {
  stats.errors.unshift({ at: new Date().toISOString(), where, message: `${error?.message ?? error}` });
  stats.errors.length = Math.min(stats.errors.length, 20);
  touchStats();
}
function badge() {
  const n = stats.posts;
  const text = state.hostError ? '!' : n >= 1000 ? `${Math.floor(n / 1000)}k` : n ? String(n) : '';
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color: state.hostError ? '#c62828' : '#3b3b3b' });
}

// ---- posts ----------------------------------------------------------------

const recent = new Map();
const localDay = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const wantAsset = (asset, s) => (asset.kind === 'avatar' ? s.avatars : asset.kind === 'video' || asset.kind === 'gif' ? s.videos : s.images);

async function saveItems(platform, page, items) {
  const settings = await loadSettings();
  if (settings.paused || !settings.platforms[platform]) return;
  await statsReady;
  enqueueThreads(items, settings);
  const now = Date.now();
  const fresh = items.filter(i => {
    const last = recent.get(i.dir);
    if (last && now - last < DEDUPE_MS) return false;
    recent.set(i.dir, now);
    return true;
  });
  if (recent.size > 50000) for (const [key, at] of recent) if (now - at > DEDUPE_MS) recent.delete(key);
  const at = new Date(now).toISOString();
  for (let i = 0; i < fresh.length; i += 25) {
    const group = fresh.slice(i, i + 25);
    const posts = group.map(entry => ({
      dir: entry.dir,
      record: entry.record,
      source: settings.keepSource ? entry.source : undefined,
      captured: { at, page, endpoint: entry.context?.endpoint ?? null, reposted_by: entry.context?.reposted_by ?? null, thread_of: entry.context?.thread_of ?? null },
      assets: entry.assets.filter(a => wantAsset(a, settings)).map(({ url, ref, base, kind }) => ({ url, ref, base, kind })),
    }));
    let result;
    try {
      result = await call('save', { root: settings.root, day: localDay(), posts });
    } catch (error) {
      group.forEach(entry => recent.delete(entry.dir));
      noteError('save', error);
      continue;
    }
    result.posts.forEach((saved, n) => {
      const entry = group[n];
      stats.posts++;
      if (saved.isNew) stats.newPosts++;
      stats.byPlatform[platform] = (stats.byPlatform[platform] ?? 0) + 1;
      const wanted = entry.assets.filter(a => wantAsset(a, settings));
      for (const index of saved.need) enqueueAsset({ root: settings.root, dir: entry.dir, asset: wanted[index], max: settings.maxAssetMB * 1024 * 1024 });
    });
    git.dirty = true;
    const last = group.at(-1).record;
    stats.lastSaved = { at, platform, url: last.url, author: last.author.handle, text: (last.title ?? last.text).slice(0, 140) };
    touchStats();
  }
}

// ---- assets ---------------------------------------------------------------

const assetJobs = [];
const assetQueued = new Set();
let assetsRunning = 0;
const pdsCache = new Map();
const pdsHosts = new Set();

function enqueueAsset(job) {
  const key = `${job.dir}|${job.asset.base}`;
  if (assetQueued.has(key)) return;
  assetQueued.add(key);
  assetJobs.push({ ...job, key });
  pumpAssets();
}

function pumpAssets() {
  while (assetsRunning < 3 && assetJobs.length) {
    const job = assetJobs.shift();
    assetsRunning++;
    download(job)
      .catch(error => { stats.assetFailures++; noteError(`asset ${job.asset.url}`, error); })
      .finally(() => { assetsRunning--; assetQueued.delete(job.key); pumpAssets(); });
  }
}

// Bluesky video plays as HLS; the original MP4 is a blob on the author's PDS.
async function blobUrl({ did, cid }) {
  if (!/^did:(plc|web):[A-Za-z0-9._:%-]+$/.test(did) || !/^[a-z0-9]+$/i.test(cid)) throw new Error('Invalid Bluesky blob reference');
  if (!pdsCache.has(did)) {
    const docUrl = did.startsWith('did:plc:') ? `https://plc.directory/${did}` : `https://${did.slice('did:web:'.length)}/.well-known/did.json`;
    pdsCache.set(did, fetch(docUrl).then(r => r.json()).then(doc => {
      const endpoint = doc.service?.find(s => s.id === '#atproto_pds' || s.id?.endsWith('#atproto_pds'))?.serviceEndpoint;
      if (!endpoint) throw new Error(`No PDS for ${did}`);
      pdsHosts.add(new URL(endpoint).hostname);
      return endpoint.replace(/\/$/, '');
    }));
  }
  return `${await pdsCache.get(did)}/xrpc/com.atproto.sync.getBlob?did=${encodeURIComponent(did)}&cid=${cid}`;
}

const toBase64 = bytes => {
  if (bytes.toBase64) return bytes.toBase64();
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
};

async function download({ root, dir, asset, max }) {
  const url = asset.fetch?.bsky_blob ? await blobUrl(asset.fetch.bsky_blob) : asset.url;
  const host = new URL(url).hostname;
  if (new URL(url).protocol !== 'https:' || !(ASSET_HOSTS.test(host) || pdsHosts.has(host))) throw new Error(`Not an allowed media host: ${host}`);
  // force-cache: reuse the browser's cached copy whenever it has one.
  const response = await fetch(url, { cache: 'force-cache', credentials: 'omit', referrerPolicy: 'no-referrer' });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  if (Number(response.headers.get('content-length') || 0) > max) throw new Error('Larger than the size limit');
  const target = { root, dir, base: asset.base, ref: asset.ref, url: asset.url };
  const reader = response.body.getReader();
  let parts = [], size = 0, total = 0, seq = 0;
  const flush = async done => {
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const part of parts) { bytes.set(part, offset); offset += part.length; }
    parts = []; size = 0;
    return call('asset', { ...target, seq: seq++, data: toBase64(bytes), done, mime: done ? response.headers.get('content-type') : undefined });
  };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > max) throw new Error('Larger than the size limit');
      parts.push(value); size += value.length;
      if (size >= CHUNK) await flush(false);
    }
    await flush(true);
    stats.assets++;
    stats.assetBytes += total;
    touchStats();
  } catch (error) {
    reader.cancel().catch(() => {});
    if (seq > 0) await call('assetAbort', target).catch(() => {});
    throw error;
  }
}

// ---- raw archive -------------------------------------------------------------

// Every API response (and page HTML) as received, so a capture can be replayed exactly,
// except credentials: the archive is pushed to GitHub, so sign-in material never goes in.
let rawSeq = 0;
const CREDENTIAL_ENDPOINTS = /jwt|token|oauth|login|logout|session|password|csrf|account_settings|guest\/activate|two_factor|verification/i;
const CREDENTIAL_KEYS = /^(jwt|.*_jwt|token|.*_token|access_?token|refresh_?token|id_token|secret|.*_secret|password|cookie|set-cookie|csrf|.*csrf.*|session_?(id|token)?|auth|authorization)$/i;
const JWT = /\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/g;
function scrub(body) {
  if (typeof body !== 'string') return body;
  let parsed;
  try { parsed = JSON.parse(body); } catch { return body.replace(JWT, '[redacted]'); }
  const walk = node => {
    if (Array.isArray(node)) return node.map(walk);
    if (!node || typeof node !== 'object') return typeof node === 'string' ? node.replace(JWT, '[redacted]') : node;
    return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, CREDENTIAL_KEYS.test(k) && (typeof v === 'string' || typeof v === 'number') ? '[redacted]' : walk(v)]));
  };
  return JSON.stringify(walk(parsed));
}
async function saveRaw(platform, page, payload) {
  const settings = await loadSettings();
  if (!settings.archiveRaw || settings.paused || !settings.platforms[platform]) return;
  try { if (CREDENTIAL_ENDPOINTS.test(new URL(payload.url).pathname)) return; } catch { /* no URL: keep */ }
  payload = { ...payload, body: payload.encoding === 'base64' ? payload.body : scrub(payload.body), requestBody: scrub(payload.requestBody) };
  let label = payload.label ?? payload.via ?? 'payload';
  try { label = `${label}-${new URL(payload.url).pathname.split('/').filter(Boolean).slice(-2).join('_')}`; } catch { /* keep label */ }
  const now = new Date();
  const time = `${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}-${String(now.getMilliseconds()).padStart(3, '0')}`;
  const name = `${time}-${String(rawSeq++ % 100000).padStart(5, '0')}-${label}`.replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 150);
  await call('raw', { root: settings.root, platform, day: localDay(now), name, record: { captured_at: now.toISOString(), page, ...payload } })
    .catch(error => noteError('raw', error));
}

// ---- request templates -----------------------------------------------------------

// The shape of each site's own API requests, learned by the page hook, so reply
// threads can be fetched from any tab of that site, even before it repeats them.
async function saveTemplate(platform, op, template) {
  const { templates = {} } = await chrome.storage.local.get('templates');
  templates[platform] = { ...templates[platform], [op]: { ...template, saved_at: Date.now() } };
  await chrome.storage.local.set({ templates });
}
const loadTemplates = async platform => (await chrome.storage.local.get('templates')).templates?.[platform] ?? {};

// ---- reply threads -----------------------------------------------------------------

// Minimum gap between thread fetches per site, and how long a fetched thread counts as fresh.
const SPACING = { x: 4000, linkedin: 8000, threads: 6000, hackernews: 3000, bluesky: 400 };
const REFRESH_MS = 12 * 60 * 60 * 1000;
const X_RESERVE = 25;
const TAB_URLS = {
  x: ['https://x.com/*', 'https://twitter.com/*'],
  linkedin: ['https://www.linkedin.com/*'],
  threads: ['https://www.threads.com/*', 'https://www.threads.net/*'],
  hackernews: ['https://news.ycombinator.com/*'],
};
const threads = { queue: [], queued: new Set(), done: {}, nextAt: {}, running: {}, last: {}, failures: {}, fetched: 0 };
const threadsReady = chrome.storage.local.get('threads').then(({ threads: saved }) => {
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  threads.queue = saved?.queue ?? [];
  threads.queue.forEach(job => threads.queued.add(job.key));
  threads.done = Object.fromEntries(Object.entries(saved?.done ?? {}).filter(([, at]) => at > cutoff));
});
let threadsSaveTimer = null;
const persistThreads = () => {
  clearTimeout(threadsSaveTimer);
  threadsSaveTimer = setTimeout(() => chrome.storage.local.set({ threads: { queue: threads.queue, done: threads.done } }), 2000);
};

async function enqueueThreads(items, settings) {
  if (!settings.fetchThreads) return;
  await threadsReady;
  const now = Date.now();
  for (const entry of items) {
    const depth = entry.context?.depth ?? 0;
    if (depth >= settings.threadDepth) continue;
    const target = expandTarget(entry.record);
    if (!target || !settings.platforms[entry.record.platform]) continue;
    const key = entry.record.key;
    if (threads.queued.has(key) || now - (threads.done[key] ?? 0) < REFRESH_MS) continue;
    threads.queued.add(key);
    threads.queue.push({ key, platform: entry.record.platform, target, depth, at: now });
  }
  // Keep the queue bounded: drop the deepest, oldest work first.
  if (threads.queue.length > 20000) {
    threads.queue.sort((a, b) => a.depth - b.depth || a.at - b.at);
    threads.queue.splice(20000).forEach(job => threads.queued.delete(job.key));
  }
  persistThreads();
  pumpThreads();
}

function takeThread(platform) {
  let best = -1;
  threads.queue.forEach((job, i) => {
    if (job.platform === platform && (best < 0 || job.depth < threads.queue[best].depth)) best = i;
  });
  return best < 0 ? null : threads.queue.splice(best, 1)[0];
}

let pumpTimer = null;
async function pumpThreads() {
  await threadsReady;
  const settings = await loadSettings();
  if (!settings.fetchThreads || settings.paused) return;
  const now = Date.now();
  let wake = Infinity;
  for (const platform of Object.keys(SPACING)) {
    if (threads.running[platform] || !threads.queue.some(job => job.platform === platform)) continue;
    if ((threads.nextAt[platform] ?? 0) > now) { wake = Math.min(wake, threads.nextAt[platform]); continue; }
    const job = takeThread(platform);
    if (job) runThread(job, settings);
  }
  clearTimeout(pumpTimer);
  if (wake < Infinity) pumpTimer = setTimeout(pumpThreads, Math.max(250, wake - now));
}

async function runThread(job, settings) {
  const { platform } = job;
  threads.running[platform] = job.key;
  let result;
  try {
    const task = { ...job, options: { pages: settings.threadPages } };
    result = platform === 'bluesky' ? await expandBluesky(task) : await expandInTab(task);
  } catch (error) {
    result = { status: 'error', detail: error.message };
  }
  threads.running[platform] = null;
  const now = Date.now();
  threads.last[platform] = { at: new Date(now).toISOString(), key: job.key, ...result };
  const retry = delay => { threads.queue.unshift(job); threads.nextAt[platform] = now + delay; };
  if (result.status === 'ok') {
    threads.done[job.key] = now;
    threads.queued.delete(job.key);
    threads.failures[platform] = 0;
    threads.fetched++;
    threads.nextAt[platform] = now + SPACING[platform];
    // X reports its rate limit; leave headroom for your own browsing.
    if (result.rate?.remaining != null && result.rate.remaining < X_RESERVE && result.rate.reset) threads.nextAt[platform] = Math.max(threads.nextAt[platform], result.rate.reset);
  } else if (result.status === 'rate-limited') {
    retry(Math.max((result.rate?.reset ?? 0) - now, 15 * 60 * 1000 * (platform === 'x' ? 1 : 0.2)));
  } else if (['not-ready', 'no-tab', 'timeout'].includes(result.status)) {
    retry(result.status === 'no-tab' ? 60000 : 30000);
  } else {
    // A post that can't be fetched (deleted, private) shouldn't block the queue; repeated failures back off.
    threads.done[job.key] = now;
    threads.queued.delete(job.key);
    threads.failures[platform] = (threads.failures[platform] ?? 0) + 1;
    threads.nextAt[platform] = now + (threads.failures[platform] >= 5 ? 10 * 60 * 1000 : SPACING[platform]);
    noteError(`thread ${job.key}`, `${result.status}${result.detail ? `: ${result.detail}` : ''}`);
  }
  persistThreads();
  pumpThreads();
}

async function expandInTab(job) {
  const tabs = (await chrome.tabs.query({ url: TAB_URLS[job.platform] })).filter(t => t.status === 'complete' && !t.discarded);
  // Prefer a tab you aren't looking at.
  tabs.sort((a, b) => Number(a.active) - Number(b.active));
  for (const tab of tabs) {
    try {
      const result = await chrome.tabs.sendMessage(tab.id, { type: 'expand', job }, { frameId: 0 });
      if (result) return result;
    } catch { /* content script not in this tab (opened before install); try another */ }
  }
  return { status: 'no-tab' };
}

// Bluesky threads are public: one AppView call returns the whole reply tree.
async function expandBluesky(job) {
  const url = `https://public.api.bsky.app/xrpc/app.bsky.feed.getPostThread?uri=${encodeURIComponent(job.target.uri)}&depth=100&parentHeight=100`;
  const response = await fetch(url);
  const body = await response.text();
  if (response.status === 429) return { status: 'rate-limited' };
  if (!response.ok) return { status: `http-${response.status}`, detail: body.slice(0, 200) };
  const payload = { via: 'posthole', url, status: response.status, contentType: response.headers.get('content-type'), method: 'GET', body, expand: job, label: 'getPostThread' };
  saveRaw('bluesky', null, payload);
  // The tree is complete, so nothing inside it needs fetching again.
  const items = parsePayload('bluesky', payload).map(i => ({ ...i, context: { ...i.context, endpoint: 'thread:getPostThread', depth: 99, thread_of: job.key } }));
  await saveItems('bluesky', null, items);
  return { status: 'ok', posts: items.length };
}

function threadStatus() {
  const byPlatform = {};
  for (const job of threads.queue) byPlatform[job.platform] = (byPlatform[job.platform] ?? 0) + 1;
  return { queued: byPlatform, running: threads.running, last: threads.last, nextAt: threads.nextAt, fetched: threads.fetched };
}

chrome.alarms.create('posthole-threads', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name !== 'posthole-threads') return;
  pumpThreads();
  checkBuild();
  syncGit();
});

// ---- git sync --------------------------------------------------------------------

// When the save folder is a git repository, push new saves every few minutes.
const SYNC_EVERY = 5 * 60 * 1000;
const git = { dirty: true, startedAt: 0, last: null, running: false };
async function syncGit(force = false) {
  const settings = await loadSettings();
  if (!settings.gitSync && !force) return;
  try {
    if (!force && (!git.dirty || Date.now() - git.startedAt < SYNC_EVERY)) {
      Object.assign(git, await call('syncStatus', {}, 10000));
      return;
    }
    git.dirty = false;
    git.startedAt = Date.now();
    Object.assign(git, await call('sync', { root: settings.root }, 10000));
  } catch (error) {
    noteError('git', error);
  }
}

// ---- updates -------------------------------------------------------------------

// A newer `npm run build` in this checkout reloads the running extension.
async function checkBuild() {
  try {
    const { build } = await call('build', {}, 10000);
    if (!build) return { message: 'No local build found. Run npm run build in your posthole checkout.' };
    if (build !== __BUILD__) {
      // Let the popup display the result before its extension context disappears.
      setTimeout(() => chrome.runtime.reload(), 250);
      return { updated: true, message: 'New local build found. Reloading posthole…' };
    }
    return { updated: false, message: 'You’re running the latest local build. GitHub changes need to be downloaded and built first.' };
  } catch {
    return { updated: false, message: 'Couldn’t check for updates. Make sure the posthole helper is installed and connected.' };
  }
}

// Tabs that were already open get the scripts too, so capture continues without reloading them.
// (The page hook arrives after the page's first requests; everything after that is captured.)
const SITES = chrome.runtime.getManifest().content_scripts.at(-1).matches;
chrome.runtime.onInstalled.addListener(async () => {
  for (const tab of await chrome.tabs.query({ url: SITES })) {
    if (tab.discarded || !tab.id) continue;
    const hooked = !/news\.ycombinator\.com/.test(tab.url ?? '');
    try {
      if (hooked) await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'MAIN', files: ['hook.js'] });
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
    } catch { /* tab not scriptable right now */ }
  }
});

// ---- messages ----------------------------------------------------------------

async function status() {
  await statsReady;
  return { autoScroll: await autoScroller.status(), settings: await loadSettings(), host: state.hostInfo, hostError: state.hostError, stats, queue: assetJobs.length + assetsRunning, threads: threadStatus(), git: { running: git.running, last: git.last } };
}

const handlers = {
  checkUpdates: () => checkBuild(),
  autoScrollStart: m => autoScroller.start(m.tabId, m.minutes),
  autoScrollStop: () => autoScroller.stop(),
  items: (m, sender) => saveItems(m.platform, m.page ?? sender.tab?.url ?? null, m.items),
  raw: (m, sender) => saveRaw(m.platform, m.page ?? sender.tab?.url ?? null, m.payload),
  template: m => saveTemplate(m.platform, m.op, m.template),
  templates: m => loadTemplates(m.platform),
  error: m => noteError(m.platform, m.message),
  status,
  hello: async () => {
    const settings = await loadSettings();
    try {
      state.hostInfo = await call('hello', { root: settings.root }, 10000);
      state.hostError = null;
    } catch (error) {
      state.hostError = error.message;
    }
    badge();
    return status();
  },
  pickFolder: async () => {
    const { path } = await call('pickFolder', {}, 10 * 60 * 1000);
    if (path) await saveSettings({ root: path });
    return { path };
  },
  openFolder: async () => call('open', { root: (await loadSettings()).root }),
  syncNow: async () => { await syncGit(true); return status(); },
  resetStats: async () => {
    Object.assign(stats, { posts: 0, newPosts: 0, byPlatform: {}, assets: 0, assetBytes: 0, assetFailures: 0, lastSaved: null, errors: [] });
    threads.fetched = 0;
    touchStats();
    return status();
  },
};

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  const handler = handlers[message?.type];
  if (!handler) return false;
  // Only our own pages (popup, options) may drive the helper; content scripts may only submit captures.
  const ownPage = sender.id === chrome.runtime.id && sender.url?.startsWith(chrome.runtime.getURL(''));
  if (!ownPage && !['items', 'raw', 'error', 'template', 'templates'].includes(message.type)) return false;
  Promise.resolve(handler(message, sender)).then(respond, error => respond({ error: error.message }));
  return true;
});

handlers.hello().then(checkBuild);
pumpThreads();
