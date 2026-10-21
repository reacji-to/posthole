/** @jsxImportSource hono/jsx */
// Card assembly shared by the local server and the static site builder.
import { reacjiKey } from '../src/schema.js';
import { keyOf, type Sighting, type Store } from './store';
import { Card, Divider, type CardData, type ReplyNode } from './views';
import type { Interface } from './interfaces';

export const SESSION_GAP = 20 * 60 * 1000;

export async function cardData(store: Store, key: string, sighting?: Sighting): Promise<CardData | null> {
  const post = await store.post(key);
  if (!post) return null;
  const quotedKey = post.quote_of ? reacjiKey(post.quote_of.platform, post.quote_of.id, post.quote_of.url) : null;
  const quotedPost = quotedKey ? await store.post(quotedKey) : null;
  return {
    key, post, sighting, folder: store.folderOf(key), saved: store.replyCount(key),
    quoted: quotedPost && quotedKey ? { post: quotedPost, folder: store.folderOf(quotedKey) } : null,
  };
}

// Cards for a run of sightings, with a divider wherever a new browsing session starts.
export async function cardsFor(store: Store, list: Sighting[], previousAt: string | null, repliesHref?: (key: string) => string, view: Interface = 'original') {
  const datas = await Promise.all(list.map(s => cardData(store, keyOf(s), s)));
  const out: any[] = [];
  let last = previousAt;
  list.forEach((s, i) => {
    if (!last || Math.abs(Date.parse(s.at) - Date.parse(last)) > SESSION_GAP) out.push(<Divider sighting={s} />);
    last = s.at;
    const data = datas[i];
    if (data) out.push(<Card {...data} archiveKey={data.key} repliesHref={repliesHref?.(data.key)} view={view} />);
  });
  return out;
}

// Saved replies under a post, nested by who replied to whom, oldest first.
export async function replyTree(store: Store, rootKey: string): Promise<ReplyNode[]> {
  const rootPost = await store.post(rootKey);
  const nodes = new Map<string, ReplyNode>();
  for (const key of store.threadKeys(rootKey)) {
    const data = await cardData(store, key);
    if (data) nodes.set(key, { data, children: [] });
  }
  const byNativeId = new Map([...nodes.values()].map(n => [n.data.post.id, n]));
  const top: ReplyNode[] = [];
  for (const node of nodes.values()) {
    const parent = node.data.post.reply_to?.id;
    if (parent && parent === rootPost?.id) top.push(node);
    else if (parent && byNativeId.has(parent)) byNativeId.get(parent)!.children.push(node);
    // Anything else (the conversation above this post) is context, not a reply to it.
  }
  const time = (n: ReplyNode) => Date.parse(n.data.post.created_at ?? '') || 0;
  const sort = (list: ReplyNode[]) => { list.sort((a, b) => time(a) - time(b)); list.forEach(n => sort(n.children)); };
  sort(top);
  return top;
}
