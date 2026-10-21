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
