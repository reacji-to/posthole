import { initReadControls } from './read-controls.js';
import { initCardInteractions } from './card-interactions.js';
import { initInterfaceControls } from './interface-controls.js';
const feed = document.querySelector('.feed');
const deck = ['ipod', 'ipod-color', 'tinder', 'netflix'].includes(document.body.dataset.view);
let pending;
async function loadNext() {
  if (pending) return pending;
  const marker = feed.querySelector('.more[data-next]');
  if (!marker) return false;
  loadMore.unobserve(marker);
  pending = (async () => {
    try {
      const response = await fetch(marker.dataset.next);
      if (!response.ok) throw new Error('Request failed');
      marker.insertAdjacentHTML('afterend', await response.text());
      marker.remove();
      watch();
      return true;
    } catch {
      marker.replaceChildren();
      const retry = document.createElement('button');
      retry.type = 'button'; retry.textContent = 'Couldn’t load posts · retry';
      retry.addEventListener('click', () => loadNext());
      marker.append(retry);
      return false;
    } finally { pending = null; }
  })();
  return pending;
}
const loadMore = new IntersectionObserver(entries => {
  if (entries.some(entry => entry.isIntersecting)) loadNext();
}, { rootMargin: '1200px' });
function watch() { if (!deck) feed.querySelectorAll('.more[data-next]').forEach(el => loadMore.observe(el)); }
watch();
initCardInteractions(feed);
initInterfaceControls(feed, loadNext);
if (document.body.dataset.view === 'netflix') {
  const { initNetflix } = await import('./netflix.js');
  initNetflix(feed, loadNext);
}

initReadControls();
