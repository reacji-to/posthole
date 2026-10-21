// Renders the toolbar icon (a post hole digger biting into the ground) at every size the manifest uses.
import sharp from 'sharp';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'icons');
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">
  <defs><clipPath id="tile"><rect x="2" y="2" width="124" height="124" rx="28"/></clipPath></defs>
  <g clip-path="url(#tile)">
    <rect width="128" height="128" fill="#a9dbf7"/>
    <rect y="100" width="128" height="28" fill="#58a83f"/>
    <ellipse cx="64" cy="106" rx="35" ry="9" fill="#5b3420"/>
    <line x1="54" y1="-6" x2="59" y2="62" stroke="#ec4a1c" stroke-width="9" stroke-linecap="round"/>
    <line x1="76" y1="-6" x2="69" y2="62" stroke="#ec4a1c" stroke-width="9" stroke-linecap="round"/>
    <path d="M36 72 Q36 64 45 64 H60 V102 L48 120 Q40 118 37 108 Z" fill="#2a2e33"/>
    <path d="M92 72 Q92 64 83 64 H68 V102 L80 120 Q88 118 91 108 Z" fill="#2a2e33"/>
    <path d="M43 72 V100" stroke="#78818b" stroke-width="3.5" stroke-linecap="round"/>
    <path d="M85 72 V100" stroke="#78818b" stroke-width="3.5" stroke-linecap="round"/>
    <rect x="49" y="56" width="30" height="14" rx="4" fill="#1b1d20"/>
    <circle cx="64" cy="63" r="4.5" fill="#aab3bd"/>
    <!-- The ground's front lip hides the blade tips inside the hole. -->
    <path d="M29 106 a35 9 0 0 0 70 0 V128 H29 Z" fill="#58a83f"/>
  </g>
</svg>`;
for (const size of [16, 32, 48, 128]) {
  await sharp(Buffer.from(svg), { density: 384 }).resize(size, size).png().toFile(path.join(out, `${size}.png`));
}
console.log(`Wrote icons to ${out}`);
