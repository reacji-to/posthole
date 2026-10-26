// Keep the local viewer running across terminal exits, crashes, and macOS logins.
// node scripts/install-server.mjs [--dir ~/posthole] [--port 4747] [--uninstall]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { spawnSync } from 'node:child_process';

if (process.platform !== 'darwin') throw new Error('This installer uses macOS launchd. On other systems, run bun start in viewer/.');
const {values} = parseArgs({options: {dir: {type: 'string'}, port: {type: 'string'}, uninstall: {type: 'boolean'}}});
const label = 'ink.posthole.viewer';
const service = `gui/${process.getuid()}/${label}`;
const plist = path.join(os.homedir(), 'Library/LaunchAgents', `${label}.plist`);
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const run = (program, args) => {
  const result = spawnSync(program, args, {encoding: 'utf8'});
  if (result.status !== 0) throw new Error(result.error?.message || result.stderr?.trim() || `${program} failed.`);
  return result.stdout;
};
if (values.uninstall) {
  spawnSync('/bin/launchctl', ['bootout', service]);
  fs.rmSync(plist, {force: true});
  console.log('Stopped Posthole viewer and removed its LaunchAgent. Your archive is unchanged.');
} else {
  const port = Number(values.port ?? 4747);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Choose a port from 1 to 65535.');
  const bun = run('/usr/bin/which', ['bun']).trim();
  run(bun, ['--version']);
  const viewer = path.join(repo, 'viewer');
  if (!fs.existsSync(path.join(viewer, 'node_modules/hono'))) throw new Error('Install viewer dependencies first: cd viewer && bun install');
  const archive = path.resolve((values.dir ?? '~/posthole').replace(/^~(?=$|\/)/, os.homedir()));
  const logs = path.join(os.homedir(), 'Library/Logs/Posthole');
  const xml = value => String(value).replace(/[&<>"']/g, char => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;'}[char]));
  const args = [bun, path.join(viewer, 'server.tsx'), '--dir', archive, '--port', port];
  const source = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key><array>${args.map(arg => `<string>${xml(arg)}</string>`).join('')}</array>
  <key>WorkingDirectory</key><string>${xml(viewer)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${xml(path.join(logs, 'viewer.log'))}</string>
  <key>StandardErrorPath</key><string>${xml(path.join(logs, 'viewer-error.log'))}</string>
</dict></plist>
`;
  fs.mkdirSync(path.dirname(plist), {recursive: true});
  fs.mkdirSync(logs, {recursive: true});
  fs.writeFileSync(plist, source, {mode: 0o600});
  run('/usr/bin/plutil', ['-lint', plist]);
  spawnSync('/bin/launchctl', ['bootout', service]);
  run('/bin/launchctl', ['bootstrap', `gui/${process.getuid()}`, plist]);
  console.log(`Posthole viewer: http://localhost:${port}\nArchive: ${archive}\nLaunchAgent: ${plist}\nLogs: ${logs}\nRestarts automatically and starts at login.\nRestart: launchctl kickstart -k ${service}\nUninstall: node scripts/install-server.mjs --uninstall`);
}
