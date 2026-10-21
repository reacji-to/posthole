// Build a portable download without dependencies, local data or host paths.
import { mkdtemp, mkdir, cp, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.resolve(process.argv[2] ?? path.join(root, 'release/posthole.zip'));
const build = spawnSync(process.execPath, [path.join(root, 'scripts/build.mjs')], { stdio: 'inherit' });
if (build.status !== 0) process.exit(build.status ?? 1);
const stage = await mkdtemp(path.join(os.tmpdir(), 'posthole-package-'));
try {
  const dest = path.join(stage, 'posthole');
  await mkdir(dest);
  for (const name of ['README.md', 'SCHEMA.md', 'package.json', 'package-lock.json', 'manifest.json', 'playwright.config.js', 'src', 'scripts', 'host', 'icons', 'dist', 'viewer', 'github', 'tests']) {
    await cp(path.join(root, name), path.join(dest, name), { recursive: true, filter: source => !source.split(path.sep).includes('node_modules') && source !== path.join(root, 'host/posthole-host') });
  }
  await mkdir(path.dirname(out), { recursive: true });
  await rm(out, { force: true });
  const zipped = spawnSync('zip', ['-qr', out, 'posthole'], { cwd: stage, stdio: 'inherit' });
  if (zipped.status !== 0) throw new Error('Packaging requires the zip command.');
  console.log(out);
} finally { await rm(stage, { recursive: true, force: true }); }
