import { platformFor, responseMatches } from './match.js';
import { cookie, linkedInCommentsUrl, linkedInSduiBody, threadsReplayBody, xCursors, xDetailUrl } from './expand.js';

// Runs in the page's own JavaScript world at document_start, before the site's
// scripts, so it sees the same API responses they do. It reads copies only and
// never alters the site's own requests. Payloads go to the isolated content
// script as DOM events.
//
// It also remembers the shape of the site's own API requests (URL, query IDs,
// headers) so posthole can ask the same API for reply threads you haven't opened.
(() => {
  // After an extension update a new copy is injected beside the old one; only the newest acts.
  if (window.__postholeActive === __BUILD__) return;
  window.__postholeActive = __BUILD__;
  const current = () => window.__postholeActive === __BUILD__;
  const platform = platformFor(location.hostname);
  if (!platform) return;
  let archiveRaw = true;
  let stored = {};
  document.addEventListener('posthole:config', event => {
    try {
      const config = JSON.parse(event.detail);
      archiveRaw = Boolean(config.archiveRaw);
      stored = config.templates ?? stored;
    } catch { /* ignore malformed config */ }
  });

  const MAX = 32 * 1024 * 1024;
  const SKIP = /^(image|video|audio|font)\/|css|javascript|wasm|event-stream/;
  const wanted = (url, type) => {
    if (SKIP.test(type || '')) return false;
    return responseMatches(platform, url) || (archiveRaw && /json|text|x-component|protobuf|octet-stream/.test(type || ''));
  };
  const emit = detail => {
    if (!current()) return;
    try { document.dispatchEvent(new CustomEvent('posthole:payload', { detail: JSON.stringify(detail) })); } catch { /* best effort */ }
  };
  const base64 = buffer => {
    const bytes = new Uint8Array(buffer);
    if (bytes.toBase64) return bytes.toBase64();
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(binary);
  };
  const bodyText = body => (typeof body === 'string' ? body : body instanceof URLSearchParams ? body.toString() : '');
  // LinkedIn's server-driven UI streams UTF-8 RSC rows as application/octet-stream.
  const textual = (type, url = '') => /json|text|x-component|javascript|xml/.test(type || '') || !type || /\/flagship-web\//.test(url);

  // ---- request templates --------------------------------------------------------

  const live = {};
  const announced = new Set();
  const templateOp = (url, body) => {
    if (platform === 'x') return url.match(/\/graphql\/[^/]+\/([A-Za-z]+)/)?.[1] ?? null;
    if (platform === 'linkedin') {
      if (/voyagerSocialDashComments|\/feed\/comments/.test(url)) return 'comments';
      if (/\/rsc-action\/actions\/server-request/.test(url)) return 'sdui';
      return /\/voyager\/api\//.test(url) ? 'voyager' : null;
    }
    if (platform === 'threads') return new URLSearchParams(body).get('fb_api_req_friendly_name');
    return null;
  };
  function remember(url, method, headers, body) {
    if (!current()) return;
    try {
      const absolute = new URL(url, location.href).href;
      const text = bodyText(body);
      const op = templateOp(absolute, text);
      if (!op) return;
      live[op] = { url: absolute, method, headers, body: text, at: Date.now() };
      live._any = live[op];
      if (/[?&]features=/.test(absolute)) live._featured = live[op];
      // Persist the request's shape (never its session tokens) for other tabs and later visits,
      // once per distinct shape rather than on every request.
      const shape = `${op} ${absolute.split('?')[0]} ${new URLSearchParams(text).get('doc_id') ?? ''}`;
      if (announced.has(shape)) return;
      announced.add(shape);
      const keep = Object.fromEntries(Object.entries(headers).filter(([k]) => !/csrf|lsd|dtsg|cookie|transaction|auth-type/i.test(k)));
      document.dispatchEvent(new CustomEvent('posthole:template', { detail: JSON.stringify({ op, template: { url: absolute, method, headers: keep, body: platform === 'threads' ? text : '' } }) }));
    } catch { /* never disturb the page */ }
  }
  const headerObject = headers => {
    const out = {};
    if (!headers) return out;
    if (headers instanceof Headers || Array.isArray(headers)) for (const [k, v] of new Headers(headers)) out[k.toLowerCase()] = v;
    else for (const [k, v] of Object.entries(headers)) out[k.toLowerCase()] = String(v);
    return out;
  };

  // ---- capture -------------------------------------------------------------------

  const nativeFetch = window.fetch;
  window.fetch = new Proxy(nativeFetch, {
    apply(target, self, args) {
      try {
        const request = args[0] instanceof Request ? args[0] : null;
        const url = request ? request.url : String(args[0]);
        remember(url, (request?.method || args[1]?.method || 'GET').toUpperCase(), { ...headerObject(request?.headers), ...headerObject(args[1]?.headers) }, args[1]?.body);
      } catch { /* never disturb the page */ }
      const promise = Reflect.apply(target, self, args);
      promise.then(response => {
        try {
          const type = response.headers.get('content-type') || '';
          if (!response.ok || !wanted(response.url, type)) return;
          if (Number(response.headers.get('content-length') || 0) > MAX) return;
          const request = args[0] instanceof Request ? args[0] : null;
          const meta = { via: 'fetch', url: response.url, status: response.status, contentType: type, method: (request?.method || args[1]?.method || 'GET').toUpperCase(), requestBody: bodyText(args[1]?.body).slice(0, 20000) || null };
          const copy = response.clone();
          (textual(type, response.url) ? copy.text().then(body => ({ body })) : copy.arrayBuffer().then(b => ({ body: base64(b), encoding: 'base64' })))
            .then(result => emit({ ...meta, ...result })).catch(() => {});
        } catch { /* never disturb the page */ }
      }, () => {});
      return promise;
    },
  });

  const open = XMLHttpRequest.prototype.open;
  const send = XMLHttpRequest.prototype.send;
  const setHeader = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__postholeMeta = { method: String(method || 'GET').toUpperCase(), url: String(url), headers: {} };
    return open.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    if (this.__postholeMeta) this.__postholeMeta.headers[String(name).toLowerCase()] = String(value);
    return setHeader.call(this, name, value);
  };
  XMLHttpRequest.prototype.send = function (body) {
    const meta = this.__postholeMeta;
    if (meta) {
      meta.requestBody = bodyText(body).slice(0, 20000) || null;
      remember(meta.url, meta.method, meta.headers, body);
      this.addEventListener('loadend', () => {
        try {
          if (this.status < 200 || this.status >= 300) return;
          const type = this.getResponseHeader('content-type') || '';
          const url = this.responseURL || new URL(meta.url, location.href).href;
          if (!wanted(url, type)) return;
          let payload;
          if (this.responseType === '' || this.responseType === 'text') payload = { body: this.responseText };
          else if (this.responseType === 'json') payload = { body: JSON.stringify(this.response) };
          else if (this.responseType === 'arraybuffer' && this.response) payload = { body: base64(this.response), encoding: 'base64' };
          if (!payload || payload.body.length > MAX) return;
          emit({ via: 'xhr', url, status: this.status, contentType: type, method: meta.method, requestBody: meta.requestBody, ...payload });
        } catch { /* never disturb the page */ }
      });
    }
    return send.call(this, body);
  };

  // ---- reply threads ---------------------------------------------------------------

  const template = op => live[op] ?? stored[op] ?? null;
  const rate = response => ({
    remaining: response.headers.get('x-rate-limit-remaining') !== null ? Number(response.headers.get('x-rate-limit-remaining')) : null,
    reset: response.headers.get('x-rate-limit-reset') !== null ? Number(response.headers.get('x-rate-limit-reset')) * 1000 : null,
  });
  async function request(url, init, expand, label) {
    const response = await nativeFetch(url, { credentials: 'include', ...init });
    const type = response.headers.get('content-type') || '';
    const body = await response.text();
    if (response.ok) emit({ via: 'posthole', url: response.url, status: response.status, contentType: type, method: init.method ?? 'GET', requestBody: typeof init.body === 'string' ? init.body.slice(0, 20000) : null, body, expand, label });
    return { response, body };
  }
  const failure = (response, body) => ({ status: response.status === 429 ? 'rate-limited' : `http-${response.status}`, detail: body.slice(0, 300), rate: rate(response) });

  // The X client's own query ID for an operation, from its main bundle.
  async function xQueryId(op) {
    const src = [...document.scripts].map(s => s.src).find(s => /client-web\/main\.[\w]+\.js/.test(s))
      ?? performance.getEntriesByType('resource').map(e => e.name).find(s => /client-web\/main\.[\w]+\.js/.test(s));
    if (!src) return null;
    const js = await (await nativeFetch(src, { cache: 'force-cache' })).text();
    return js.match(new RegExp(`queryId:"([^"]+)",operationName:"${op}"`))?.[1] ?? null;
  }

  const X_PAGE_GAP = 1500;
  const X_RESERVE = 25;

  const executors = {
    async x(job, { pages }) {
      const own = template('TweetDetail');
      const any = live._any;
      if (!any?.headers?.authorization && !own?.headers?.authorization) return { status: 'not-ready', detail: 'No X API request seen yet in this tab.' };
      const queryId = own?.url.match(/\/graphql\/([^/]+)\//)?.[1] ?? await xQueryId('TweetDetail');
      if (!queryId) return { status: 'not-ready', detail: 'TweetDetail query ID unknown.' };
      const headers = { ...any.headers, ...(own?.headers ?? {}), 'x-csrf-token': cookie(document.cookie, 'ct0') ?? '' };
      delete headers['content-length'];
      // Copy the feature flags from the client's own requests; without them X omits fields.
      const shapeFrom = own?.url ?? live._featured?.url ?? Object.values(stored).find(t => /[?&]features=/.test(t.url ?? ''))?.url ?? any.url;
      const visited = new Set();
      const cursors = [null];
      let done = 0, last = null;
      while (cursors.length && done < pages) {
        const cursor = cursors.shift();
        const url = xDetailUrl({ queryId, focal: job.target.id, cursor, shapeFrom });
        if (done) await new Promise(resolve => setTimeout(resolve, X_PAGE_GAP));
        const { response, body } = await request(url, { headers }, job, 'TweetDetail');
        last = rate(response);
        done++;
        if (!response.ok) return { ...failure(response, body), pages: done };
        // Leave X's budget for your own browsing: stop paging near the limit (the background waits for the reset).
        if (last.remaining !== null && last.remaining < X_RESERVE) break;
        for (const next of xCursors(body)) if (!visited.has(next)) { visited.add(next); cursors.push(next); }
      }
      return { status: 'ok', pages: done, rate: last };
    },

    async linkedin(job, { pages }) {
      const csrf = cookie(document.cookie, 'JSESSIONID')?.replace(/"/g, '');
      if (!csrf) return { status: 'not-ready', detail: 'Not signed in to LinkedIn.' };
      if (job.target.request) {
        // Current feed: the post's own server-driven "load comments" request.
        const sdui = live.sdui ?? stored.sdui;
        const headers = { ...(sdui?.headers ?? { 'content-type': 'application/json' }), 'csrf-token': csrf };
        delete headers['content-length'];
        const url = `${location.origin}/flagship-web/rsc-action/actions/server-request?sduiid=${encodeURIComponent(job.target.request.requestId)}`;
        const { response, body } = await request(url, { method: 'POST', headers, body: linkedInSduiBody(job.target.request) }, job, 'comments');
        return response.ok ? { status: 'ok', pages: 1 } : failure(response, body);
      }
      const own = template('comments');
      if (!own) return { status: 'not-ready', detail: 'Open the comments on any LinkedIn post once so posthole can learn the comments request.' };
      const headers = { ...own.headers, 'csrf-token': csrf };
      let start = 0, done = 0;
      while (done < pages) {
        const url = linkedInCommentsUrl(own.url, job.target.socialDetailUrn, start);
        const { response, body } = await request(url, { headers }, job, 'comments');
        done++;
        if (!response.ok) return { ...failure(response, body), pages: done };
        let paging = null;
        try { paging = JSON.stringify(JSON.parse(body)).match(/"paging":\{[^}]*"count":(\d+)[^}]*"start":(\d+)[^}]*"total":(\d+)/); } catch { /* not JSON */ }
        const count = Number(paging?.[1] ?? 0), total = Number(paging?.[3] ?? 0);
        start += count || 10;
        if (!count || start >= total) break;
      }
      return { status: 'ok', pages: done };
    },

    async threads(job) {
      const own = Object.entries(live).find(([op]) => /BarcelonaPostPage/.test(op))?.[1]
        ?? Object.entries(stored).find(([op]) => /BarcelonaPostPage/.test(op))?.[1];
      if (!own) return { status: 'not-ready', detail: 'Open any Threads post once so posthole can learn the post request.' };
      const tokens = live._any?.body ? new URLSearchParams(live._any.body) : null;
      const body = threadsReplayBody(own.body, tokens, job.target.id);
      const headers = { ...own.headers, ...(live._any?.headers ?? {}) };
      delete headers['content-length'];
      const { response, body: text } = await request(own.url, { method: 'POST', headers, body }, job, 'post-page');
      return response.ok ? { status: 'ok', pages: 1 } : failure(response, text);
    },
  };

  document.addEventListener('posthole:expand', async event => {
    if (!current()) return;
    let job;
    try { job = JSON.parse(event.detail); } catch { return; }
    let result;
    try { result = await executors[platform]?.(job, job.options ?? { pages: 5 }) ?? { status: 'unsupported' }; } catch (error) { result = { status: 'error', detail: String(error?.message ?? error) }; }
    document.dispatchEvent(new CustomEvent('posthole:expand-done', { detail: JSON.stringify({ key: job.key, ...result }) }));
  });
})();
