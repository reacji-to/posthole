// Loads the built extension into Chromium with the real native helper and
// browses live, logged-out pages. Run with: npm run test:e2e
import { test, expect, chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Saved records for one platform, each with the folder it lives in (folders follow reacji.to keys).
const posts = (root, platform) => ['x', 'linkedin', 'web'].flatMap(top => {
  const dir = path.join(root, top);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(n => !n.startsWith('_') && fs.existsSync(path.join(dir, n, 'post.json')))
    .map(n => ({ ...JSON.parse(fs.readFileSync(path.join(dir, n, 'post.json'), 'utf8')), folder: path.join(dir, n) }));
}).filter(p => p.platform === platform);

let context, worker, root, profile;

test.beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'posthole-root-'));
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'posthole-profile-'));
  execFileSync(process.execPath, [path.join(repo, 'scripts/install-host.mjs'), '--dir', path.join(profile, 'NativeMessagingHosts')]);
  const dist = path.join(repo, 'dist');
  context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`],
  });
  worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  await worker.evaluate(r => chrome.storage.local.set({ settings: { root: r } }), root);
});

test.afterAll(async () => {
  await context?.close();
  fs.rmSync(profile, { recursive: true, force: true });
  if (!process.env.KEEP) fs.rmSync(root, { recursive: true, force: true });
  else console.log(`Kept saved posts in ${root}`);
});

test('auto-scroll collects newly loaded posts after the popup closes and can be stopped from another tab', async () => {
  const id = new URL(worker.url()).host;
  const popup = await context.newPage();
  const feed = await context.newPage();
  const fixture = JSON.parse(fs.readFileSync(path.join(repo, 'tests/fixtures/bluesky-feed.json'), 'utf8')).feed[0].post;
  const previous = await worker.evaluate(async () => (await chrome.storage.local.get('settings')).settings);
  await worker.evaluate(settings => chrome.storage.local.set({settings: {
    ...settings, fetchThreads: false, images: false, videos: false, avatars: false, gitSync: false,
  }}), previous);
  await feed.route('https://bsky.app/xrpc/app.bsky.feed.getTimeline?cursor=*', async route => {
    const cursor = new URL(route.request().url()).searchParams.get('cursor');
    const post = {...fixture,
      uri: `at://${fixture.author.did}/app.bsky.feed.post/autoscroll${cursor}`,
      record: {...fixture.record, text: `Posthole auto-scroll fixture ${cursor}`},
      embed: undefined, replyCount: 0,
    };
    await route.fulfill({json: {feed: [{post}]}});
  });
  await feed.route('https://bsky.app/posthole-auto-scroll-test', route => route.fulfill({
    contentType: 'text/html', body: `<!doctype html><title>Auto-scroll test feed</title>
      <main style="height:20000px">A feed that loads another post on each scroll.</main>
      <script>
        let cursor = 0;
        addEventListener('scroll', () => fetch('/xrpc/app.bsky.feed.getTimeline?cursor=' + ++cursor));
      </script>`,
  }));
  try {
    await feed.goto('https://bsky.app/posthole-auto-scroll-test');
    await feed.bringToFront();
    await popup.goto(`chrome-extension://${id}/popup.html`);
    await expect(popup.locator('#scroll-start')).toBeEnabled();
    await popup.locator('#scroll-minutes').fill('1');
    await popup.locator('#scroll-start').click();
    await expect(popup.locator('#scroll-stop')).toBeVisible();
    await expect.poll(() => posts(root, 'bluesky').some(p => p.text === 'Posthole auto-scroll fixture 1'), {timeout: 10000}).toBe(true);
    await popup.close();
    const other = await context.newPage();
    await other.goto('about:blank');
    await other.bringToFront();
    await expect.poll(() => posts(root, 'bluesky').some(p => p.text === 'Posthole auto-scroll fixture 2'), {timeout: 40000}).toBe(true);
    expect(await feed.evaluate(() => scrollY)).toBeGreaterThan(0);
    const reopened = await context.newPage();
    await reopened.goto(`chrome-extension://${id}/popup.html`);
    const run = await reopened.evaluate(async () => (await chrome.runtime.sendMessage({type: 'status'})).autoScroll);
    // Headless Chromium reports every document as visible; use the browser's
    // actual active-tab state to verify we kept scrolling the inactive feed.
    expect(await reopened.evaluate(async tabId => (await chrome.tabs.get(tabId)).active, run.tabId)).toBe(false);
    await expect(reopened.locator('#scroll-stop')).toBeVisible();
    await reopened.locator('#scroll-stop').click();
    await expect(reopened.locator('#scroll-status')).toHaveText('Stopped.');
    const status = await reopened.evaluate(() => chrome.runtime.sendMessage({type: 'status'}));
    expect(status.autoScroll.running).toBe(false);
    await reopened.close();
    await other.close();
  } finally {
    const cleanup = await context.newPage();
    await cleanup.goto(`chrome-extension://${id}/popup.html`);
    await cleanup.evaluate(() => chrome.runtime.sendMessage({type: 'autoScrollStop'}));
    await worker.evaluate(settings => chrome.storage.local.set({settings}), previous);
    await cleanup.close();
    if (!popup.isClosed()) await popup.close();
    await feed.close();
  }
});

test('Hacker News stories are saved, their comment threads fetched without opening them, and pages archived raw', async () => {
  const page = await context.newPage();
  await page.goto('https://news.ycombinator.com/');
  await expect.poll(() => posts(root, 'hackernews').filter(p => p.kind === 'story').length, { timeout: 20000 }).toBeGreaterThanOrEqual(30);
  const story = posts(root, 'hackernews').find(p => p.kind === 'story');
  expect(story.schema).toBe('posthole.post/1');
  expect(story.captured.first_page).toBe('https://news.ycombinator.com/');
  // Comment threads arrive from background fetches while we stay on the front page.
  await expect.poll(() => posts(root, 'hackernews').filter(p => p.kind === 'comment' && p.captured.endpoint === 'thread:item').length, { timeout: 30000 }).toBeGreaterThan(20);
  const comment = posts(root, 'hackernews').find(p => p.captured.endpoint === 'thread:item' && p.kind === 'comment');
  expect(comment.captured.thread_of).toMatch(/^web:[a-f\d]{64}$/);
  expect(page.url()).toBe('https://news.ycombinator.com/');
  const raw = path.join(root, 'raw', 'hackernews');
  await expect.poll(() => fs.existsSync(raw) && fs.readdirSync(path.join(raw, fs.readdirSync(raw)[0])).length, { timeout: 10000 }).toBeGreaterThan(1);
  const day = fs.readdirSync(path.join(root, 'index'))[0];
  expect(fs.readFileSync(path.join(root, 'index', day), 'utf8').split('\n').length).toBeGreaterThan(30);
});

test('Bluesky posts, images and whole reply threads are saved while scrolling', async () => {
  const page = await context.newPage();
  await page.goto('https://bsky.app/');
  for (let i = 0; i < 6; i++) { await page.mouse.wheel(0, 2500); await page.waitForTimeout(800); }
  await expect.poll(() => posts(root, 'bluesky').length, { timeout: 30000 }).toBeGreaterThan(10);
  await expect.poll(() => posts(root, 'bluesky').some(p => p.media.some(m => m.type === 'image' && m.file)), { timeout: 60000 }).toBe(true);
  const withImage = posts(root, 'bluesky').find(p => p.media.some(m => m.file));
  expect(fs.statSync(path.join(withImage.folder, withImage.media.find(m => m.file).file)).size).toBeGreaterThan(1000);
  expect(fs.existsSync(path.join(root, 'web', '_avatars'))).toBe(true);
  await expect.poll(() => posts(root, 'bluesky').filter(p => p.captured.endpoint === 'thread:getPostThread' && p.kind === 'reply').length, { timeout: 30000 }).toBeGreaterThan(10);
  expect(fs.readdirSync(path.join(root, 'raw', 'bluesky')).length).toBeGreaterThan(0);
});

test('popup reports the session', async () => {
  const id = new URL(worker.url()).host;
  const page = await context.newPage();
  await page.goto(`chrome-extension://${id}/popup.html`);
  await expect(page.locator('#where')).toContainText(root);
  await expect(page.locator('#counts li').first()).toBeVisible();
  await expect(page.locator('#problem')).toBeHidden();
  await expect(page.locator('#assets')).toContainText('posts this session');
  await expect(page.locator('#assets')).toContainText('threads fetched');
});
