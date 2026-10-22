import { platformFor } from './match.js';
import { saveSettings } from './settings.js';
import { LABELS, describeHost, formatBytes } from './ui.js';

const $ = id => document.getElementById(id);

let targetTab;
let scrollBusy = false;
async function render(status) {
  if (status.error) { $('problem').hidden = false; $('problem').textContent = status.error; return; }
  renderAutoScroll(status.autoScroll, status.settings);
  const { settings, stats, queue } = status;
  $('save-threads').checked = settings.fetchThreads;
  $('thread-limits').textContent = settings.fetchThreads
    ? `Queues posts with known replies. Up to ${settings.threadPages} pages per thread, ${settings.threadDepth} reply levels. Continues after scrolling stops; sites may limit what can be saved.`
    : 'Reply fetching is off. Feed posts will still be saved.';
  $('recording').checked = !settings.paused;
  $('recording-label').textContent = settings.paused ? 'Paused' : 'Saving';
  $('where').textContent = `Saving to ${settings.root}`;
  $('counts').replaceChildren(...Object.entries(LABELS).map(([key, label]) => {
    const li = document.createElement('li');
    li.className = settings.platforms[key] ? '' : 'off';
    li.innerHTML = '<b></b><span></span>';
    li.querySelector('b').textContent = stats.byPlatform[key] ?? 0;
    li.querySelector('span').textContent = label;
    return li;
  }));
  const waiting = Object.values(status.threads.queued).reduce((a, b) => a + b, 0);
  $('assets').textContent = `${stats.posts} posts this session · ${stats.assets} files (${formatBytes(stats.assetBytes)})`
    + (queue ? ` · ${queue} downloading` : '') + (stats.assetFailures ? ` · ${stats.assetFailures} failed` : '')
    + ` · ${status.threads.fetched} threads fetched` + (waiting ? `, ${waiting} waiting` : '');
  const last = stats.lastSaved;
  $('last').hidden = !last;
  if (last) {
    $('last').innerHTML = '<div class="meta"></div><div class="text"></div>';
    $('last').querySelector('.meta').textContent = `Last saved · ${LABELS[last.platform]}${last.author ? ` · ${last.author}` : ''}`;
    $('last').querySelector('.text').textContent = last.text || last.url;
  }
  const problem = describeHost(status) ?? (stats.errors[0] && Date.now() - Date.parse(stats.errors[0].at) < 60000 ? stats.errors[0].message : null);
  $('problem').hidden = !problem;
  $('problem').textContent = problem ?? '';
}

const refresh = async (type = 'status') => render(await chrome.runtime.sendMessage({ type }));

$('recording').addEventListener('change', async event => {
  await saveSettings({ paused: !event.target.checked });
  refresh();
});
$('save-threads').addEventListener('change', async event => {
  const input = event.target; input.disabled = true;
  try { await saveSettings({fetchThreads:input.checked}); await refresh(); }
  catch { $('scroll-error').textContent = 'Couldn’t save the reply setting. Try again.'; $('scroll-error').hidden = false; }
  finally { input.disabled = false; }
});
$('open').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'openFolder' }));
$('settings').addEventListener('click', () => chrome.runtime.openOptionsPage());

function renderAutoScroll(run = {}, settings) {
  const running = !!run.running;
  $('scroll-start').hidden = running; $('scroll-stop').hidden = !running;
  const platform = targetTab?.url ? platformFor(new URL(targetTab.url).hostname) : null;
  $('scroll-start').disabled = scrollBusy || !platform || settings.paused || settings.platforms[platform] === false;
  $('scroll-minutes').disabled = running || scrollBusy;
  if (running) {
    const seconds = Math.max(0, Math.ceil((run.endsAt - Date.now()) / 1000));
    $('scroll-status').textContent = `${run.title} · ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')} left · ${run.steps} scrolls`;
  } else {
    $('scroll-status').textContent = run.reason || (!platform ? 'Open X, LinkedIn, Bluesky, Threads, or Hacker News to start.' : 'Varied scrolls and pauses. Keep the browser open; background scrolling may slow down.');
  }
}
async function changeScroll(message) {
  scrollBusy = true; $('scroll-start').disabled = true; $('scroll-stop').disabled = true; $('scroll-error').hidden = true;
  try {
    const result = await chrome.runtime.sendMessage(message);
    if (result.error) throw new Error(result.error);
  } catch (error) { $('scroll-error').textContent = error.message; $('scroll-error').hidden = false; }
  finally { scrollBusy = false; $('scroll-stop').disabled = false; await refresh(); }
}
$('auto-scroll-form').addEventListener('submit', event => {
  event.preventDefault();
  if (!targetTab?.id || !$('auto-scroll-form').reportValidity()) return;
  changeScroll({type:'autoScrollStart',tabId:targetTab.id,minutes:Number($('scroll-minutes').value)});
});
$('scroll-stop').addEventListener('click', () => changeScroll({type:'autoScrollStop'}));
chrome.tabs.query({active:true,currentWindow:true}).then(tabs => { targetTab = tabs[0]; return refresh('hello'); });
setInterval(refresh, 1500);

$('check-updates').addEventListener('click', async () => {
  $('check-updates').disabled = true;
  $('update-status').textContent = 'Checking local build…';
  try {
    const result = await chrome.runtime.sendMessage({type:'checkUpdates'});
    $('update-status').textContent = result.message || result.error || 'Couldn’t check for updates.';
  } catch { $('update-status').textContent = 'The extension disconnected. Reopen this popup to check its status.'; }
  finally { $('check-updates').disabled = false; }
});
