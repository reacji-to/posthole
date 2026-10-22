import { initCardInteractions } from './card-interactions.js';

export function initNetflix(feed, loadNext) {
  const entries = () => [...feed.children].filter(el => el.matches('.netflix-entry'));
  if (!entries().length) return;
  const catalogue = document.createElement('div'); catalogue.className = 'nf-catalogue';
  feed.before(catalogue); feed.classList.add('nf-library');
  const rows = document.createElement('div'); rows.className = 'nf-rows';
  const status = document.createElement('p'); status.className = 'nf-status'; status.setAttribute('role', 'status');
  const more = document.createElement('button'); more.className = 'nf-load'; more.textContent = 'Load more from your archive';
  const dialog = document.createElement('dialog'); dialog.className = 'nf-dialog'; dialog.setAttribute('aria-label', 'Saved post details');
  const close = document.createElement('button'); close.className = 'nf-close'; close.setAttribute('aria-label', 'Close post');
  close.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>';
  const dialogBody = document.createElement('div'); dialogBody.className = 'nf-dialog-content';
  const dialogStatus = document.createElement('p'); dialogStatus.className = 'nf-status'; dialogStatus.setAttribute('role', 'status');
  dialog.append(close, dialogBody, dialogStatus); document.body.append(dialog);
  initCardInteractions(dialogBody);
  let selected, opener, oldOverflow;
  function openPost(key, play = false, trigger) {
    const entry = entries().find(el => el.dataset.key === key);
    if (!entry) return;
    selected = entry; opener = trigger; dialogStatus.textContent = '';
    dialogBody.replaceChildren(entry.querySelector(':scope > .interface-card'));
    oldOverflow = document.body.style.overflow; document.body.style.overflow = 'hidden';
    dialog.showModal(); dialog.scrollTop = 0; close.focus();
    document.dispatchEvent(new CustomEvent('posthole:read', {detail:key}));
    if (play) {
      const video = dialogBody.querySelector('video');
      if (video) { video.scrollIntoView({block:'nearest'}); video.play().catch(() => { dialogStatus.textContent = 'Couldn’t play this video. Try its player controls or open the original post.'; }); }
    }
  }
  close.addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', event => { if (event.target === dialog) { const r = dialog.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) dialog.close(); } });
  dialog.addEventListener('close', () => {
    dialogBody.querySelectorAll('video').forEach(v => v.pause());
    if (selected && dialogBody.firstElementChild) selected.append(dialogBody.firstElementChild);
    document.body.style.overflow = oldOverflow || ''; opener?.focus(); selected = null;
  });
  catalogue.addEventListener('click', event => {
    const button = event.target.closest('[data-open-post]');
    if (button) openPost(button.dataset.openPost, button.dataset.play === 'true', button);
  });
  const featured = entries().find(el => el.dataset.mediaKind === 'video' && el.querySelector('.nf-cover img')) || entries().find(el => el.querySelector('.nf-cover img')) || entries()[0];
  const hero = document.createElement('section'); hero.className = 'nf-hero'; hero.setAttribute('aria-label', 'Featured from your archive');
  const art = featured.querySelector('.nf-cover img');
  if (art) { const image = art.cloneNode(); image.loading = 'eager'; image.className = 'nf-hero-art'; hero.append(image); }
  const heroCopy = document.createElement('div'); heroCopy.className = 'nf-hero-copy';
  const title = document.createElement('h1'); title.textContent = featured.dataset.title;
  const creator = document.createElement('p'); creator.className = 'nf-hero-creator'; creator.textContent = `Featuring ${featured.dataset.creator}`;
  const desc = document.createElement('p'); desc.className = 'nf-hero-description';
  const full = featured.querySelector('[data-full]') || featured.querySelector('.interface-content .text');
  const text = full?.textContent || '';
  desc.textContent = text.length > 245 ? text.slice(0, 242) + '…' : text;
  const actions = document.createElement('div'); actions.className = 'nf-hero-actions';
  const play = document.createElement('button'); play.className = 'nf-primary'; play.dataset.openPost = featured.dataset.key; play.dataset.play = String(featured.dataset.mediaKind === 'video');
  play.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m8 4 12 8-12 8Z" fill="currentColor"/></svg>';
  play.append(featured.dataset.mediaKind === 'video' ? 'Play' : 'Read post');
  const info = document.createElement('button'); info.className = 'nf-secondary'; info.dataset.openPost = featured.dataset.key;
  info.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 11v6M12 7v1" stroke="currentColor" stroke-width="2"/></svg>';
  info.append('More info'); actions.append(play, info); heroCopy.append(creator, title, desc, actions); hero.append(heroCopy);
  catalogue.append(hero, rows, more, status);
  const groups = [
    ['Watch next', el => el.dataset.mediaKind === 'video'],
    ['Pictures worth saving', el => el.dataset.mediaKind === 'image'],
    ['From X', el => el.dataset.source === 'x'],
    ['From LinkedIn', el => el.dataset.source === 'linkedin'],
    ['Something to read', el => el.dataset.mediaKind === 'text'],
    ['All your saved posts', () => true],
  ];
  let rowObservers = [];
  function renderRows() {
    rowObservers.forEach(observer => observer.disconnect()); rowObservers = [];
    const scrolls = [...rows.children].map(row => row.querySelector('.nf-track').scrollLeft);
    rows.replaceChildren();
    groups.forEach(([name, filter]) => {
      const list = entries().filter(filter);
      if (!list.length) return;
      const row = document.createElement('section'); row.className = 'nf-row'; row.setAttribute('aria-label', name);
      const heading = document.createElement('div'); heading.className = 'nf-row-heading';
      const h = document.createElement('h2'); h.textContent = name;
      const controls = document.createElement('div'); controls.className = 'nf-row-controls';
      const track = document.createElement('div'); track.className = 'nf-track';
      track.setAttribute('tabindex', '0'); track.setAttribute('aria-label', `${name} posts`);
      for (const entry of list) track.append(entry.querySelector(':scope > .nf-tile').cloneNode(true));
      const arrows = [-1, 1].map(direction => {
        const button = document.createElement('button'); button.setAttribute('aria-label', `${direction < 0 ? 'Previous' : 'Next'} in ${name}`);
        button.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${direction < 0 ? 'm15 5-7 7 7 7' : 'm9 5 7 7-7 7'}"/></svg>`;
        button.addEventListener('click', () => track.scrollBy({left:direction * track.clientWidth * .85,behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'}));
        controls.append(button); return button;
      });
      const update = () => { arrows[0].disabled = track.scrollLeft <= 2; arrows[1].disabled = track.scrollLeft >= track.scrollWidth - track.clientWidth - 2; };
      track.addEventListener('scroll', update, {passive:true});
      const observer = new ResizeObserver(update); observer.observe(track); rowObservers.push(observer);
      heading.append(h, controls); row.append(heading, track); rows.append(row);
      track.scrollLeft = scrolls[rows.children.length - 1] || 0; update();
    });
    more.hidden = !feed.querySelector('.more[data-next]');
    status.textContent = `${entries().length} posts loaded${more.hidden ? ' · all posts loaded' : ''}`;
  }
  more.addEventListener('click', async () => {
    more.disabled = true; more.textContent = 'Loading…';
    try { if (await loadNext()) renderRows(); else status.textContent = 'Couldn’t load more posts. Try again.'; }
    finally { more.disabled = false; more.textContent = 'Load more from your archive'; }
  });
  renderRows();
}
