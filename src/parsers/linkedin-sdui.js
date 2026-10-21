import { iso, item, makePost } from '../schema.js';
import { eachNode, isElement, parseFlight, referenced, resolvePath } from '../rsc.js';

// LinkedIn's current feed is server-driven UI: the server sends React Server
// Components describing each post card rather than post data. This walks each
// card in render order and reads the post back out of it: who posted, the
// commentary (with its links, mentions and hashtags), images, video, link
// cards, reshared posts, and the counts LinkedIn keeps in model state.

// Activity IDs embed their creation time in the top 41 bits.
export const activityTime = id => {
  try { return iso(Number(BigInt(id) >> 22n)); } catch { return null; }
};

const PROFILE = /^(?:https:\/\/www\.linkedin\.com)?\/(in|company|school|showcase)\/([^/?#]+)/;
const AVATAR = /profile-displayphoto|profile-framedphoto|company-logo|school-logo|organization-logo/;
const TIME = /^(?:\d+\s?(?:s|m|h|d|w|mo|y|yr)s?|now)\b/i;
// The request LinkedIn's client sends to load a post's comments.
export const COMMENTS_REQUEST = 'com.linkedin.sdui.feed.update.comments.fetchComment';
const UI = new Set(['Feed post', 'Follow', 'Following', 'Visit my website', 'more', '…more', 'Like', 'Comment', 'Repost', 'Send', 'Promoted', 'Promoted by']);

const absolute = url => (url?.startsWith('/') ? `https://www.linkedin.com${url}` : url);
// Outbound links go through LinkedIn's redirector; keep the destination.
function destination(url) {
  try {
    const u = new URL(absolute(url));
    if (/^\/(safety\/go|redir\/redirect)/.test(u.pathname) && u.searchParams.get('url')) return u.searchParams.get('url');
    return u.href;
  } catch { return url; }
}
const bestImage = image => {
  const best = [...(image.imageRenditions ?? [])].sort((a, b) => (b.width ?? 0) - (a.width ?? 0))[0];
  return best ? { url: `${image.rootUrl}${best.suffixUrl}`, width: best.width, height: best.height } : null;
};
function bestVideo(node) {
  const entry = node.playlist.find(p => p?.sources?.length);
  if (!entry) return null;
  const quality = s => Number(s.src.match(/mp4-(\d+)p/)?.[1] ?? 0);
  const mp4 = entry.sources.filter(s => s.type === 'video/mp4' && s.src).sort((a, b) => quality(b) - quality(a))[0];
  const poster = entry.thumbnail?.imageRenditions ? bestImage(entry.thumbnail) : null;
  return mp4 ? { type: 'video', url: mp4.src, mime: 'video/mp4', duration_ms: entry.duration ? Math.round(entry.duration * 1000) : null, thumbnail_url: poster?.url ?? null, width: poster?.width, height: poster?.height } : null;
}
const cleanName = label => label
  .replace(/^Open control menu for post by /, '')
  .replace(/(,\s*|\s+)(Open to work|Hiring|1st|2nd|3rd\+?|Premium|Verified|Influencer|Creator|Top Voice)\b.*$/, '')
  .trim() || null;

// The card's content in render order. `c` is the index of the commentary block
// an item sits in (each expandable text is one), or null outside commentary.
function collect(card, rows) {
  const items = [];
  const seen = new Set();
  let commentaries = 0;
  const inspect = (obj, c) => {
    if (typeof obj.rootUrl === 'string' && Array.isArray(obj.imageRenditions)) items.push({ k: 'img', v: obj, c });
    if (Array.isArray(obj.playlist)) items.push({ k: 'video', v: obj, c });
    if (typeof obj.url === 'string' && obj.url) items.push({ k: 'url', v: obj.url, c });
    if (typeof obj.activityId === 'string') items.push({ k: 'activity', v: obj.activityId, c });
    if (obj.$type === 'proto.sdui.actions.core.ServerRequest' && obj.value?.requestId === COMMENTS_REQUEST) items.push({ k: 'comments', v: obj.value, c });
  };
  const walk = (node, textOk, c) => {
    if (typeof node === 'string') {
      const pointed = resolvePath(rows, node);
      if (pointed !== undefined) { walk(pointed, textOk, c); return; }
      const ref = referenced(rows, node);
      if (ref) {
        if (seen.has(ref)) return;
        seen.add(ref);
        const row = rows.get(ref);
        if (row.tag !== 'I') walk(row.value, textOk, c);
        return;
      }
      // Keep whitespace-only text: it is the spacing between commentary segments and links.
      if (textOk && node && !node.startsWith('$')) items.push({ k: 'text', v: node, c });
      return;
    }
    if (!node || typeof node !== 'object') return;
    if (isElement(node)) {
      const props = node[3] && typeof node[3] === 'object' ? node[3] : {};
      if (node[1] === 'br') { items.push({ k: 'br', c }); return; }
      // Commentary is LinkedIn's expandable text block ("…more").
      const expandable = props.textProps && typeof props.textProps === 'object' && 'expandButtonText' in props.textProps;
      const ctx = expandable ? commentaries++ : c;
      if (typeof props['aria-label'] === 'string' && props['aria-label'].trim()) items.push({ k: 'aria', v: props['aria-label'].trim(), c: ctx });
      inspect(props, ctx);
      for (const [key, value] of Object.entries(props)) {
        if (key === 'className' || key === 'style') continue;
        if (key === 'textProps' && value && typeof value === 'object') {
          walk(value.children, textOk, ctx);
          for (const [inner, v] of Object.entries(value)) if (inner !== 'children') walk(v, false, ctx);
        } else walk(value, textOk && key === 'children', ctx);
      }
      return;
    }
    if (Array.isArray(node)) { for (const x of node) walk(x, textOk, c); return; }
    inspect(node, c);
    for (const [key, value] of Object.entries(node)) if (key !== '$type' && key !== '$case') walk(value, false, c);
  };
  walk(card, true, null);
  return { items, rowIds: seen };
}

function actor(items, from, to) {
  let url = null, avatar = null, name = null;
  const texts = [];
  for (let i = from; i < to; i++) {
    const it = items[i];
    if (it.k === 'url' && !url && PROFILE.test(it.v)) url = absolute(it.v).split('?')[0];
    else if (it.k === 'img' && !avatar && AVATAR.test(it.v.rootUrl)) avatar = bestImage(it.v);
    else if (it.k === 'aria' && url && !name && !/^(Error|Video player)/.test(it.v)) name = cleanName(it.v);
    else if (it.k === 'text' && it.c === null && it.v.trim()) texts.push(it.v.trim());
  }
  const menu = items.slice(from, to).find(it => it.k === 'aria' && /^Open control menu for post by /.test(it.v));
  if (menu) name = cleanName(menu.v);
  const timeAt = texts.findIndex(t => TIME.test(t));
  const before = (timeAt < 0 ? texts : texts.slice(0, timeAt)).filter(t => t.length > 1 && !UI.has(t) && t !== name);
  return {
    url, avatar, name,
    handle: url?.match(PROFILE)?.[2] ? decodeURIComponent(url.match(PROFILE)[2]) : null,
    headline: before.at(-1) ?? null,
    line: timeAt >= 0 ? texts[timeAt] : null,
    promoted: texts.some(t => /^Promoted( by)?$/.test(t)),
  };
}

function commentary(items, index) {
  let text = '';
  const links = [], mentions = [], hashtags = [];
  let pending = null;
  for (const it of items) {
    if (it.c !== index) continue;
    if (it.k === 'url') pending = it.v;
    else if (it.k === 'br') text += '\n';
    else if (it.k === 'text') {
      if (pending) {
        const target = destination(pending);
        if (/[?&]keywords=%23/.test(pending) || it.v.startsWith('#')) hashtags.push(it.v.replace(/^#/, ''));
        else if (PROFILE.test(pending)) mentions.push(it.v.trim());
        else links.push({ url: target, text: it.v });
        pending = null;
      }
      text += it.v;
    }
  }
  return { text: text.trim(), links, mentions, hashtags };
}

function media(items, from, to) {
  const out = [];
  const seen = new Set();
  let link_card = null;
  for (let i = from; i < to; i++) {
    const it = items[i];
    if (it.k === 'img' && !AVATAR.test(it.v.rootUrl) && !/videocover|static\.licdn/.test(it.v.rootUrl)) {
      const image = bestImage(it.v);
      if (/articleshare/.test(it.v.rootUrl)) {
        // A link preview: the link precedes the image, its title and domain follow.
        const url = items.slice(from, i).reverse().find(x => x.k === 'url' && !PROFILE.test(x.v))?.v;
        const after = [...new Set(items.slice(i + 1, to).filter(x => x.k === 'text' && x.c === null).map(x => x.v.trim()).filter(Boolean))];
        const domain = after.find(t => /^[\w-]+(\.[\w-]+)+$/.test(t)) ?? null;
        link_card = { url: url ? destination(url) : null, title: after.find(t => t !== domain) ?? null, domain, image_url: image?.url ?? null };
      } else if (image && !seen.has(image.url)) {
        seen.add(image.url);
        out.push({ type: 'image', ...image });
      }
    } else if (it.k === 'video') {
      const video = bestVideo(it.v);
      if (video && !seen.has(video.url)) { seen.add(video.url); out.push(video); }
    }
  }
  return { media: out, link_card };
}

function counts(states, id) {
  const urn = `urn:li:activity:${id}`;
  let likes = null;
  for (const [key, value] of states) if (key.startsWith('ReactionType_') && key.endsWith(`_${urn}`) && typeof value === 'number') likes = (likes ?? 0) + value;
  return { likes, replies: states.get(`commentCount-${urn}`) ?? null, reposts: states.get(`repostCount-${urn}`) ?? null };
}

function post({ id, who, body, found, states, quoteId, permalink, comments }) {
  return makePost('linkedin', {
    id,
    url: `https://www.linkedin.com/feed/update/urn:li:activity:${id}/`,
    kind: quoteId ? 'quote' : 'post',
    author: { id: who.handle, handle: who.handle, name: who.name, url: who.url, description: who.headline, avatar_url: who.avatar?.url ?? null },
    created_at: activityTime(id),
    ...body,
    media: found.media,
    link_card: found.link_card,
    quote_of: quoteId ? { platform: 'linkedin', id: quoteId, url: `https://www.linkedin.com/feed/update/urn:li:activity:${quoteId}/` } : null,
    metrics: counts(states, id),
    extra: {
      actor_line: who.line, edited: /Edited/.test(who.line ?? ''), ...(permalink ? { permalink } : {}), format: 'sdui',
      ...(comments ? { comments_request: comments } : {}),
    },
  });
}

export function parseLinkedInFlight(text) {
  const rows = parseFlight(text);
  const states = new Map();
  const cards = [];
  eachNode(rows, node => {
    if (Array.isArray(node.modelStates)) {
      for (const s of node.modelStates) {
        const key = s?.key?.key?.value?.id;
        const v = s?.value;
        if (key) states.set(key, v?.intValue ?? v?.stringValue ?? v?.booleanValue ?? null);
      }
    }
    if (isElement(node) && typeof node[3]?.componentKey === 'string' && node[3].componentKey.startsWith('update-card-focus')) {
      cards.push(node);
      return false;
    }
    return true;
  });

  const results = [];
  for (const card of cards) {
    const { items, rowIds } = collect(card, rows);
    const ids = [...new Set(items.filter(it => it.k === 'activity').map(it => it.v))];
    if (!ids.length) continue;
    // A card also mentions feed-bookkeeping activities; the post itself is the one LinkedIn keeps counts for.
    const own = ids.find(id => states.has(`commentCount-urn:li:activity:${id}`)) ?? ids[0];
    const firstCommentary = items.findIndex(it => it.c === 0);
    const firstMedia = items.findIndex(it => (it.k === 'img' && !AVATAR.test(it.v.rootUrl)) || it.k === 'video');
    const headerEnd = [firstCommentary, firstMedia].filter(i => i >= 0).reduce((a, b) => Math.min(a, b), items.length);
    const outer = actor(items, 0, headerEnd);
    if (outer.promoted) continue;
    const end = (() => {
      const i = items.findIndex(it => (it.k === 'url' && it.v === '/sharing/compose') || (it.k === 'text' && /^Comment input could not be loaded/.test(it.v)));
      return i < 0 ? items.length : i;
    })();
    const permalink = items.find(it => it.k === 'url' && /linkedin\.com\/posts\//.test(it.v))?.v ?? null;
    const commentaryEnd = firstCommentary < 0 ? headerEnd : items.findLastIndex(it => it.c === 0) + 1;
    const threadOf = request => request?.requestedArguments?.payload?.threadUrn?.threadUrnActivityThreadUrn?.activityUrn?.activityId;
    const commentsFor = id => items.find(it => it.k === 'comments' && threadOf(it.v) === id)?.v ?? null;
    const source = { format: 'linkedin-sdui', card, rows: Object.fromEntries([...rowIds].map(id => [id, rows.get(id).value])) };

    // A reshare carries a second author block (profile link, avatar) and usually its own commentary.
    const innerStart = items.findIndex((it, i) => i >= commentaryEnd && i < end && it.k === 'url' && PROFILE.test(it.v)
      && items.slice(i, end).some(x => x.k === 'img' && AVATAR.test(x.v.rootUrl)));
    const innerId = innerStart >= 0 ? items.slice(innerStart, end).find(it => it.k === 'activity' && it.v !== own)?.v ?? ids.find(id => id !== own) : null;
    if (innerStart >= 0 && innerId) {
      const innerCommentary = items.findIndex(it => it.c === 1);
      const innerBodyEnd = innerCommentary >= 0 ? items.findLastIndex(it => it.c === 1) + 1 : innerStart;
      const inner = actor(items, innerStart, innerCommentary >= 0 ? innerCommentary : end);
      results.push(item(post({ id: innerId, who: inner, body: commentary(items, innerCommentary >= 0 ? 1 : -1), found: media(items, innerBodyEnd, end), states }), source));
      results.push(item(post({ id: own, who: outer, body: commentary(items, 0), found: media(items, commentaryEnd, innerStart), states, quoteId: innerId, permalink, comments: commentsFor(own) }), source));
    } else {
      results.push(item(post({ id: own, who: outer, body: commentary(items, 0), found: media(items, commentaryEnd, end), states, permalink, comments: commentsFor(own) }), source));
    }
  }
  return results;
}
