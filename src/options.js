import { loadSettings, saveSettings } from './settings.js';
import { LABELS, describeHost, formatBytes } from './ui.js';

const $ = id => document.getElementById(id);
const FLAGS = ['hnComments', 'images', 'videos', 'avatars', 'keepSource', 'archiveRaw', 'fetchThreads', 'gitSync'];
const GIT = {
  'not-a-repo': 'The save folder is not a git repository. To publish it, run `git init` there and add a GitHub remote named origin.',
  'not-repo-root': 'The save folder is inside another git repository; it must be a repository of its own.',
  clean: 'Up to date',
  committed: 'Committed (no remote named origin to push to)',
  pushed: 'Pushed',
};
const NUMBERS = { maxAssetMB: [1, 100000], threadDepth: [1, 10], threadPages: [1, 100] };

function renderStatus(status) {
  const problem = describeHost(status);
  $('host').className = problem ? 'error' : 'muted';
  $('host').textContent = problem ?? (status.host ? `Helper ${status.host.version} connected · writing to ${status.host.root}` : 'Checking the file helper…');
  const { stats, queue } = status;
  const per = Object.entries(LABELS).map(([k, label]) => `${label} ${stats.byPlatform[k] ?? 0}`).join(' · ');
  $('session').textContent = `${stats.posts} posts (${stats.newPosts} new) · ${per} · ${stats.assets} files, ${formatBytes(stats.assetBytes)}`
    + (queue ? ` · ${queue} downloading` : '') + (stats.assetFailures ? ` · ${stats.assetFailures} failed` : '');
  const t = status.threads;
  const queued = Object.entries(t.queued).map(([k, n]) => `${LABELS[k]} ${n}`).join(' · ') || 'none';
  const last = Object.entries(t.last).map(([k, r]) => `${LABELS[k]}: ${r.status}${r.detail ? ` (${r.detail.slice(0, 80)})` : ''}`).join(' · ');
  $('threads').textContent = `${t.fetched} threads fetched this session · waiting: ${queued}${last ? ` · last: ${last}` : ''}`;
  const g = status.git ?? {};
  const sync = g.last;
  $('git').textContent = !sync ? (g.running ? 'Syncing…' : 'Not synced yet this session.')
    : `${g.running ? 'Syncing… · last: ' : ''}${GIT[sync.status] ?? sync.status}${sync.error ? `: ${sync.error}` : ''}`
      + (sync.remote ? ` · ${sync.remote.replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '')} (${sync.branch})` : '')
      + (sync.files ? ` · ${sync.files} files, ${formatBytes(sync.bytes)}` : '')
      + (sync.skipped ? ` · ${sync.skipped} large files kept local` : '')
      + (sync.finished_at ? ` · ${new Date(sync.finished_at).toLocaleTimeString()}` : '');
  $('errors').replaceChildren(...stats.errors.slice(0, 8).map(e => {
    const li = document.createElement('li');
    li.textContent = `${new Date(e.at).toLocaleTimeString()} · ${e.where}: ${e.message}`;
    return li;
  }));
}

async function render() {
  const settings = await loadSettings();
  $('root').value = settings.root;
  for (const key of Object.keys(NUMBERS)) $(key).value = settings[key];
  for (const flag of FLAGS) $(flag).checked = Boolean(settings[flag]);
  $('platforms').replaceChildren(...Object.entries(LABELS).map(([key, label]) => {
    const wrap = document.createElement('label');
    wrap.className = 'check';
    wrap.innerHTML = '<input type="checkbox">';
    const box = wrap.querySelector('input');
    box.checked = settings.platforms[key];
    box.addEventListener('change', async () => saveSettings({ platforms: { ...(await loadSettings()).platforms, [key]: box.checked } }));
    wrap.append(` ${key === 'hackernews' ? 'Hacker News' : label}`);
    return wrap;
  }));
}

const check = async () => renderStatus(await chrome.runtime.sendMessage({ type: 'hello' }));

$('root').addEventListener('change', async () => { await saveSettings({ root: $('root').value.trim() }); check(); });
$('choose').addEventListener('click', async () => {
  const { path, error } = await chrome.runtime.sendMessage({ type: 'pickFolder' });
  if (error) $('host').textContent = error;
  if (path) { $('root').value = path; check(); }
});
$('open').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'openFolder' }));
for (const [key, [min, max]] of Object.entries(NUMBERS)) {
  $(key).addEventListener('change', () => saveSettings({ [key]: Math.min(max, Math.max(min, Math.round(Number($(key).value)) || min)) }));
}
for (const flag of FLAGS) $(flag).addEventListener('change', () => saveSettings({ [flag]: $(flag).checked }));
$('syncNow').addEventListener('click', async () => renderStatus(await chrome.runtime.sendMessage({ type: 'syncNow' })));
$('reset').addEventListener('click', async () => renderStatus(await chrome.runtime.sendMessage({ type: 'resetStats' })));

render();
check();
setInterval(async () => renderStatus(await chrome.runtime.sendMessage({ type: 'status' })), 2000);
