// Local presentation preferences and one-post-at-a-time navigation. Keeps never
// mutate the archive or interact with the source social network.
export function initInterfaceControls(feed, loadNext) {
  document.documentElement.classList.add('js');
  const picker = document.querySelector('#interface-select');
  const view = document.body.dataset.view;
  const allowed = [...picker.options].map(option => option.value);
  try {
    const remembered = localStorage.getItem('posthole.interface');
    if (!new URLSearchParams(location.search).has('view') && allowed.includes(remembered) && remembered !== view) {
      const url = new URL(location.href); url.searchParams.set('view', remembered); location.replace(url); return;
    }
    localStorage.setItem('posthole.interface', view);
  } catch { /* The viewer also works with browser storage disabled. */ }
  picker.addEventListener('change', () => picker.form.requestSubmit());
  if (!['ipod', 'ipod-color', 'tinder'].includes(view)) return;
  const player = view !== 'tinder';
  const status = document.querySelector('.deck-status');
  const position = document.querySelector('[data-position]');
  const menu = document.querySelector('.ipod-list');
  const keptButton = document.querySelector('.kept-filter');
  const empty = document.createElement('p');
  empty.className = 'deck-empty'; empty.hidden = true; feed.append(empty);
  let kept = new Set();
  try { const data = JSON.parse(localStorage.getItem('posthole.kept') || '[]'); if (Array.isArray(data)) kept = new Set(data.filter(key => typeof key === 'string')); } catch {}
  let onlyKept = false, index = 0, busy = false, menuOpen = false;
  const all = () => [...feed.children].filter(el => el.matches('.post-entry'));
  const cards = () => all().filter(el => !onlyKept || kept.has(el.dataset.key));
  const current = () => cards()[index];
  const say = message => { status.textContent = message; };
  function persist() {
    try { localStorage.setItem('posthole.kept', JSON.stringify([...kept])); return true; }
    catch { say('Browser storage is unavailable. Keeps will last until this page closes.'); return false; }
  }
  function show() {
    const list = cards();
    index = Math.max(0, Math.min(index, list.length - 1));
    for (const el of all()) {
      const active = el === list[index];
      el.classList.toggle('is-active', active);
      el.classList.toggle('is-kept', kept.has(el.dataset.key));
      if (!active) el.querySelectorAll('video').forEach(video => video.pause());
    }
    const more = !!feed.querySelector('.more[data-next]') && (!onlyKept || list.length < kept.size);
    position.textContent = list.length ? `${index + 1} / ${list.length}${more ? '+' : ''}` : '0 posts';
    empty.hidden = list.length > 0 || !!feed.querySelector('.empty');
    empty.textContent = onlyKept ? 'No kept posts match these filters. Keep a post with the heart, or return to all posts.' : 'No saved posts here yet.';
    document.querySelectorAll('[data-deck="previous"]').forEach(b => { b.disabled = index === 0 || busy; });
    document.querySelectorAll('[data-deck="next"]').forEach(b => { b.disabled = busy || (!more && index >= list.length - 1); });
    document.querySelectorAll('[data-deck="keep"],[data-deck="select"],[data-deck="play"]').forEach(b => { b.disabled = busy || !list.length; });
    const keep = document.querySelector('[data-deck="keep"]');
    if (keep) { const saved = kept.has(current()?.dataset.key); keep.setAttribute('aria-label', saved ? 'Unkeep post' : 'Keep post'); keep.setAttribute('aria-pressed', String(saved)); }
    const count = document.querySelector('[data-kept-count]'); if (count) count.textContent = kept.size;
    if (menu) {
      menu.replaceChildren(...list.map((el, i) => {
        const b = document.createElement('button'); b.textContent = el.dataset.title;
        b.setAttribute('aria-current', String(i === index));
        b.addEventListener('click', () => { index = i; setMenu(false); show(); feed.scrollTop = 0; });
        return b;
      }));
      if (menuOpen) menu.querySelector('[aria-current="true"]')?.scrollIntoView({block:'nearest'});
    }
  }
  function setMenu(open) { if (!menu) return; menuOpen = open; menu.hidden = !open; document.querySelector('[data-deck="menu"]').setAttribute('aria-expanded', String(open)); }
  async function ensure(target) {
    if (onlyKept && cards().length >= kept.size) return true;
    while (cards().length <= target && feed.querySelector('.more[data-next]')) {
      const loaded = await loadNext();
      if (!loaded) return false;
    }
    return true;
  }
  async function navigate(delta) {
    if (busy) return;
    busy = true; show();
    const target = Math.max(0, index + delta);
    try {
      if (await ensure(target)) {
        index = Math.min(target, cards().length - 1); feed.scrollTop = 0;
        if (target >= cards().length) say('You’ve reached the end. Go back or change your filters.');
        else say('');
      } else say('Couldn’t load more posts. Try Next again.');
    } finally { busy = false; show(); }
  }
  async function keepCurrent() {
    if (busy || !current()) return;
    const key = current().dataset.key;
    const wasKept = kept.has(key);
    wasKept ? kept.delete(key) : kept.add(key);
    const stored = persist();
    if (onlyKept && wasKept) { busy = true; try { await ensure(index); } finally { busy = false; show(); } }
    else if (!wasKept) await navigate(1);
    else show();
    if (stored) say(wasKept ? 'Removed from kept posts. The archive is unchanged.' : 'Kept in this browser.');
  }
  document.querySelectorAll('[data-deck]').forEach(button => button.addEventListener('click', () => {
    const action = button.dataset.deck;
    if (action === 'next') navigate(1);
    if (action === 'previous') navigate(-1);
    if (action === 'keep') keepCurrent();
    if (action === 'menu') { setMenu(!menuOpen); show(); }
    if (action === 'select') { setMenu(false); feed.focus(); }
    if (action === 'play') {
      const video = current()?.querySelector('video');
      if (video) { if (video.paused) video.play().catch(() => say('This saved video could not be played.')); else video.pause(); }
      else { feed.scrollBy({top:180,behavior:'auto'}); say('Scroll to read this post; it has no video.'); }
    }
  }));
  keptButton?.addEventListener('click', async () => {
    if (busy) return;
    onlyKept = !onlyKept; index = 0; busy = true;
    keptButton.setAttribute('aria-pressed', String(onlyKept)); show();
    try { if (onlyKept && kept.size) { say('Finding your kept posts…'); if (!(await ensure(0))) { say('Couldn’t load kept posts. Turn the filter off and on to retry.'); return; } } say(''); }
    finally { busy = false; show(); feed.scrollTop = 0; }
  });
  document.addEventListener('keydown', event => {
    if (event.target.closest('input,select,textarea,button:not([data-deck]),a,summary,video,[contenteditable]') || event.altKey || event.metaKey || event.ctrlKey) return;
    if (event.key === 'ArrowRight' || (menuOpen && event.key === 'ArrowDown')) { event.preventDefault(); navigate(1); }
    if (event.key === 'ArrowLeft' || (menuOpen && event.key === 'ArrowUp')) { event.preventDefault(); navigate(-1); }
    if (event.key === 'Escape') setMenu(false);
    if (event.key === 'Enter' && menuOpen) { event.preventDefault(); setMenu(false); feed.focus(); }
  });
  if (player) {
    let lastWheel = 0;
    document.querySelector('.click-wheel').addEventListener('wheel', event => {
      event.preventDefault();
      if (Date.now() - lastWheel < 180 || Math.abs(event.deltaY) < 3) return;
      lastWheel = Date.now(); navigate(event.deltaY > 0 ? 1 : -1);
    }, {passive:false});
  } else {
    let start;
    feed.addEventListener('pointerdown', event => {
      if (event.target.closest('a,button,video,summary') || event.button !== 0) return;
      start = {x:event.clientX,y:event.clientY,id:event.pointerId};
      feed.setPointerCapture(event.pointerId);
    });
    feed.addEventListener('pointerup', event => {
      if (!start || event.pointerId !== start.id) return;
      const dx = event.clientX - start.x, dy = event.clientY - start.y; start = null;
      if (Math.abs(dx) < 85 || Math.abs(dx) < Math.abs(dy) * 1.5 || window.getSelection()?.toString()) return;
      if (dx > 0) keepCurrent(); else navigate(1);
    });
    feed.addEventListener('pointercancel', () => { start = null; });
  }
  show();
}
