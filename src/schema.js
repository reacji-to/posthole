import { sha256Hex } from './sha256.js';

// The one record shape every platform is normalized into. SCHEMA.md documents it.
export const SCHEMA = 'posthole.post/1';

// ---- reacji.to post identity ------------------------------------------------------
// Posts are identified exactly as reacji.to identifies them (its posts.js / web.js),
// so saved posts and reactions join on the same key: "x:<tweet id>",
// "linkedin:<activity id>", and for everything else "web:<sha256 of the canonical URL>".

// Same rules as reacji.to's canonicalUrl: drop tracking parameters, and fragments
// unless they are SPA routes (#! or #/).
export function canonicalUrl(value) {
  const url = new URL(value);
  if (!/^#[!/]/.test(url.hash)) url.hash = '';
  for (const key of [...url.searchParams.keys()]) if (/^(utm_.+|fbclid|gclid)$/i.test(key)) url.searchParams.delete(key);
  return url.href;
}

const NUMERIC = /^[1-9]\d{5,24}$/;
export function reacjiKey(platform, id, url) {
  if ((platform === 'x' || platform === 'linkedin') && NUMERIC.test(String(id))) return `${platform}:${String(id).toLowerCase()}`;
  return `web:${sha256Hex(canonicalUrl(url))}`;
}
export const PLATFORMS = ['x', 'linkedin', 'bluesky', 'threads', 'hackernews'];

export const iso = value => {
  if (value === null || value === undefined || value === '') return null;
  const date = typeof value === 'number' ? new Date(value < 1e12 ? value * 1000 : value) : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};
export const num = value => {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};
export const str = value => (typeof value === 'string' && value !== '' ? value : value === 0 || typeof value === 'number' ? String(value) : null);

// Filesystem-safe and stable: the same post always lands in the same folder.
export const safeKey = value => String(value).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[.-]+/, '').slice(0, 120) || 'unknown';

export function hash(value) {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) h = Math.imul(h ^ value.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(16).padStart(8, '0');
}

export function makePost(platform, fields) {
  return {
    schema: SCHEMA,
    key: reacjiKey(platform, fields.id, fields.url),
    platform,
    id: fields.id,
    url: fields.url ?? null,
    kind: fields.kind ?? 'post',
    author: {
      id: fields.author?.id ?? null,
      handle: fields.author?.handle ?? null,
      name: fields.author?.name ?? null,
      url: fields.author?.url ?? null,
      description: fields.author?.description ?? null,
      verified: fields.author?.verified ?? null,
      avatar_url: fields.author?.avatar_url ?? null,
      avatar_file: null,
    },
    created_at: fields.created_at ?? null,
    title: fields.title ?? null,
    text: fields.text ?? '',
    lang: fields.lang ?? null,
    links: fields.links ?? [],
    mentions: fields.mentions ?? [],
    hashtags: fields.hashtags ?? [],
    media: (fields.media ?? []).map(m => ({
      type: m.type, url: m.url ?? null, file: null, mime: m.mime ?? null, alt: m.alt || null,
      width: num(m.width), height: num(m.height), duration_ms: num(m.duration_ms),
      thumbnail_url: m.thumbnail_url ?? null, thumbnail_file: null,
      ...(m._fetch ? { _fetch: m._fetch } : {}),
    })),
    link_card: fields.link_card ? {
      url: fields.link_card.url ?? null, title: fields.link_card.title || null, description: fields.link_card.description || null,
      domain: fields.link_card.domain ?? domainOf(fields.link_card.url), image_url: fields.link_card.image_url ?? null, image_file: null,
    } : null,
    reply_to: fields.reply_to ?? null,
    thread_root: fields.thread_root ?? null,
    quote_of: fields.quote_of ?? null,
    metrics: {
      likes: num(fields.metrics?.likes), reposts: num(fields.metrics?.reposts), quotes: num(fields.metrics?.quotes),
      replies: num(fields.metrics?.replies), views: num(fields.metrics?.views), bookmarks: num(fields.metrics?.bookmarks),
      score: num(fields.metrics?.score),
    },
    extra: fields.extra ?? {},
  };
}

export function domainOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return null; }
}

// One saved item: where it lives, what to write, and which files still need bytes.
// Folders mirror the reacji.to key (x/<id>, linkedin/<id>, web/<sha256>), like reacji.to's
// own data repositories. File references in the record are relative to the post's folder.
export function item(record, source, context = {}) {
  const dir = record.key.replace(':', '/');
  const assets = [];
  record.media.forEach((m, i) => {
    const n = String(i + 1).padStart(2, '0');
    if (m.url) assets.push({ url: m.url, ref: `/media/${i}/file`, base: n, kind: m.type, ...(m._fetch ? { fetch: m._fetch } : {}) });
    if (m.thumbnail_url && m.thumbnail_url !== m.url) assets.push({ url: m.thumbnail_url, ref: `/media/${i}/thumbnail_file`, base: `${n}-thumb`, kind: 'image' });
    delete m._fetch;
  });
  if (record.link_card?.image_url) assets.push({ url: record.link_card.image_url, ref: '/link_card/image_file', base: 'card', kind: 'image' });
  if (record.author.avatar_url) {
    const who = safeKey(record.author.id ?? record.author.handle ?? 'anon');
    assets.push({ url: record.author.avatar_url, ref: '/author/avatar_file', base: `../_avatars/${who}-${hash(record.author.avatar_url)}`, kind: 'avatar' });
  }
  return { dir, record, source, assets: assets.filter(a => /^https:\/\//.test(a.url)), context };
}

// Walk any JSON value once, depth-first, calling visit(node, parent).
export function walk(root, visit) {
  const stack = [[root, null]];
  const seen = new Set();
  while (stack.length) {
    const [node, parent] = stack.pop();
    if (!node || typeof node !== 'object' || seen.has(node)) continue;
    seen.add(node);
    if (!Array.isArray(node)) visit(node, parent);
    const values = Array.isArray(node) ? node : Object.values(node);
    for (let i = values.length - 1; i >= 0; i--) if (values[i] && typeof values[i] === 'object') stack.push([values[i], node]);
  }
}

// Responses are usually JSON, sometimes guarded (for (;;);) or newline-delimited.
export function parseJsonish(text) {
  if (typeof text !== 'string') return text === undefined ? [] : [text];
  const body = text.replace(/^\s*(for\s*\(;;\);|\)\]\}',?)\s*/, '');
  try { return [JSON.parse(body)]; } catch { /* fall through to line-delimited */ }
  const out = [];
  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) continue;
    try { out.push(JSON.parse(trimmed)); } catch { /* skip partial lines */ }
  }
  return out;
}

export const decodeEntities = text => text
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
