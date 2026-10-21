// Pure helpers for fetching reply threads. The page hook uses them to replay
// the site's own API requests; the background uses expandTarget to decide
// which posts have threads worth fetching.
import { walk } from './schema.js';

export const cookie = (cookies, name) => {
  const match = cookies.split(/;\s*/).find(part => part.startsWith(`${name}=`));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : null;
};

// What to ask each site for, given a saved record. Null when there is nothing to fetch.
export function expandTarget(record) {
  if (!(record.metrics?.replies > 0)) return null;
  switch (record.platform) {
    case 'x': return { id: record.id };
    case 'bluesky': return { uri: record.id };
    case 'hackernews': return record.kind === 'story' ? { id: record.id } : null;
    case 'threads': return { id: record.id, code: record.extra?.code ?? null };
    case 'linkedin':
      if (record.extra?.comments_request) return { id: record.id, request: record.extra.comments_request };
      return record.extra?.social_detail_urn ? { id: record.id, socialDetailUrn: record.extra.social_detail_urn } : null;
    default: return null;
  }
}

// ---- X ---------------------------------------------------------------------------

const X_VARIABLES = { with_rux_injections: false, rankingMode: 'Relevance', includePromotedContent: true, withCommunity: true, withQuickPromoteEligibilityTweetFields: true, withBirdwatchNotes: true, withVoice: true };
const X_TOGGLES = { withArticleRichContentState: true, withArticlePlainText: false, withGrokAnalyze: false, withDisallowedReplyControls: false };

// Builds a TweetDetail request shaped like one the X client sent (same features
// and toggles), for a different focal post and optional page cursor.
export function xDetailUrl({ queryId, focal, cursor, shapeFrom }) {
  const shape = new URL(shapeFrom);
  const own = /\/TweetDetail$/.test(shape.pathname);
  const json = (name, fallback) => { try { return JSON.parse(shape.searchParams.get(name)) ?? fallback; } catch { return fallback; } };
  const variables = { ...(own ? json('variables', X_VARIABLES) : X_VARIABLES), focalTweetId: focal };
  delete variables.cursor;
  delete variables.referrer;
  if (cursor) Object.assign(variables, { cursor, referrer: 'tweet' });
  const params = new URLSearchParams({ variables: JSON.stringify(variables) });
  if (shape.searchParams.get('features')) params.set('features', shape.searchParams.get('features'));
  params.set('fieldToggles', own && shape.searchParams.get('fieldToggles') ? shape.searchParams.get('fieldToggles') : JSON.stringify(X_TOGGLES));
  return `${shape.origin}/i/api/graphql/${queryId}/TweetDetail?${params}`;
}

// Cursors that load more of a conversation: the next page and "show more replies".
export function xCursors(body) {
  const out = [];
  let root;
  try { root = JSON.parse(body); } catch { return out; }
  walk(root, node => {
    if (typeof node.value === 'string' && /^(Bottom|ShowMore|ShowMoreThreads|ShowMoreThreadsPrompt)$/.test(node.cursorType ?? '')) out.push(node.value);
  });
  return [...new Set(out)];
}

// ---- LinkedIn ----------------------------------------------------------------------

// Rest.li values inside variables=(…) are percent-encoded, including parentheses.
const restli = value => encodeURIComponent(value).replace(/\(/g, '%28').replace(/\)/g, '%29');

export function linkedInCommentsUrl(templateUrl, socialDetailUrn, start) {
  if (/variables=\(/.test(templateUrl)) {
    return templateUrl
      .replace(/socialDetailUrn:[^,)]+/, `socialDetailUrn:${restli(socialDetailUrn)}`)
      .replace(/([(,])start:\d+/, `$1start:${start}`)
      .replace(/,?paginationToken:[^,)]+/, '');
  }
  const url = new URL(templateUrl);
  url.searchParams.set('start', String(start));
  const activity = socialDetailUrn.match(/urn:li:activity:(\d+)/)?.[1];
  if (activity && url.searchParams.has('updateId')) url.searchParams.set('updateId', `activity:${activity}`);
  return url.href;
}

// LinkedIn's server-driven UI: replay the post's own "load comments" request, asking for more of them.
export function linkedInSduiBody(request, { pageSize = 100, screenId = 'com.linkedin.sdui.flagshipnav.feed.MainFeed' } = {}) {
  const args = structuredClone(request.requestedArguments ?? {});
  if (args.payload && 'pageSize' in args.payload) args.payload.pageSize = pageSize;
  return JSON.stringify({
    requestId: request.requestId,
    serverRequest: { requestId: request.requestId, requestedArguments: args, isApfcEnabled: false, isStreaming: false, rumPageKey: '' },
    states: [],
    requestedArguments: { ...args, states: [], screenId, knownTemplateIds: [] },
  });
}

// ---- Threads -----------------------------------------------------------------------

// Session tokens Threads expects on every GraphQL POST, refreshed from the page's latest request.
const THREADS_TOKENS = ['av', '__user', '__a', '__req', '__hs', 'dpr', '__ccg', '__rev', '__s', '__hsi', '__dyn', '__csr', '__comet_req', 'fb_dtsg', 'jazoest', 'lsd', '__spin_r', '__spin_b', '__spin_t'];

export function threadsReplayBody(templateBody, liveParams, postId) {
  const params = new URLSearchParams(templateBody);
  for (const key of THREADS_TOKENS) if (liveParams?.has(key)) params.set(key, liveParams.get(key));
  let variables = {};
  try { variables = JSON.parse(params.get('variables') ?? '{}'); } catch { /* keep empty */ }
  for (const key of Object.keys(variables)) if (/^post_?id$/i.test(key)) variables[key] = postId;
  if (!Object.keys(variables).some(k => /^post_?id$/i.test(k))) variables.postID = postId;
  params.set('variables', JSON.stringify(variables));
  return params.toString();
}
