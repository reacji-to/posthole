import { iso, item, makePost, parseJsonish, walk } from '../schema.js';

// bsky.app reads everything over XRPC from the user's PDS/AppView. Feed, thread,
// search and profile responses all contain PostView objects (and quoted posts as
// ViewRecords), so walking for those shapes covers every view.

const isPostView = node => typeof node.uri === 'string' && node.uri.startsWith('at://') && node.uri.includes('/app.bsky.feed.post/')
  && node.author?.did && (node.record?.$type === 'app.bsky.feed.post' || node.value?.$type === 'app.bsky.feed.post');

const parts = uri => {
  const [did, , rkey] = uri.slice('at://'.length).split('/');
  return { did, rkey };
};
const postUrl = (uri, handle) => {
  const { did, rkey } = parts(uri);
  return `https://bsky.app/profile/${handle && handle !== 'handle.invalid' ? handle : did}/post/${rkey}`;
};

// Facet offsets are UTF-8 byte ranges.
function facets(record) {
  const bytes = new TextEncoder().encode(record.text ?? '');
  const decoder = new TextDecoder();
  const links = [], mentions = [], hashtags = [];
  for (const facet of record.facets ?? []) {
    const slice = decoder.decode(bytes.slice(facet.index?.byteStart ?? 0, facet.index?.byteEnd ?? 0));
    for (const f of facet.features ?? []) {
      if (f.$type === 'app.bsky.richtext.facet#link') links.push({ url: f.uri, text: slice || null });
      else if (f.$type === 'app.bsky.richtext.facet#mention') mentions.push(slice.replace(/^@/, '') || f.did);
      else if (f.$type === 'app.bsky.richtext.facet#tag') hashtags.push(f.tag);
    }
  }
  return { links, mentions, hashtags };
}

function embedParts(embed, did) {
  const out = { media: [], link_card: null, quote: null };
  if (!embed) return out;
  const type = embed.$type ?? '';
  if (type.startsWith('app.bsky.embed.images')) {
    for (const img of embed.images ?? []) out.media.push({ type: 'image', url: img.fullsize, alt: img.alt, width: img.aspectRatio?.width, height: img.aspectRatio?.height });
  } else if (type.startsWith('app.bsky.embed.video')) {
    // The browser streams HLS; the original upload is a single MP4 blob on the author's PDS.
    out.media.push({
      type: 'video', url: embed.playlist, mime: 'video/mp4', alt: embed.alt, width: embed.aspectRatio?.width, height: embed.aspectRatio?.height,
      thumbnail_url: embed.thumbnail, ...(embed.cid ? { _fetch: { bsky_blob: { did, cid: embed.cid } } } : {}),
    });
  } else if (type.startsWith('app.bsky.embed.external')) {
    const e = embed.external ?? {};
    out.link_card = { url: e.uri, title: e.title, description: e.description, image_url: e.thumb ?? null };
  } else if (type.startsWith('app.bsky.embed.recordWithMedia')) {
    const media = embedParts(embed.media, did);
    out.media = media.media;
    out.link_card = media.link_card;
    out.quote = embedParts(embed.record, did).quote;
  } else if (type.startsWith('app.bsky.embed.record')) {
    const r = embed.record;
    if (r?.uri?.includes('/app.bsky.feed.post/')) out.quote = { platform: 'bluesky', id: r.uri, url: postUrl(r.uri, r.author?.handle) };
  }
  return out;
}

export function postViewToItem(view, context = {}) {
  const record = view.record ?? view.value;
  const { did, rkey } = parts(view.uri);
  const embed = view.embed ?? view.embeds?.[0] ?? null;
  const { media, link_card, quote } = embedParts(embed, did);
  const { links, mentions, hashtags } = facets(record);
  const reply = record.reply;
  const author = view.author;
  const out = makePost('bluesky', {
    id: view.uri,
    url: postUrl(view.uri, author.handle),
    kind: reply ? 'reply' : quote ? 'quote' : 'post',
    author: {
      id: author.did, handle: author.handle, name: author.displayName || null,
      url: `https://bsky.app/profile/${author.handle ?? author.did}`,
      verified: author.verification?.verifiedStatus === 'valid', avatar_url: author.avatar ?? null,
    },
    created_at: iso(record.createdAt),
    text: record.text ?? '',
    lang: record.langs?.[0] ?? null,
    links, mentions, hashtags, media, link_card,
    reply_to: reply?.parent?.uri ? { id: reply.parent.uri, url: postUrl(reply.parent.uri) } : null,
    thread_root: reply?.root?.uri && reply.root.uri !== reply.parent?.uri ? { id: reply.root.uri, url: postUrl(reply.root.uri) } : null,
    quote_of: quote,
    metrics: { likes: view.likeCount, reposts: view.repostCount, replies: view.replyCount, quotes: view.quoteCount, bookmarks: view.bookmarkCount },
    extra: { cid: view.cid ?? null, ...(view.labels?.length ? { labels: view.labels.map(l => l.val) } : {}) },
  });
  return item(out, view, context);
}

export function parseBluesky(payload) {
  const found = new Map();
  const repostedBy = new Map();
  for (const root of parseJsonish(payload.body)) {
    walk(root, node => {
      if (node.post?.uri && node.reason?.$type === 'app.bsky.feed.defs#reasonRepost') repostedBy.set(node.post.uri, node.reason.by?.handle ?? null);
      if (!isPostView(node)) return;
      // Prefer full PostViews (with record) over the quoted ViewRecord copies.
      const existing = found.get(node.uri);
      if (!existing || (!existing.record && node.record)) found.set(node.uri, node);
    });
  }
  return [...found.values()].map(view => postViewToItem(view, repostedBy.has(view.uri) ? { reposted_by: repostedBy.get(view.uri) } : {}));
}
