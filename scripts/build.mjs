// Bundles the extension into dist/, which is the folder to load unpacked.
import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const watch = process.argv.includes('--watch');
// Each build gets an ID; the running extension reloads itself when dist/ has a newer one.
const build = Date.now().toString(36);

function copyStatic() {
  fs.mkdirSync(path.join(dist, 'icons'), { recursive: true });
  fs.copyFileSync(path.join(root, 'manifest.json'), path.join(dist, 'manifest.json'));
  for (const file of fs.readdirSync(path.join(root, 'src'))) {
    if (/\.(html|css)$/.test(file)) fs.copyFileSync(path.join(root, 'src', file), path.join(dist, file));
  }
  for (const file of fs.readdirSync(path.join(root, 'icons'))) fs.copyFileSync(path.join(root, 'icons', file), path.join(dist, 'icons', file));
  fs.writeFileSync(path.join(dist, 'build.json'), JSON.stringify({ build }));
}

const options = {
  entryPoints: ['hook', 'content', 'background', 'popup', 'options'].map(name => path.join(root, 'src', `${name}.js`)),
  outdir: dist,
  bundle: true,
  format: 'iife',
  target: 'chrome120',
  legalComments: 'none',
  define: { __BUILD__: JSON.stringify(build) },
  logLevel: 'info',
  plugins: [{ name: 'static', setup: build => build.onEnd(copyStatic) }],
};

fs.rmSync(dist, { recursive: true, force: true });
if (watch) await (await esbuild.context(options)).watch();
else await esbuild.build(options);
