import { decodeEntities, iso, item, makePost, num, parseJsonish, walk } from '../schema.js';

// X's web client loads every post through GraphQL (HomeTimeline, TweetDetail,
// UserTweets, SearchTimeline, Bookmarks, ...). Each response nests full Tweet
// objects; walking for them covers every endpoint without per-operation code.

const unwrap = node => {
  let t = node;
  for (let i = 0; i < 3 && t; i++) {
    if (t.__typename === 'TweetWithVisibilityResults' || (t.tweet && !t.legacy)) t = t.tweet;
    else break;
  }
  return t?.rest_id && t.legacy ? t : null;
};
// User objects also carry rest_id + legacy.created_at; only tweets have full_text.
const isTweet = node => node.rest_id && node.legacy && typeof node.legacy.created_at === 'string'
  && ('full_text' in node.legacy || 'conversation_id_str' in node.legacy) && !('screen_name' in node.legacy);

function user(tweet) {
  let u = tweet.core?.user_results?.result;
  if (u?.__typename === 'UserUnavailable') u = null;
  const handle = u?.core?.screen_name ?? u?.legacy?.screen_name ?? null;
  const avatar = u?.avatar?.image_url ?? u?.legacy?.profile_image_url_https ?? null;
  return {
    id: u?.rest_id ?? null,
    handle,
    name: u?.core?.name ?? u?.legacy?.name ?? null,
    url: handle ? `https://x.com/${handle}` : null,
    verified: Boolean(u?.is_blue_verified || u?.verification?.verified || u?.legacy?.verified),
    avatar_url: avatar ? avatar.replace(/_normal(\.\w+)$/, '_400x400$1') : null,
  };
}

function bestVariant(info) {
  const mp4 = (info?.variants ?? []).filter(v => v.content_type === 'video/mp4' && v.url);
  mp4.sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0));
  return mp4[0]?.url ?? null;
}

function mediaOf(list) {
  return (list ?? []).map(m => {
    const width = m.original_info?.width, height = m.original_info?.height;
    if (m.type === 'photo') {
      const url = m.media_url_https?.replace(/\.(jpg|jpeg|png|webp)$/i, (_, ext) => `.${ext}?name=orig`);
      return { type: 'image', url, alt: m.ext_alt_text, width, height };
    }
    if (m.type === 'video' || m.type === 'animated_gif') {
      return {
        type: m.type === 'video' ? 'video' : 'gif', url: bestVariant(m.video_info), mime: 'video/mp4', alt: m.ext_alt_text,
        width, height, duration_ms: m.video_info?.duration_millis, thumbnail_url: m.media_url_https,
      };
    }
    return null;
  }).filter(Boolean);
}

function textOf(tweet) {
  const note = tweet.note_tweet?.note_tweet_results?.result;
  const legacy = tweet.legacy;
  const entities = note?.entity_set ?? legacy.entities ?? {};
  let text;
  if (note?.text) text = note.text;
  else {
    const chars = Array.from(legacy.full_text ?? '');
    const [start, end] = legacy.display_text_range ?? [0, chars.length];
    text = chars.slice(start, end).join('');
  }
  for (const u of entities.urls ?? legacy.entities?.urls ?? []) if (u.url && u.expanded_url) text = text.split(u.url).join(u.expanded_url);
  for (const m of legacy.entities?.media ?? []) if (m.url) text = text.split(m.url).join('');
  return {
    text: decodeEntities(text).trim(),
    links: (entities.urls ?? []).filter(u => u.expanded_url).map(u => ({ url: u.expanded_url, text: u.display_url ?? null })),
    mentions: (entities.user_mentions ?? []).map(m => m.screen_name).filter(Boolean),
    hashtags: (entities.hashtags ?? []).map(h => h.text).filter(Boolean),
  };
}

// Keep the feed's presentation as data as well as the full searchable text. A
// note's legacy text is the actual collapsed preview, not an arbitrary slice.
export function presentationOf(tweet) {
  const u = tweet.core?.user_results?.result;
  const preview = tweet.note_tweet ? textOf({ ...tweet, note_tweet: null }).text : null;
  return {
    preview_text: preview,
    verified_type: u?.verification?.verified_type ?? u?.legacy?.verified_type ?? null,
    liked: Boolean(tweet.legacy?.favorited),
    reposted: Boolean(tweet.legacy?.retweeted),
    bookmarked: Boolean(tweet.legacy?.bookmarked),
  };
}

function cardOf(tweet) {
  const legacy = tweet.card?.legacy;
  if (!legacy?.binding_values) return null;
  const values = Object.fromEntries((Array.isArray(legacy.binding_values) ? legacy.binding_values : Object.entries(legacy.binding_values).map(([key, value]) => ({ key, value })))
    .map(({ key, value }) => [key, value]));
  const s = key => values[key]?.string_value ?? null;
  const image = ['photo_image_full_size_original', 'thumbnail_image_original', 'summary_photo_image_original', 'player_image_original', 'photo_image_full_size_large', 'thumbnail_image_large']
    .map(k => values[k]?.image_value?.url).find(Boolean) ?? null;
  const short = s('card_url') ?? legacy.url;
  const expanded = (tweet.legacy.entities?.urls ?? []).find(u => u.url === short)?.expanded_url;
  const url = expanded ?? s('vanity_url') ?? short;
  if (!s('title') && !image) return null;
  return { url: url && /^https?:/.test(url) ? url : url ? `https://${url}` : null, title: s('title'), description: s('description'), domain: s('domain') ?? s('vanity_url'), image_url: image };
}

function articleOf(tweet) {
  const a = tweet.article?.article_results?.result;
  if (!a) return null;
  const blocks = a.content_state?.blocks ?? [];
  const media = [];
  const cover = a.cover_media?.media_info?.original_img_url;
  if (cover) media.push({ type: 'image', url: cover, width: a.cover_media.media_info.original_img_width, height: a.cover_media.media_info.original_img_height });
  for (const m of a.media_entities ?? []) {
    const url = m.media_info?.original_img_url;
    if (url && url !== cover) media.push({ type: 'image', url, width: m.media_info.original_img_width, height: m.media_info.original_img_height });
  }
  return { title: a.title ?? null, text: blocks.length ? blocks.map(b => b.text).join('\n\n') : a.preview_text ?? '', media, id: a.rest_id ?? null };
}

export function tweetToItem(tweet, context = {}) {
  const legacy = tweet.legacy;
  const author = user(tweet);
  const id = tweet.rest_id;
  const { text, links, mentions, hashtags } = textOf(tweet);
  const article = articleOf(tweet);
  const quoted = unwrap(tweet.quoted_status_result?.result ?? null);
  const quoteId = quoted?.rest_id ?? legacy.quoted_status_id_str ?? null;
  const quoteHandle = quoted ? user(quoted).handle : null;
  const replyId = legacy.in_reply_to_status_id_str ?? null;
  const record = makePost('x', {
    id,
    url: `https://x.com/${author.handle ?? 'i'}/status/${id}`,
    kind: article ? 'article' : replyId ? 'reply' : quoteId ? 'quote' : 'post',
    author,
    created_at: iso(legacy.created_at),
    title: article?.title ?? null,
    text: article ? article.text || text : text,
    lang: legacy.lang && legacy.lang !== 'und' && legacy.lang !== 'zxx' ? legacy.lang : null,
    links, mentions, hashtags,
    media: [...(article?.media ?? []), ...mediaOf(legacy.extended_entities?.media ?? legacy.entities?.media)],
    link_card: cardOf(tweet),
    reply_to: replyId ? { id: replyId, url: `https://x.com/${legacy.in_reply_to_screen_name ?? 'i'}/status/${replyId}`, author_handle: legacy.in_reply_to_screen_name ?? null } : null,
    thread_root: legacy.conversation_id_str && legacy.conversation_id_str !== id ? { id: legacy.conversation_id_str, url: `https://x.com/i/status/${legacy.conversation_id_str}` } : null,
    quote_of: quoteId ? { platform: 'x', id: quoteId, url: legacy.quoted_status_permalink?.expanded ?? `https://x.com/${quoteHandle ?? 'i'}/status/${quoteId}` } : null,
    metrics: {
      likes: legacy.favorite_count, reposts: legacy.retweet_count, replies: legacy.reply_count, quotes: legacy.quote_count,
      bookmarks: legacy.bookmark_count, views: num(tweet.views?.count),
    },
    extra: {
      display: presentationOf(tweet),
      conversation_id: legacy.conversation_id_str ?? null,
      long_post: Boolean(tweet.note_tweet),
      possibly_sensitive: legacy.possibly_sensitive ?? null,
      ...(article?.id ? { article_id: article.id } : {}),
      ...(tweet.community_results?.result?.name ? { community: tweet.community_results.result.name } : {}),
    },
  });
  return item(record, tweet, context);
}

export function parseX(payload) {
  const found = new Map();
  const repostedBy = new Map();
  const promoted = new Set();
  for (const root of parseJsonish(payload.body)) {
    walk(root, node => {
      // Timeline items mark ads beside the tweet they wrap.
      if (node.promotedMetadata && node.tweet_results?.result) {
        const t = unwrap(node.tweet_results.result);
        if (t) promoted.add(t.rest_id);
      }
      const tweet = isTweet(node) ? node : null;
      if (!tweet || found.has(tweet.rest_id)) return;
      const original = unwrap(tweet.legacy.retweeted_status_result?.result ?? null);
      if (original) {
        // A repost wrapper is context, not content: keep the original, note who reposted.
        repostedBy.set(original.rest_id, user(tweet).handle);
        found.set(tweet.rest_id, null);
        return;
      }
      found.set(tweet.rest_id, tweet);
    });
  }
  const items = [];
  for (const [id, tweet] of found) {
    if (!tweet || promoted.has(id)) continue;
    items.push(tweetToItem(tweet, repostedBy.has(id) ? { reposted_by: repostedBy.get(id) } : {}));
  }
  return items;
}
