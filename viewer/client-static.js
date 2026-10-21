import { initCardInteractions } from './card-interactions.js';
// Static site: cards live in chunk files (chunks.json lists them, oldest first).
// Loads them as you scroll, either in the order you saw them or newest first.
const feed = document.querySelector('.feed');
const orderButton = document.querySelector('[data-order]');
let newestFirst = new URLSearchParams(location.search).get('order') === 'recent';
let chunks = [];
let next = 0;

// Newest first: whole sessions reverse, and the posts inside each session too,
// keeping each session's divider at its head.
function reversed(html) {
  const holder = document.createElement('div');
  holder.innerHTML = html;
  const groups = [];
  for (const node of [...holder.children]) {
    if (node.classList.contains('divider') || !groups.length) groups.push({ head: node.classList.contains('divider') ? node : null, cards: [] });
    if (!node.classList.contains('divider')) groups.at(-1).cards.push(node);
  }
  const fragment = document.createDocumentFragment();
  for (const group of groups.reverse()) {
    if (group.head) fragment.append(group.head);
    fragment.append(...group.cards.reverse());
  }
  return fragment;
}

// The site is built on a server in UTC, so times are shown in the reader's timezone and
// ages ("3h") are computed now rather than at build time.
const formats = {
  clock: new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }),
  daytime: new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }),
  date: new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' }),
};
function ago(date) {
  const s = (Date.now() - date) / 1000;
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)}d`;
  return formats.date.format(date);
}
function localTimes(root = document) {
  for (const el of root.querySelectorAll('time[data-format]')) {
    const date = new Date(el.getAttribute('datetime'));
    if (Number.isNaN(date.getTime())) continue;
    el.textContent = el.dataset.format === 'ago' ? ago(date) : formats[el.dataset.format].format(date);
  }
}
localTimes();

const sentinel = document.createElement('div');
sentinel.className = 'more';
sentinel.textContent = 'Loading…';

async function loadNext() {
  if (next >= chunks.length) { sentinel.className = 'end'; sentinel.textContent = "That's everything."; return; }
  const chunk = newestFirst ? chunks[chunks.length - 1 - next] : chunks[next];
  next++;
  const html = await (await fetch(chunk.file, { cache: 'no-cache' })).text();
  if (newestFirst) feed.insertBefore(reversed(html), sentinel);
  else sentinel.insertAdjacentHTML('beforebegin', html);
  localTimes(feed);
}

const observer = new IntersectionObserver(async entries => {
  if (!entries.some(e => e.isIntersecting)) return;
  observer.unobserve(sentinel);
  await loadNext();
  if (next < chunks.length) observer.observe(sentinel); else await loadNext();
}, { rootMargin: '1500px' });

async function start() {
  ({ chunks } = await (await fetch('chunks.json', { cache: 'no-cache' })).json());
  feed.replaceChildren(sentinel);
  next = 0;
  sentinel.className = 'more';
  sentinel.textContent = 'Loading…';
  orderButton.textContent = newestFirst ? 'Newest first' : 'In order seen';
  observer.observe(sentinel);
}

orderButton.addEventListener('click', () => {
  newestFirst = !newestFirst;
  history.replaceState(null, '', newestFirst ? '?order=recent' : location.pathname);
  start();
});

initCardInteractions(feed);

start();
