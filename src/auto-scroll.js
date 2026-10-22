import { platformFor } from './match.js';

// Runs in the target tab's isolated world. No page timers or animation frames:
// those are throttled when the user switches tabs. Every step checks its deadline.
export function scrollStep(deadline, expectedUrl) {
  if (Date.now() >= deadline) return { stopped: 'Time is up.' };
  if (location.href !== expectedUrl) return { stopped: 'The tab navigated to another page.' };
  const scrolling = document.scrollingElement;
  if (!scrolling) return { moved: false };
  let target = scrolling;
  for (let el = document.elementFromPoint(innerWidth / 2, innerHeight / 2); el && el !== document.body; el = el.parentElement) {
    if (el.clientHeight > 150 && el.scrollHeight > el.clientHeight + 2 && /auto|scroll/.test(getComputedStyle(el).overflowY)) { target = el; break; }
  }
  const before = target.scrollTop;
  target.scrollBy({ top: Math.max(200, (target === scrolling ? innerHeight : target.clientHeight) * .7), behavior: 'instant' });
  return { moved: Math.abs(target.scrollTop - before) > 1 };
}

export function createAutoScroller(api, loadSettings, now = Date.now) {
  const key = 'posthole.autoScroll', alarm = 'posthole-auto-scroll';
  let timer, queue = Promise.resolve();
  const serial = work => { const task = queue.then(work); queue = task.catch(() => {}); return task; };
  const read = async () => (await api.storage.session.get(key))[key] ?? { running: false };
  const write = state => api.storage.session.set({ [key]: state });
  async function stopRun(reason = 'Stopped.') {
    clearTimeout(timer);
    const state = await read();
    await write({ ...state, running: false, reason });
    await api.alarms.clear(alarm);
    if (state.running) {
      try { await api.tabs.update(state.tabId, { autoDiscardable: state.autoDiscardable }); } catch { /* tab closed */ }
    }
    return { ...state, running: false, reason };
  }
  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(() => tick().catch(() => {}), 5000);
    timer.unref?.();
  }
  async function step() {
    const state = await read();
    if (!state.running) { clearTimeout(timer); await api.alarms.clear(alarm); return state; }
    if (now() >= state.endsAt) return stopRun('Time is up.');
    const settings = await loadSettings();
    if (settings.paused || settings.platforms[state.platform] === false) return stopRun('Saving is paused for this site.');
    try {
      const tab = await api.tabs.get(state.tabId);
      if (tab.url !== state.url) return stopRun('The tab navigated to another page.');
      if (tab.discarded || tab.frozen) return stopRun('The browser suspended this tab. Open it and start again.');
      const [execution] = await api.scripting.executeScript({ target: { tabId: state.tabId }, func: scrollStep, args: [state.endsAt, state.url] });
      const result = execution?.result;
      if (!result) return stopRun('Couldn’t scroll this tab. Reload it and try again.');
      if (result.stopped) return stopRun(result.stopped);
      state.steps += Number(result.moved);
      if (result.moved) state.lastMovedAt = now();
      if (now() - state.lastMovedAt >= 60000) return stopRun('No more scrolling content appeared.');
      await write(state); schedule(); return state;
    } catch { return stopRun('Couldn’t scroll this tab. Reload it and try again.'); }
  }
  const tick = () => serial(step);
  const start = (tabId, minutes) => serial(async () => {
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 120) throw new Error('Choose a whole number from 1 to 120 minutes.');
    if ((await read()).running) throw new Error('Stop the current run before starting another.');
    const settings = await loadSettings();
    const tab = await api.tabs.get(tabId);
    const url = new URL(tab.url || '');
    const platform = platformFor(url.hostname);
    if (url.protocol !== 'https:' || !platform) throw new Error('Open a supported feed to start auto-scroll.');
    if (settings.paused || settings.platforms[platform] === false) throw new Error('Turn on saving for this site first.');
    if (tab.discarded || tab.frozen) throw new Error('Open this tab before starting auto-scroll.');
    const state = { running: true, tabId, url: tab.url, title: tab.title || url.hostname, platform, endsAt: now() + minutes * 60000, steps: 0, lastMovedAt: now(), autoDiscardable: tab.autoDiscardable !== false };
    await write(state);
    try {
      await api.tabs.update(tabId, { autoDiscardable: false });
      await api.alarms.create(alarm, { periodInMinutes: .5 });
    } catch { return stopRun('Couldn’t start background scrolling. Try again.'); }
    return step();
  });
  const stop = reason => serial(() => stopRun(reason));
  api.alarms.onAlarm.addListener(event => { if (event.name === alarm) tick().catch(() => {}); });
  api.tabs.onRemoved.addListener(tabId => serial(async () => { const state = await read(); if (state.running && state.tabId === tabId) await stopRun('The tab was closed.'); }).catch(() => {}));
  api.tabs.onUpdated.addListener((tabId, change) => serial(async () => {
    const state = await read();
    if (state.running && state.tabId === tabId && ((change.url && change.url !== state.url) || change.status === 'loading')) await stopRun('The tab navigated or reloaded.');
  }).catch(() => {}));
  api.storage.onChanged.addListener((changes, area) => { if (area === 'local' && changes.settings) tick().catch(() => {}); });
  // storage.session survives worker suspension, but not a fresh browser session.
  serial(async () => { if ((await read()).running) { await api.alarms.create(alarm, {periodInMinutes:.5}); await step(); } }).catch(() => {});
  return { start, stop, status: () => serial(read), tick };
}
