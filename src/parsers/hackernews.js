import { iso, item, makePost, num } from '../schema.js';

// Hacker News is server-rendered: the page HTML is the source.
const BASE = 'https://news.ycombinator.com/';
const abs = href => { try { return new URL(href, BASE).href; } catch { return null; } };
const itemUrl = id => `${BASE}item?id=${id}`;
// <span class="age" title="2026-10-20T20:58:34 1792529914"> — the trailing number is unix seconds.
const ageOf = el => {
  const title = el?.getAttribute('title') ?? '';
  const unix = title.match(/\s(\d{9,})$/)?.[1];
  return unix ? iso(Number(unix)) : iso(title.split(' ')[0] ? `${title.split(' ')[0]}Z` : null);
};
const author = name => (name ? { id: name, handle: name, name, url: `${BASE}user?id=${name}` } : {});

// Text with paragraph breaks kept, links listed separately.
function richText(el) {
  if (!el) return { text: '', links: [] };
  const clone = el.cloneNode(true);
  clone.querySelectorAll('.reply, .comment-tree-actions').forEach(n => n.remove());
  const links = [...clone.querySelectorAll('a[href]')].map(a => ({ url: abs(a.getAttribute('href')), text: a.textContent })).filter(l => l.url);
  for (const p of clone.querySelectorAll('p')) p.insertAdjacentText('beforebegin', '\n\n');
  return { text: clone.textContent.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim(), links };
}

function story(row) {
  const id = row.getAttribute('id');
  const sub = row.nextElementSibling;
  const link = row.querySelector('.titleline > a');
  if (!id || !link) return null;
  const href = abs(link.getAttribute('href'));
  const external = href && !href.startsWith(`${BASE}item?id=`) ? href : null;
  const comments = [...(sub?.querySelectorAll('a[href^="item?id="]') ?? [])].map(a => a.textContent).find(t => /comment|discuss/.test(t));
  const user = sub?.querySelector('a.hnuser')?.textContent ?? null;
  const record = makePost('hackernews', {
    id,
    url: itemUrl(id),
    kind: 'story',
    author: author(user),
    created_at: ageOf(sub?.querySelector('.age')),
    title: link.textContent,
    link_card: external ? { url: external, title: link.textContent, domain: row.querySelector('.sitestr')?.textContent ?? undefined } : null,
    metrics: { score: num(sub?.querySelector('.score')?.textContent.match(/\d+/)?.[0]), replies: comments?.match(/\d+/) ? num(comments.match(/\d+/)[0]) : comments ? 0 : null },
    extra: { rank: num(row.querySelector('.rank')?.textContent.replace('.', '')) },
  });
  return { record, source: { html: row.outerHTML + (sub?.outerHTML ?? '') } };
}

export function parseHackerNewsDocument(doc, { comments = true } = {}) {
  const items = [];
  const fat = doc.querySelector('table.fatitem');
  for (const row of doc.querySelectorAll('tr.athing.submission, tr.athing:not(.comtr)')) {
    const result = story(row);
    if (!result) continue;
    // On an item page the story's own text (Ask HN, Show HN) sits under it.
    if (fat?.contains(row)) {
      const top = richText(fat.querySelector('.toptext'));
      result.record.text = top.text;
      result.record.links = top.links;
    }
    items.push(item(result.record, result.source));
  }
  if (!comments) return items;
  const rootId = fat?.querySelector('tr.athing')?.getAttribute('id') ?? null;
  const stack = [];
  for (const row of doc.querySelectorAll('tr.athing.comtr')) {
    const id = row.getAttribute('id');
    const depth = num(row.querySelector('td.ind')?.getAttribute('indent')) ?? 0;
    while (stack.length && stack.at(-1).depth >= depth) stack.pop();
    const parent = stack.at(-1)?.id ?? rootId;
    stack.push({ id, depth });
    const user = row.querySelector('.comhead a.hnuser')?.textContent;
    const body = row.querySelector('.commtext');
    if (!id || !user || !body) continue;
    const { text, links } = richText(body);
    const record = makePost('hackernews', {
      id,
      url: itemUrl(id),
      kind: 'comment',
      author: author(user),
      created_at: ageOf(row.querySelector('.age')),
      text, links,
      reply_to: parent ? { id: parent, url: itemUrl(parent) } : null,
      thread_root: rootId && rootId !== parent ? { id: rootId, url: itemUrl(rootId) } : null,
      extra: { depth },
    });
    items.push(item(record, { html: row.outerHTML }));
  }
  return items;
}
