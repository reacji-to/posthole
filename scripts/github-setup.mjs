// One-time setup: turns the save folder into a GitHub repository that the extension
// pushes to, with GitHub Pages publishing the card site every 15 minutes.
//   node scripts/github-setup.mjs --repo owner/name [--public] [--dir ~/posthole]
// Uses the repository if it already exists. Requires the GitHub CLI (gh), signed in, and
// Git LFS for files over 100 MB. A private repository needs a paid plan (e.g. Pro) for Pages,
// and Pages sites are public either way.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { runSync } from '../host/posthole-host.mjs';

const { values } = parseArgs({ options: { repo: { type: 'string' }, public: { type: 'boolean', default: false }, dir: { type: 'string', default: '~/posthole' } } });
if (!values.repo || !/^[\w.-]+\/[\w.-]+$/.test(values.repo)) {
  console.error('Usage: node scripts/github-setup.mjs --repo owner/name [--public] [--dir ~/posthole]');
  process.exit(1);
}
const dir = path.resolve(values.dir.replace(/^~(?=$|\/)/, os.homedir()));
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { cwd: dir, stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8', ...opts }).trim();

if (!fs.existsSync(path.join(dir, '.git'))) run('git', ['init', '-q', '-b', 'main']);
const remotes = run('git', ['remote']).split('\n');
if (!remotes.includes('origin')) {
  let exists = true;
  try { run('gh', ['repo', 'view', values.repo, '--json', 'name'], { stdio: ['ignore', 'pipe', 'pipe'] }); } catch { exists = false; }
  if (exists) run('git', ['remote', 'add', 'origin', `https://github.com/${values.repo}.git`]);
  else run('gh', ['repo', 'create', values.repo, values.public ? '--public' : '--private', '--source', '.', '--remote', 'origin', '--description', 'Posts I scrolled past, saved by posthole']);
}
console.log('Pushing everything saved so far (in batches; the first push can take a while)…');
const result = await runSync(dir);
console.log(result);
// Pages is published by the workflow, not from a branch.
let pagesUrl = null;
try {
  try { run('gh', ['api', '-X', 'POST', `repos/${values.repo}/pages`, '-f', 'build_type=workflow'], { stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch { run('gh', ['api', '-X', 'PUT', `repos/${values.repo}/pages`, '-f', 'build_type=workflow'], { stdio: ['ignore', 'pipe', 'pipe'] }); }
  pagesUrl = JSON.parse(run('gh', ['api', `repos/${values.repo}/pages`])).html_url;
} catch (error) {
  console.warn(`GitHub Pages could not be enabled (${String(error.stderr ?? error.message).trim().split('\n')[0]}).`);
  console.warn('Private repositories need a paid plan for Pages. The workflow still builds the site and posthole.sqlite; only the Pages deploy step will fail.');
}
// A brand-new workflow takes a moment to register before it can be started.
for (let attempt = 1; ; attempt++) {
  try { run('gh', ['workflow', 'run', 'posthole.yml', '--repo', values.repo], { stdio: ['ignore', 'pipe', 'pipe'] }); break; }
  catch (error) {
    if (attempt === 6) { console.warn(`Could not start the workflow yet: ${String(error.stderr ?? error.message).trim()}`); break; }
    await new Promise(resolve => setTimeout(resolve, 5000));
  }
}
console.log(`Done. Repository: https://github.com/${values.repo}${pagesUrl ? `\nSite (after the first workflow run): ${pagesUrl}` : ''}`);
