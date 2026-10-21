import { parseX } from './x.js';
import { parseBluesky } from './bluesky.js';
import { parseThreads } from './threads.js';
import { parseLinkedIn } from './linkedin.js';
import { parseHackerNewsDocument } from './hackernews.js';

// Network responses (and JSON embedded in HTML) for the API-driven sites.
const network = { x: parseX, bluesky: parseBluesky, threads: parseThreads, linkedin: parseLinkedIn };
export const parsePayload = (platform, payload) => network[platform]?.(payload) ?? [];

// Elements whose text is JSON the site embedded in its HTML.
export const EMBEDDED = { threads: 'script[type="application/json"][data-sjs]', linkedin: 'code' };

// Hacker News is server-rendered: the document itself is the source.
export const parseDocument = (platform, doc, settings = {}) =>
  platform === 'hackernews' ? parseHackerNewsDocument(doc, { comments: settings.hnComments !== false }) : [];
