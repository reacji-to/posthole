import { initCardInteractions } from './card-interactions.js';
// Infinite scroll and reply threads. Cards arrive as server-rendered HTML.
const feed = document.querySelector('.feed');

const loadMore = new IntersectionObserver(async entries => {
  for (const entry of entries) {
    if (!entry.isIntersecting) continue;
    const marker = entry.target;
    loadMore.unobserve(marker);
    const html = await (await fetch(marker.dataset.next)).text();
    marker.insertAdjacentHTML('afterend', html);
    marker.remove();
    watch();
  }
}, { rootMargin: '1200px' });

const watch = () => document.querySelectorAll('.more[data-next]').forEach(el => loadMore.observe(el));
watch();

initCardInteractions(feed);
