import { iso, item, makePost, parseJsonish, walk } from '../schema.js';
import { looksLikeFlight } from '../rsc.js';
import { activityTime, parseLinkedInFlight } from './linkedin-sdui.js';

export { activityTime };

// LinkedIn's Voyager API returns normalized JSON: entities live in `included`
// and reference each other by URN through "*field" keys. Feed, profile activity
// and post detail all deliver feed Update entities.

function index(roots) {
  const byUrn = new Map();
  for (const root of roots) walk(root, node => { if (typeof node.entityUrn === 'string' && !byUrn.has(node.entityUrn)) byUrn.set(node.entityUrn, node); });
  return byUrn;
}

function resolver(byUrn) {
  const deref = value => (typeof value === 'string' && value.startsWith('urn:') ? byUrn.get(value) ?? null : value ?? null);
  return (obj, key) => (obj ? obj[key] ?? deref(obj[`*${key}`]) : null);
}

function vectorUrl(vector) {
  if (!vector?.artifacts?.length) return null;
  const biggest = [...vector.artifacts].sort((a, b) => (b.width ?? 0) - (a.width ?? 0))[0];
  return `${vector.rootUrl ?? ''}${biggest.fileIdentifyingUrlPathSegment ?? ''}` || null;
}

// Images hide at varying depths (detailData.vectorImage, profilePicture.displayImageReference, ...).
function firstVector(node, get, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 6) return null;
  if (node.rootUrl !== undefined && Array.isArray(node.artifacts)) return node;
  for (const [key, value] of Object.entries(node)) {
    const next = key.startsWith('*') ? get(node, key.slice(1)) : value;
    const found = firstVector(next, get, depth + 1);
    if (found) return found;
  }
  return null;
}

const text = value => value?.text?.text ?? value?.text ?? (typeof value === 'string' ? value : null);
const activityId = urn => urn?.match(/urn:li:activity:(\d+)/)?.[1] ?? null;

function contentParts(content, get) {
  const media = [];
  let link_card = null, title = null;
  if (!content) return { media, link_card, title };
  for (const image of content.imageComponent?.images ?? []) {
    const url = vectorUrl(firstVector(image, get));
    if (url) media.push({ type: 'image', url, alt: image.accessibilityText ?? null });
  }
  const video = content.linkedInVideoComponent;
  if (video) {
    const meta = get(video, 'videoPlayMetadata');
    const streams = [...(meta?.progressiveStreams ?? [])].sort((a, b) => (b.width ?? 0) - (a.width ?? 0));
    const url = streams[0]?.streamingLocations?.[0]?.url ?? null;
    media.push({ type: 'video', url, mime: streams[0]?.mediaType ?? 'video/mp4', width: streams[0]?.width, height: streams[0]?.height, duration_ms: meta?.duration, thumbnail_url: vectorUrl(firstVector(meta?.thumbnail, get)) });
  }
  const article = content.articleComponent;
  if (article) {
    link_card = {
      url: article.navigationContext?.actionTarget ?? null, title: text(article.title), description: text(article.subtitle) ?? text(article.description),
      image_url: vectorUrl(firstVector(article.largeImage ?? article.smallImage, get)),
    };
  }
  const doc = content.documentComponent?.document;
  if (doc) {
    title = doc.title ?? null;
    media.push({ type: 'document', url: doc.transcribedDocumentUrl ?? doc.manifestUrl ?? null, mime: 'application/pdf', thumbnail_url: vectorUrl(firstVector(doc.coverPages, get)) });
  }
  return { media, link_card, title };
}

function attributes(commentary) {
  const links = [], mentions = [], hashtags = [];
  const body = commentary?.text?.text ?? '';
  for (const a of commentary?.text?.attributesV2 ?? []) {
    const slice = body.slice(a.start, a.start + a.length);
    const d = a.detailData ?? {};
    if (d.hashtag || d['*hashtag']) hashtags.push(slice.replace(/^#/, ''));
    else if (d.profileFullName || d.profileMention || d['*profileFullName'] || d.companyName || d['*companyName']) mentions.push(slice);
    else if (d.hyperlink?.url || d.textLink?.url) links.push({ url: d.hyperlink?.url ?? d.textLink.url, text: slice });
  }
  return { links, mentions, hashtags };
}

export function updateToItem(update, get) {
  const metadata = update.metadata ?? update.updateMetadata ?? {};
  const urn = metadata.backendUrn ?? metadata.urn ?? update.entityUrn;
  const id = activityId(urn);
  if (!id) return null;
  const actor = update.actor ?? {};
  const actorUrl = actor.navigationContext?.actionTarget?.split('?')[0] ?? null;
  const handle = actorUrl?.match(/linkedin\.com\/(?:in|company|school|showcase)\/([^/?#]+)/)?.[1] ?? null;
  const social = get(update, 'socialDetail');
  const counts = get(social, 'totalSocialActivityCounts') ?? social?.totalSocialActivityCounts ?? {};
  const reshared = get(update, 'resharedUpdate');
  const resharedId = activityId(reshared?.metadata?.backendUrn ?? reshared?.entityUrn);
  const { media, link_card, title } = contentParts(update.content, get);
  const record = makePost('linkedin', {
    id,
    url: `https://www.linkedin.com/feed/update/urn:li:activity:${id}/`,
    kind: resharedId ? 'quote' : 'post',
    author: {
      id: actor.backendUrn ?? actor.urn ?? null, handle, name: text(actor.name), url: actorUrl,
      description: text(actor.description), avatar_url: vectorUrl(firstVector(actor.image, get)),
    },
    created_at: activityTime(id),
    title,
    text: update.commentary?.text?.text ?? '',
    ...attributes(update.commentary),
    media, link_card,
    quote_of: resharedId ? { platform: 'linkedin', id: resharedId, url: `https://www.linkedin.com/feed/update/urn:li:activity:${resharedId}/` } : null,
    metrics: { likes: counts.numLikes, replies: counts.numComments, reposts: counts.numShares, views: counts.numImpressions },
    extra: {
      urn, share_urn: metadata.shareUrn ?? null, social_detail_urn: social?.entityUrn ?? update['*socialDetail'] ?? null,
      actor_line: text(actor.subDescription), ...(text(update.header) ? { header: text(update.header) } : {}),
    },
  });
  return item(record, update);
}

// Comments (and replies to comments) arrive as their own entities.
// urn:li:comment:(activity:7254…,7255…) or urn:li:comment:(urn:li:activity:7254…,7255…)
const commentParts = urn => urn?.match(/urn:li:comment:\((?:urn:li:)?(activity|ugcPost|share):(\d+),(\d+)\)/);

export function commentToItem(comment, get) {
  const urn = comment.urn ?? comment.entityUrn?.match(/urn:li:comment:\([^)]*\)/)?.[0] ?? null;
  const parts = commentParts(urn) ?? commentParts(comment.entityUrn);
  if (!parts) return null;
  const [, parentType, parentId, id] = parts;
  const commenter = comment.commenter ?? {};
  const actorUrl = commenter.navigationContext?.actionTarget?.split('?')[0] ?? commenter.commenterProfileUrl ?? null;
  const social = get(comment, 'socialDetail');
  const counts = get(social, 'totalSocialActivityCounts') ?? social?.totalSocialActivityCounts ?? {};
  const parentComment = commentParts(comment.parentCommentUrn ?? get(comment, 'parentComment')?.urn ?? null);
  const postUrl = `https://www.linkedin.com/feed/update/urn:li:${parentType}:${parentId}/`;
  const { media } = contentParts(comment.content, get);
  const record = makePost('linkedin', {
    id: `urn:li:comment:(${parentType}:${parentId},${id})`,
    url: comment.permalink ?? `${postUrl}?commentUrn=${encodeURIComponent(`urn:li:comment:(${parentType}:${parentId},${id})`)}`,
    kind: 'comment',
    author: {
      id: commenter.commenterProfileId ?? commenter.urn ?? null,
      handle: actorUrl?.match(/linkedin\.com\/(?:in|company|school|showcase)\/([^/?#]+)/)?.[1] ?? null,
      name: text(commenter.title) ?? text(commenter.name), url: actorUrl,
      description: text(commenter.subtitle), avatar_url: vectorUrl(firstVector(commenter.image, get)),
    },
    created_at: iso(comment.createdAt) ?? activityTime(id),
    text: comment.commentary?.text ?? text(comment.commentary) ?? '',
    ...attributes({ text: comment.commentary }),
    media,
    reply_to: parentComment
      ? { id: `urn:li:comment:(${parentComment[1]}:${parentComment[2]},${parentComment[3]})`, url: null }
      : { id: parentType === 'activity' ? parentId : `urn:li:${parentType}:${parentId}`, url: postUrl },
    thread_root: parentComment ? { id: parentId, url: postUrl } : null,
    metrics: { likes: counts.numLikes, replies: counts.numComments ?? comment.socialDetail?.comments?.paging?.total },
    extra: { urn, social_detail_urn: social?.entityUrn ?? comment['*socialDetail'] ?? null },
  });
  return item(record, comment);
}

const isUpdate = node => /feed\.(?:render\.)?Update(?:V2)?$/.test(node.$type ?? '') || (node.commentary?.text?.text !== undefined && (node.metadata?.backendUrn || node.updateMetadata?.urn));
const isComment = node => /social\.Comment$/.test(node.$type ?? '') || (node.commenter && node.commentary && /urn:li:(fsd_)?comment:/.test(`${node.urn ?? ''}${node.entityUrn ?? ''}`));
const isSponsored = node => Boolean(node.metadata?.trackingData?.sponsoredTracking || node.updateMetadata?.trackingData?.sponsoredTracking || /promoted/i.test(text(node.actor?.subDescription) ?? ''));

export function parseLinkedInRoots(roots) {
  const byUrn = index(roots);
  const get = resolver(byUrn);
  const found = new Map();
  for (const root of roots) {
    walk(root, node => {
      let result = null;
      if (isUpdate(node) && !isSponsored(node)) result = updateToItem(node, get);
      else if (isComment(node)) result = commentToItem(node, get);
      if (result && !found.has(result.record.id)) found.set(result.record.id, result);
    });
  }
  return [...found.values()];
}

// The current feed is server-driven UI (RSC flight); older surfaces still use Voyager JSON.
export function parseLinkedIn(payload) {
  let body = payload.body;
  if (payload.encoding === 'base64') body = new TextDecoder().decode(Uint8Array.from(atob(body), c => c.charCodeAt(0)));
  if (looksLikeFlight(body)) return parseLinkedInFlight(body);
  return parseLinkedInRoots(parseJsonish(body));
}
