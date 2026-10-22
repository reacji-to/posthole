// Shared by the live viewer and generated site. Source actions link to the
// original; only archive disclosures change local state.
export function initCardInteractions(feed) {
  const markRead = node => {
    const key = node.closest('[data-read-key]')?.dataset.readKey || node.closest('.post-entry[data-key]')?.dataset.key;
    if (key) document.dispatchEvent(new CustomEvent('posthole:read', {detail:key}));
  };
  feed.addEventListener('click', async event => {
    const expand = event.target.closest('.expand-text');
    if (expand) {
      const copy = expand.closest('.copy');
      const open = expand.getAttribute('aria-expanded') !== 'true';
      expand.setAttribute('aria-expanded', String(open));
      copy.classList.toggle('expanded', open);
      const full = copy.querySelector('[data-full]');
      if (full) {
        full.hidden = !open;
        copy.querySelector('[data-preview]').hidden = open;
      }
      expand.dataset.label ??= expand.textContent;
      expand.textContent = open ? 'Show less' : expand.dataset.label;
      if (open) markRead(expand);
      return;
    }
    const button = event.target.closest('.replies-toggle');
    if (!button || button.disabled) return;
    const box = button.nextElementSibling;
    button.dataset.label ??= button.textContent;
    if (!box.hidden) {
      box.hidden = true;
      button.textContent = button.dataset.label;
      button.setAttribute('aria-expanded', 'false');
      return;
    }
    if (!box.dataset.loaded) {
      button.disabled = true;
      button.textContent = 'Loading…';
      try {
        const response = await fetch(button.dataset.href);
        if (!response.ok) throw new Error('Reply request failed');
        box.innerHTML = await response.text();
        box.dataset.loaded = '1';
      } catch {
        button.textContent = 'Couldn’t load replies · retry';
        return;
      } finally {
        button.disabled = false;
      }
    }
    box.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    button.textContent = 'Hide replies';
    markRead(button);
  });
  document.addEventListener('play', event => {
    for (const video of document.querySelectorAll('video')) if (video !== event.target && !video.muted) video.pause();
  }, true);
}
