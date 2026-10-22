// Reading in the archive is separate from capture history. Keep this preference
// in this browser, shared by every interface and tab on the same viewer origin.
export function initReadControls(root = document, storage) {
  const storageKey = 'posthole.read';
  const status = document.createElement('span');
  status.className = 'read-status'; status.setAttribute('role', 'status');
  document.querySelector('.interface-toolbar')?.append(status);
  let read = new Set();
  function load() {
    const values = JSON.parse(storage.getItem(storageKey) || '[]');
    if (!Array.isArray(values)) throw new Error('Invalid read history');
    return new Set(values.filter(value => typeof value === 'string'));
  }
  try { storage ??= window.localStorage; read = load(); } catch { status.textContent = 'Read history is unavailable. Changes may not be saved.'; }
  const keyFor = node => node.closest('[data-read-key]')?.dataset.readKey || node.closest('.post-entry[data-key]')?.dataset.key;
  function paint() {
    for (const entry of root.querySelectorAll('.post-entry[data-key]')) {
      const article = entry.querySelector(':scope > article');
      if (article) article.dataset.readKey = entry.dataset.key;
      entry.dataset.read = String(read.has(entry.dataset.key));
      const tools = entry.querySelector(':scope > .archive-tools') || article?.querySelector(':scope > .interface-bottom');
      if (!tools || tools.querySelector(':scope > .read-toggle')) continue;
      const button = document.createElement('button'); button.type = 'button';
      button.className = 'read-toggle'; button.dataset.readKey = entry.dataset.key;
      tools.prepend(button);
    }
    // Native cards with no archive metadata still need a place for the control.
    for (const entry of root.querySelectorAll('.post-entry[data-key]')) {
      if (!entry.querySelector(':scope > .card') || entry.querySelector(':scope > .archive-tools')) continue;
      const tools = document.createElement('div'); tools.className = 'archive-tools'; entry.append(tools);
      const button = document.createElement('button'); button.type = 'button';
      button.className = 'read-toggle'; button.dataset.readKey = entry.dataset.key; tools.append(button);
    }
    for (const button of root.querySelectorAll('.read-toggle')) {
      const isRead = read.has(button.dataset.readKey);
      const label = isRead ? 'Read' : 'Unread';
      if (button.textContent !== label) button.textContent = label;
      button.setAttribute('aria-pressed', String(isRead));
      button.setAttribute('aria-label', isRead ? 'Mark as unread' : 'Mark as read');
      button.title = isRead ? 'Mark as unread' : 'Mark as read';
    }
    for (const tile of root.querySelectorAll('.nf-tile[data-open-post]')) {
      tile.dataset.read = String(read.has(tile.dataset.openPost));
      let badge = tile.querySelector('.nf-read-status');
      if (!badge) { badge = document.createElement('span'); badge.className = 'nf-read-status'; tile.append(badge); }
      const label = read.has(tile.dataset.openPost) ? 'Read' : 'Unread';
      if (badge.textContent !== label) badge.textContent = label;
    }
  }
  function mark(key, value = true) {
    if (!key) return;
    try {
      const latest = load();
      if (latest.has(key) === value) { read = latest; paint(); return; }
      value ? latest.add(key) : latest.delete(key);
      storage.setItem(storageKey, JSON.stringify([...latest]));
      read = latest;
      status.textContent = '';
      paint();
    } catch { status.textContent = 'Couldn’t save read status. Allow browser storage and try again.'; }
  }
  root.addEventListener('click', event => {
    const toggle = event.target.closest('.read-toggle');
    if (toggle) { mark(toggle.dataset.readKey, !read.has(toggle.dataset.readKey)); return; }
    const open = event.target.closest('.original-link,.story-meta a');
    if (open) mark(keyFor(open));
  });
  root.addEventListener('toggle', event => {
    if (event.target.matches?.('.story-heading details') && event.target.open) mark(keyFor(event.target));
  }, true);
  root.addEventListener('play', event => { if (event.target.matches?.('video')) mark(keyFor(event.target)); }, true);
  root.addEventListener('posthole:read', event => mark(event.detail));
  const sync = event => {
    if (event.key !== storageKey && event.key !== null) return;
    try { read = load(); paint(); } catch { status.textContent = 'Couldn’t load read history.'; }
  };
  window.addEventListener('storage', sync);
  // Infinite scrolling, saved replies, and Postflix all insert/move cards.
  const observer = new MutationObserver(() => { observer.disconnect(); paint(); observe(); });
  const observe = () => observer.observe(root === document ? document.body : root, {childList: true, subtree: true});
  paint(); observe();
  return { mark, destroy() { observer.disconnect(); window.removeEventListener('storage', sync); } };
}
