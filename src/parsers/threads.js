import { iso, item, makePost, parseJsonish, str, walk } from '../schema.js';

// Threads ships its first screen as JSON inside <script data-sjs> tags and loads
// the rest over GraphQL. Both carry Instagram-style media objects; walking for
// them covers feed, profile, thread and search views.

const isThreadsPost = node => (node.pk || node.id) && node.code && node.user?.username && 'taken_at' in node
  && ('text_post_app_info' in node || 'caption' in node);

const postUrl = (username, code) => `https://www.threads.com/@${username}/post/${code}`;
const best = candidates => [...(candidates ?? [])].filter(c => c?.url).sort((a, b) => (b.width ?? 0) - (a.width ?? 0))[0] ?? null;
const unwrapLink = url => {
  try {
    const u = new URL(url);
    if (/^l\.(threads|instagram|facebook)\./.test(u.hostname) && u.searchParams.get('u')) return u.searchParams.get('u');
  } catch { /* leave as-is */ }
  return url;
};

function mediaOf(node) {
  const one = m => {
    const image = best(m.image_versions2?.candidates);
    const width = m.original_width ?? image?.width, height = m.original_height ?? image?.height;
    if (m.video_versions?.length) {
      const video = best(m.video_versions) ?? m.video_versions[0];
      return { type: 'video', url: video.url, mime: 'video/mp4', alt: m.accessibility_caption, width, height, duration_ms: m.video_duration ? m.video_duration * 1000 : null, thumbnail_url: image?.url ?? null };
    }
    if (image && m.media_type !== 19) return { type: 'image', url: image.url, alt: m.accessibility_caption, width, height };
    return null;
  };
  if (node.carousel_media?.length) return node.carousel_media.map(one).filter(Boolean);
  const m = one(node);
  return m ? [m] : [];
}

function textOf(node) {
  const fragments = node.text_post_app_info?.text_fragments?.fragments ?? [];
  const links = [], mentions = [], hashtags = [];
  for (const f of fragments) {
    if (f.link_fragment?.uri) links.push({ url: unwrapLink(f.link_fragment.uri), text: f.link_fragment.display_text ?? f.plaintext ?? null });
    if (f.mention_fragment?.mentioned_user?.username) mentions.push(f.mention_fragment.mentioned_user.username);
    if (f.tag_fragment?.tag_name) hashtags.push(f.tag_fragment.tag_name);
  }
  const text = node.caption?.text ?? fragments.map(f => f.plaintext ?? '').join('');
  return { text, links, mentions, hashtags };
}

export function threadsPostToItem(node, context = {}) {
  const info = node.text_post_app_info ?? {};
  const user = node.user;
  const id = str(node.pk) ?? String(node.id).split('_')[0];
  const quoted = info.share_info?.quoted_post;
  const preview = info.link_preview_attachment;
  const parent = context.parent;
  const avatar = best(user.hd_profile_pic_versions)?.url ?? user.profile_pic_url ?? null;
  const { text, links, mentions, hashtags } = textOf(node);
  const record = makePost('threads', {
    id,
    url: postUrl(user.username, node.code),
    kind: info.is_reply ? 'reply' : quoted ? 'quote' : 'post',
    author: {
      id: str(user.pk ?? user.id), handle: user.username, name: user.full_name || null,
      url: `https://www.threads.com/@${user.username}`, verified: user.is_verified ?? null, avatar_url: avatar,
    },
    created_at: iso(node.taken_at),
    text,
    links, mentions, hashtags,
    media: mediaOf(node),
    link_card: preview?.url ? { url: unwrapLink(preview.url), title: preview.title, domain: preview.display_url ?? null, image_url: preview.image_url ?? null } : null,
    reply_to: parent ? { id: str(parent.pk), url: postUrl(parent.user.username, parent.code), author_handle: parent.user.username }
      : info.reply_to_author?.username ? { id: null, url: null, author_handle: info.reply_to_author.username } : null,
    quote_of: quoted?.code ? { platform: 'threads', id: str(quoted.pk), url: postUrl(quoted.user?.username ?? 'threads', quoted.code) } : null,
    metrics: { likes: node.like_count, replies: info.direct_reply_count, reposts: info.repost_count, quotes: info.quote_count },
    extra: { code: node.code, media_type: node.media_type ?? null, ...(info.reshare_count != null ? { shares: info.reshare_count } : {}) },
  });
  return item(record, node, context.reposted_by ? { reposted_by: context.reposted_by } : {});
}

export function parseThreads(payload) {
  const found = new Map();
  const parents = new Map();
  const repostedBy = new Map();
  for (const root of parseJsonish(payload.body)) {
    walk(root, node => {
      // A thread is an ordered chain: each item replies to the one before it.
      if (Array.isArray(node.thread_items)) {
        const posts = node.thread_items.map(t => t?.post).filter(p => p?.code);
        for (let i = 1; i < posts.length; i++) parents.set(str(posts[i].pk), posts[i - 1]);
      }
      if (!isThreadsPost(node) || node.ad_id || node.ad_metadata) return;
      const id = str(node.pk) ?? String(node.id).split('_')[0];
      const reposted = node.text_post_app_info?.share_info?.reposted_post;
      if (reposted?.code) {
        repostedBy.set(str(reposted.pk), node.user.username);
        found.set(id, found.get(id) ?? null);
        return;
      }
      if (!found.get(id)) found.set(id, node);
    });
  }
  return [...found.entries()].filter(([, node]) => node)
    .map(([id, node]) => threadsPostToItem(node, { parent: parents.get(id), reposted_by: repostedBy.get(id) }));
}

