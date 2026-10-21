// Which site a page belongs to, and which of its network responses carry posts.
// Shared by the page hook (which must stay small) and the content script.
export function platformFor(hostname) {
  const host = hostname.replace(/^www\./, '');
  if (host === 'x.com' || host === 'twitter.com' || host === 'mobile.x.com') return 'x';
  if (host === 'linkedin.com' || host.endsWith('.linkedin.com')) return 'linkedin';
  if (host === 'bsky.app') return 'bluesky';
  if (/(^|\.)threads\.(com|net)$/.test(host)) return 'threads';
  if (host === 'news.ycombinator.com') return 'hackernews';
  return null;
}

const API = {
  x: /\/graphql\/|\/i\/api\//,
  bluesky: /\/xrpc\/app\.bsky\./,
  threads: /graphql|\/api\/v1\//,
  linkedin: /\/voyager\/api\/|\/flagship-web\/|\/rsc|sdui/i,
};

export const responseMatches = (platform, url) => Boolean(API[platform]?.test(url));
