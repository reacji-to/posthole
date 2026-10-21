// Everything is on by default: the goal is a complete, exact record.
export const DEFAULTS = {
  root: '~/posthole',
  paused: false,
  platforms: { x: true, linkedin: true, bluesky: true, threads: true, hackernews: true },
  hnComments: true,
  images: true,
  videos: true,
  avatars: true,
  maxAssetMB: 4096,
  keepSource: true,
  archiveRaw: true,
  // Commit and push the save folder when it is a git repository (GitHub Pages site included).
  gitSync: true,
  fetchThreads: true,
  // Replies to replies are fetched this many levels below what you scrolled past.
  threadDepth: 2,
  // "Show more replies" pages followed per thread.
  threadPages: 10,
};

export async function loadSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return { ...DEFAULTS, ...settings, platforms: { ...DEFAULTS.platforms, ...settings?.platforms } };
}

export async function saveSettings(patch) {
  const next = { ...(await loadSettings()), ...patch };
  await chrome.storage.local.set({ settings: next });
  return next;
}
