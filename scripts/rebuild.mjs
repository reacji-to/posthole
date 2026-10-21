// Rebuilds post records from the raw archive: every saved API response and page
// is parsed again and written to an output folder, exactly as the extension would.
//   node scripts/rebuild.mjs <save folder> [output folder] [--platform x]
// Without an output folder it writes back into the save folder (refreshing post.json).
// Media is not downloaded again; existing files are linked when they are already there.
import fs from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { parseHTML } from 'linkedom';
import { EMBEDDED, parseDocument, parsePayload } from '../src/parsers/index.js';
import { responseMatches } from '../src/match.js';
import { ops, resolveRoot } from '../host/posthole-host.mjs';

const args = process.argv.slice(2);
const only = args.includes('--platform') ? args.splice(args.indexOf('--platform'), 2)[1] : null;
const [source, output] = args;
if (!source) {
  console.error('Usage: node scripts/rebuild.mjs <save folder> [output folder] [--platform x]');
  process.exit(1);
}
const root = resolveRoot(source);
const out = resolveRoot(output ?? source);
const rawRoot = path.join(root, 'raw');

function itemsFrom(platform, record) {
  if (record.encoding === 'base64' && platform !== 'linkedin') return [];
  const isHtml = /html/.test(record.contentType ?? '');
  if (isHtml) {
    const { document } = parseHTML(record.body);
    if (platform === 'hackernews') return parseDocument(platform, document);
    if (!EMBEDDED[platform]) return [];
    return [...document.querySelectorAll(EMBEDDED[platform])].flatMap(el => parsePayload(platform, { body: el.textContent }));
  }
  if (!record.expand && !responseMatches(platform, record.url)) return [];
  return parsePayload(platform, record);
}

const counts = {};
for (const platform of fs.existsSync(rawRoot) ? fs.readdirSync(rawRoot) : []) {
  if (only && platform !== only) continue;
  for (const day of fs.readdirSync(path.join(rawRoot, platform)).sort()) {
    for (const name of fs.readdirSync(path.join(rawRoot, platform, day)).sort()) {
      const record = JSON.parse(gunzipSync(fs.readFileSync(path.join(rawRoot, platform, day, name))));
      let items;
      try { items = itemsFrom(platform, record); } catch (error) { console.error(`${name}: ${error.message}`); continue; }
      if (!items.length) continue;
      const posts = items.map(i => ({
        dir: i.dir, record: i.record, source: i.source,
        captured: { at: record.captured_at, page: record.page, endpoint: record.expand ? 'thread' : 'rebuild', reposted_by: i.context?.reposted_by ?? null, thread_of: record.expand?.key ?? null },
        assets: i.assets.map(({ url, ref, base, kind }) => ({ url, ref, base, kind })),
      }));
      await ops.save({ root: out, day, posts });
      counts[platform] = (counts[platform] ?? 0) + posts.length;
    }
  }
}
console.log(Object.keys(counts).length ? Object.entries(counts).map(([p, n]) => `${p}: ${n} posts`).join('\n') : `No raw archive found under ${rawRoot}`);
