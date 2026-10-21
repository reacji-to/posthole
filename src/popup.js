import { saveSettings } from './settings.js';
import { LABELS, describeHost, formatBytes } from './ui.js';

const $ = id => document.getElementById(id);

async function render(status) {
  const { settings, stats, queue } = status;
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
$('open').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'openFolder' }));
$('settings').addEventListener('click', () => chrome.runtime.openOptionsPage());

refresh('hello');
setInterval(refresh, 1500);
