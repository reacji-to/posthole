import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { build } from 'esbuild';

const {outputFiles} = await build({entryPoints: [new URL('../src/hook.js', import.meta.url).pathname], bundle: true,
  write: false, format: 'iife', define: {__BUILD__: '"test"'}});

function tab(templates = {}) {
  const requests = [];
  const document = Object.assign(new EventTarget(), {cookie: 'ct0=current-csrf', scripts: []});
  class XMLHttpRequest { open() {} send() {} setRequestHeader() {} }
  const window = {fetch: async (url, init) => {
    requests.push({url, init});
    return new Response('{}', {headers: {'content-type': 'application/json', 'x-rate-limit-remaining': '100'}});
  }};
  vm.runInNewContext(outputFiles[0].text, {window, document, XMLHttpRequest, CustomEvent, Headers, Request,
    URL, URLSearchParams, setTimeout, location: {hostname: 'x.com', origin: 'https://x.com', href: 'https://x.com/home'}});
  document.dispatchEvent(new CustomEvent('posthole:config', {detail: JSON.stringify({archiveRaw: false, templates})}));
  return {requests, expand: () => new Promise(resolve => {
    document.addEventListener('posthole:expand-done', event => resolve(JSON.parse(event.detail)), {once: true});
    document.dispatchEvent(new CustomEvent('posthole:expand', {detail: JSON.stringify({key: 'x:123456789', target: {id: '123456789'}, options: {pages: 1}})}));
  })};
}

test('X reply fetching can use a saved template before a tab makes a live API request', async () => {
  const t = tab({TweetDetail: {url: 'https://x.com/i/api/graphql/QID/TweetDetail?features=%7B%7D',
    headers: {authorization: 'test-bearer', 'content-length': '100', 'x-csrf-token': 'stale-csrf'}}});
  assert.equal((await t.expand()).status, 'ok');
  assert.equal(t.requests.length, 1);
  const {url, init} = t.requests[0];
  assert.equal(JSON.parse(new URL(url).searchParams.get('variables')).focalTweetId, '123456789');
  assert.equal(init.headers.authorization, 'test-bearer');
  assert.equal(init.headers['x-csrf-token'], 'current-csrf');
  assert.equal(init.headers['content-length'], undefined);
});

test('X reply fetching waits when neither a saved nor a live authorized request is available', async () => {
  const t = tab();
  assert.equal((await t.expand()).status, 'not-ready');
  assert.equal(t.requests.length, 0);
});
