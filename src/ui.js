export const LABELS = { x: 'X', linkedin: 'LinkedIn', bluesky: 'Bluesky', threads: 'Threads', hackernews: 'HN' };

export function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** i).toFixed(i ? 1 : 0)} ${units[i]}`;
}

// Turns helper connection problems into the one thing to do about them.
export function describeHost({ hostError, host }) {
  if (hostError) {
    if (/not found|not registered|forbidden/i.test(hostError)) return 'The file helper is not installed. In the posthole folder run: npm run install-host';
    return `File helper problem: ${hostError}`;
  }
  if (host && !host.writable) return `Can't write to the save folder: ${host.rootError ?? host.root}`;
  return null;
}
