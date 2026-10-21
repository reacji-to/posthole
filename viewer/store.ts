// Reads what the posthole extension saved: the daily index (one line per
// sighting, in order) and each post's post.json. Refreshes itself when the
// index grows, so a page reload shows what you just scrolled past.
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { presentationOf } from '../src/parsers/x.js';

export type Sighting = {
  at: string;
  key?: string;
  platform: string;
  id: string;
  kind: string;
  url: string;
  author: string | null;
  title?: string | null;
  text?: string;
  path: string;
  page: string | null;
  reposted_by?: string;
  thread_of?: string;
};

export type Media = {
  type: 'image' | 'video' | 'gif' | 'document';
  url: string | null;
  file: string | null;
  alt: string | null;
  width: number | null;
  height: number | null;
  duration_ms: number | null;
  thumbnail_url: string | null;
  thumbnail_file: string | null;
};

export type Post = {
  key?: string;
  platform: string;
  id: string;
  url: string;
  kind: string;
  author: { id: string | null; handle: string | null; name: string | null; url: string | null; description: string | null; verified: boolean | null; avatar_url: string | null; avatar_file: string | null };
  created_at: string | null;
  title: string | null;
  text: string;
  links: { url: string; text: string | null }[];
  media: Media[];
  link_card: { url: string | null; title: string | null; description: string | null; domain: string | null; image_url: string | null; image_file: string | null } | null;
  reply_to: { id: string | null; url: string | null; author_handle?: string | null } | null;
  quote_of: { platform: string; id: string; url: string } | null;
  metrics: Record<string, number | null>;
  extra: Record<string, unknown>;
  captured: { first_at: string; last_at: string; times_seen: number; first_page: string | null; thread_of: string | null };
};

// Posts are identified by their reacji.to key ("x:…", "linkedin:…", "web:<sha256>").
// Early captures predate the key field; for X their key is still "x:<id>".
export const keyOf = (s: { key?: string | null; platform: string; id: string }) => s.key ?? `${s.platform}:${s.id}`;

export function createStore(root: string) {
  let signature = '';
  let seen: Sighting[] = [];
  let lines: Sighting[] = [];
  const paths = new Map<string, string>();
  const threads = new Map<string, string[]>();
  // When each thread last gained a reply, so the static site regenerates only changed threads.
  const threadUpdated = new Map<string, string>();

  async function refresh() {
    const dir = path.join(root, 'index');
    const files = (await readdir(dir).catch(() => [] as string[])).filter(f => f.endsWith('.jsonl')).sort();
    const stats = await Promise.all(files.map(f => stat(path.join(dir, f))));
    const next = files.map((f, i) => `${f}:${stats[i].size}`).join('|');
    if (next === signature) return;
    signature = next;
    const firsts = new Map<string, Sighting>();
    lines = [];
    paths.clear();
    threads.clear();
    threadUpdated.clear();
    for (const file of files) {
      const text = await Bun.file(path.join(dir, file)).text();
      for (const line of text.split('\n')) {
        if (!line) continue;
        let s: Sighting;
        try { s = JSON.parse(line); } catch { continue; }
        const key = keyOf(s);
        lines.push(s);
        paths.set(key, s.path);
        if (s.thread_of) {
          if ((threadUpdated.get(s.thread_of) ?? '') < s.at) threadUpdated.set(s.thread_of, s.at);
          const list = threads.get(s.thread_of) ?? [];
          if (!list.includes(key)) list.push(key);
          threads.set(s.thread_of, list);
        } else if (!firsts.has(key)) {
          // A post you saw: keep its first sighting, which fixes its place in the order.
          firsts.set(key, s);
        }
      }
    }
    seen = [...firsts.values()];
  }

  async function post(key: string): Promise<Post | null> {
    const rel = paths.get(key);
    if (!rel) return null;
    try {
      const record: Post = await Bun.file(path.join(root, rel)).json();
      // Older archives already have the unmodified source. Recover presentation
      // without rewriting their records or losing downloaded media paths.
      if (record.platform === 'x' && !record.extra.display) {
        try {
          const source = await Bun.file(path.join(root, path.dirname(rel), 'source.json')).json();
          if (source.legacy) record.extra.display = presentationOf(source);
        } catch { /* Source was optional in early captures. */ }
      }
      return record;
    } catch { return null; }
  }

  // Every post fetched under this one's thread, including replies to replies.
  function threadKeys(rootKey: string) {
    const out: string[] = [];
    const queue = [rootKey];
    const visited = new Set(queue);
    while (queue.length) {
      for (const key of threads.get(queue.shift()!) ?? []) {
        if (visited.has(key)) continue;
        visited.add(key);
        out.push(key);
        queue.push(key);
      }
    }
    return out;
  }

  return {
    root,
    refresh,
    post,
    folderOf: (key: string) => path.posix.dirname(paths.get(key) ?? ''),
    sightings: () => seen,
    allLines: () => lines,
    threadKeys,
    replyCount: (key: string) => threadKeys(key).length,
    // Threads (by root key) that gained replies after `since`, including replies to replies.
    threadsChangedSince: (since: string) => {
      const changed = new Set<string>();
      for (const [rootKey, at] of threadUpdated) if (at > since) changed.add(rootKey);
      // A new reply deep in a thread changes every ancestor's rendered tree.
      const parentOf = new Map<string, string>();
      for (const [rootKey, list] of threads) for (const k of list) if (!parentOf.has(k)) parentOf.set(k, rootKey);
      for (const k of [...changed]) { let p = parentOf.get(k); while (p && !changed.has(p)) { changed.add(p); p = parentOf.get(p); } }
      return [...changed];
    },
    platforms: () => {
      const counts: Record<string, number> = {};
      for (const s of seen) counts[s.platform] = (counts[s.platform] ?? 0) + 1;
      return counts;
    },
  };
}

export type Store = ReturnType<typeof createStore>;
