import { platformFor, responseMatches } from './match.js';
import { EMBEDDED, parseDocument, parsePayload } from './parsers/index.js';
import { loadSettings } from './settings.js';

// Isolated-world side of the page hook: parses captured responses and the
// page's embedded data into posts, archives raw responses, and runs reply-thread
// fetches the background asks this tab to do.
const platform = platformFor(location.hostname);
// Re-injected after an update: the previous copy is orphaned, so this one takes over.
if (platform && globalThis.__postholeContent !== __BUILD__) {
  globalThis.__postholeContent = __BUILD__;
  start();
}

function endpointOf(payload) {
  try {
    const url = new URL(payload.url);
    if (platform === 'x') return `graphql:${url.pathname.split('/').pop()}`;
    if (platform === 'bluesky') return `xrpc:${url.pathname.split('/xrpc/')[1] ?? url.pathname}`;
    if (platform === 'threads') return `graphql:${new URLSearchParams(payload.requestBody ?? '').get('fb_api_req_friendly_name') ?? url.pathname}`;
    if (platform === 'linkedin') return url.searchParams.get('queryId')?.split('.')[0] ?? url.pathname;
    return url.pathname;
  } catch { return payload.via ?? 'unknown'; }
}

function start() {
  let settings = null;
  const early = [];
  let batch = [];
  let timer = null;
  const active = () => settings && !settings.paused && settings.platforms[platform] !== false;
  // After an extension update this copy is orphaned (a fresh one is injected); stay silent then.
  const send = message => {
    try { return chrome.runtime.sendMessage(message).catch(() => {}); } catch { return Promise.resolve(); }
  };
  const report = error => send({ type: 'error', platform, message: `${error?.message ?? error}` });

  const flush = () => {
    clearTimeout(timer);
    const items = batch;
    batch = [];
    if (items.length) send({ type: 'items', platform, page: location.href, items });
  };
  const queue = (items, context) => {
    if (!items.length) return;
    for (const i of items) i.context = { ...i.context, ...context };
    batch.push(...items);
    clearTimeout(timer);
    if (batch.length >= 100) flush(); else timer = setTimeout(flush, 800);
  };
  // Posts found while fetching a thread sit one level deeper than the post it was fetched for.
  const contextOf = payload => (payload.expand
    ? { endpoint: `thread:${payload.label ?? endpointOf(payload)}`, depth: payload.expand.depth + 1, thread_of: payload.expand.key }
    : { endpoint: endpointOf(payload), depth: 0 });

  const handle = payload => {
    if (!settings) { early.push(payload); return; }
    if (!active()) return;
    if (settings.archiveRaw) send({ type: 'raw', platform, page: location.href, payload });
    if (payload.encoding === 'base64' || !(responseMatches(platform, payload.url) || payload.expand)) return;
    try { queue(parsePayload(platform, payload), contextOf(payload)); } catch (error) { report(error); }
  };
  document.addEventListener('posthole:payload', event => {
    try { handle(JSON.parse(event.detail)); } catch (error) { report(error); }
  });
  document.addEventListener('posthole:template', event => {
    try { send({ type: 'template', platform, ...JSON.parse(event.detail) }); } catch { /* ignore */ }
  });

  // Data that arrives inside the HTML rather than over the network.
  const processed = new WeakSet();
  const embedded = EMBEDDED[platform] ? () => document.querySelectorAll(EMBEDDED[platform]) : null;
  const scanEmbedded = () => {
    if (!active() || !embedded) return;
    for (const el of embedded()) {
      if (processed.has(el)) continue;
      processed.add(el);
      const body = el.textContent;
      if (body.length < 50 || !/^\s*[{[]/.test(body)) continue;
      try { queue(parsePayload(platform, { body }), { endpoint: 'html', depth: 0 }); } catch (error) { report(error); }
    }
  };
  const archivePage = () => {
    if (active() && settings.archiveRaw) send({ type: 'raw', platform, page: location.href, payload: { via: 'document', url: location.href, contentType: 'text/html', body: document.documentElement.outerHTML } });
  };
  const scanDocument = () => {
    if (!active()) return;
    if (platform === 'hackernews') {
      archivePage();
      try { queue(parseDocument(platform, document, settings), { endpoint: 'html', depth: 0 }); } catch (error) { report(error); }
    }
    scanEmbedded();
  };

  // LinkedIn may inline first-screen data in scripts it removes after hydration; catch them as they arrive.
  const inline = [];
  const inlineObserver = platform === 'linkedin' ? new MutationObserver(records => {
    for (const r of records) for (const n of r.addedNodes) {
      if (n.nodeName === 'SCRIPT' && !n.src && n.textContent.length > 2000) inline.push(n.textContent);
    }
  }) : null;
  inlineObserver?.observe(document, { childList: true, subtree: true });
  const flushInline = () => {
    inlineObserver?.disconnect();
    if (!inline.length || !active()) return;
    for (const body of inline.splice(0)) {
      if (settings.archiveRaw) send({ type: 'raw', platform, page: location.href, payload: { via: 'inline-script', url: location.href, contentType: 'text/javascript', body } });
      try { queue(parsePayload(platform, { body }), { endpoint: 'inline', depth: 0 }); } catch (error) { report(error); }
    }
  };

  let rescan = null;
  const observer = new MutationObserver(records => {
    if (!embedded || !records.some(r => [...r.addedNodes].some(n => n.nodeName === 'SCRIPT' || n.nodeName === 'CODE'))) return;
    clearTimeout(rescan);
    rescan = setTimeout(scanEmbedded, 300);
  });

  // ---- reply threads ------------------------------------------------------------

  // Hacker News item pages hold the whole comment tree; fetch them like a reader would.
  async function expandHackerNews(job, pages) {
    let url = `https://news.ycombinator.com/item?id=${encodeURIComponent(job.target.id)}`;
    for (let page = 0; page < pages && url; page++) {
      const response = await fetch(url, { credentials: 'include' });
      const html = await response.text();
      if (!response.ok) return { status: response.status === 503 || response.status === 429 ? 'rate-limited' : `http-${response.status}`, pages: page };
      const doc = new DOMParser().parseFromString(html, 'text/html');
      if (settings.archiveRaw) send({ type: 'raw', platform, page: location.href, payload: { via: 'posthole', url, contentType: 'text/html', body: html, expand: job } });
      queue(parseDocument(platform, doc, settings), { endpoint: 'thread:item', depth: job.depth + 1, thread_of: job.key });
      const more = doc.querySelector('a.morelink')?.getAttribute('href');
      url = more ? new URL(more, url).href : null;
    }
    return { status: 'ok' };
  }

  const pendingExpansions = new Map();
  document.addEventListener('posthole:expand-done', event => {
    try {
      const result = JSON.parse(event.detail);
      pendingExpansions.get(result.key)?.(result);
      pendingExpansions.delete(result.key);
    } catch { /* ignore */ }
  });
  const expandInPage = job => new Promise(resolve => {
    pendingExpansions.set(job.key, resolve);
    document.dispatchEvent(new CustomEvent('posthole:expand', { detail: JSON.stringify(job) }));
    setTimeout(() => { if (pendingExpansions.delete(job.key)) resolve({ status: 'timeout' }); }, 120000);
  });

  chrome.runtime.onMessage.addListener((message, _sender, respond) => {
    if (message?.type !== 'expand' || !settings) return false;
    const run = platform === 'hackernews' ? expandHackerNews(message.job, message.job.options.pages) : expandInPage(message.job);
    run.then(result => { flush(); respond(result); }, error => respond({ status: 'error', detail: String(error?.message ?? error) }));
    return true;
  });

  // ---- settings -------------------------------------------------------------------

  const apply = (next, templates) => {
    settings = next;
    document.dispatchEvent(new CustomEvent('posthole:config', { detail: JSON.stringify({ archiveRaw: settings.archiveRaw, ...(templates ? { templates } : {}) }) }));
  };
  Promise.all([loadSettings(), send({ type: 'templates', platform })]).then(([next, templates]) => {
    apply(next, templates);
    early.splice(0).forEach(handle);
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', scanDocument, { once: true });
    else scanDocument();
    if (embedded) observer.observe(document, { childList: true, subtree: true });
    // Keep the rendered app shell too (Threads and LinkedIn embed post data in it).
    if (platform !== 'hackernews') setTimeout(archivePage, 5000);
    setTimeout(flushInline, 4000);
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.settings) loadSettings().then(next => apply(next));
  });
  addEventListener('pagehide', flush);
}
