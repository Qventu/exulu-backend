// Prep for the video re-skin: back up originals, apply the deterministic
// old-CI -> new-CI color/font remap to every referenced composition file,
// and emit the font-face CSS agents inject into each composition.
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RELEASES = join(__dirname, '..');
const map = JSON.parse(readFileSync(join(__dirname, 'video-map.json'), 'utf8'));

// ---- 1. font css for injection into compositions --------------------------
const WEB_FONTS = '/Users/daniel.claessen/Desktop/Projects/exulu/exulu-website/web/public/fonts';
const b64 = (f) => readFileSync(join(WEB_FONTS, f)).toString('base64');
const fontsCss = [
  ['Aspekta', 400, 'inter-tight-400.woff2'],
  ['Aspekta', 500, 'inter-tight-500.woff2'],
  ['RobotoMono', 400, 'roboto-mono-400.woff2'],
].map(([fam, w, f]) =>
  `@font-face{font-family:'${fam}';font-style:normal;font-weight:${w};src:url(data:font/woff2;base64,${b64(f)}) format('woff2')}`
).join('\n');
writeFileSync(join(__dirname, 'ci-video-fonts.css'), fontsCss);

// ---- 2. deterministic color remap (old product CI -> website CI) ----------
const HEX_MAP = [
  // backgrounds / surfaces (cool -> warm)
  ['#fdfdfd', '#f8f6f1'], ['#fcfcfc', '#fbfaf7'], ['#fafafa', '#f8f6f1'],
  ['#f5f5f5', '#efece4'], ['#f0f0f3', '#efece4'], ['#f7f8fa', '#efece4'],
  ['#eef1f5', '#efece4'], ['#edf1f5', '#efece4'], ['#f5f8fb', '#efece4'],
  // hairlines / borders
  ['#e7e7ee', '#e4ddd0'], ['#e8e8ef', '#e4ddd0'], ['#ececef', '#e4ddd0'],
  ['#e4e7ec', '#e4ddd0'], ['#e6e6eb', '#e4ddd0'], ['#ebebeb', '#e4ddd0'],
  // text ramp (cool grays -> warm)
  ['#0a0a0a', '#241f1a'], ['#1a1a1a', '#241f1a'], ['#171717', '#241f1a'],
  ['#121317', '#1b1714'], ['#525252', '#55504a'], ['#4a4a52', '#55504a'],
  ['#6b6b73', '#6b6560'], ['#737373', '#6b6560'], ['#8a8a93', '#9b948d'],
  ['#a3a3a3', '#9b948d'],
  // purple family -> green/lime family
  ['#7033ff', '#6f9a37'], ['#6633ff', '#6f9a37'], ['#9061ff', '#8fbf4d'],
  ['#c9b6ff', '#cef79e'], ['#c3aaff', '#cef79e'], ['#f3f0ff', '#eef3e2'],
  // blue accent family -> warm neutrals
  ['#e2ebff', '#efece4'], ['#1e69dc', '#4d5757'], ['#1e6adc', '#4d5757'],
  ['#2563eb', '#4d5757'],
  // success green harmonized to signal
  ['#16a34a', '#6f9a37'],
];
const RGBA_MAP = [
  [/rgba\(\s*112\s*,\s*51\s*,\s*255\s*,/g, 'rgba(111, 154, 55,'],
  [/rgba\(\s*253\s*,\s*253\s*,\s*253\s*,/g, 'rgba(248, 246, 241,'],
  [/rgba\(\s*226\s*,\s*235\s*,\s*255\s*,/g, 'rgba(239, 236, 228,'],
];
const FONT_MAP = [
  [/(['"])Inter\1(\s*,\s*)system-ui/g, `'Aspekta', 'Inter Tight'$2system-ui`],
  [/(['"])JetBrains Mono\1/g, `'RobotoMono'`],
];

function remap(src) {
  for (const [from, to] of HEX_MAP) src = src.replaceAll(from, to).replaceAll(from.toUpperCase(), to);
  for (const [re, to] of RGBA_MAP) src = src.replace(re, to);
  for (const [re, to] of FONT_MAP) src = src.replace(re, to);
  return src;
}

// ---- 3. back up + remap each referenced composition file ------------------
const files = [...new Set(map.map((t) => t.file))];
let remapped = 0;
for (const rel of files) {
  const f = join(RELEASES, rel);
  const bak = f.replace(/\.html$/, '.purple.bak.html');
  if (!existsSync(bak)) copyFileSync(f, bak); // keep the original once
  const src = readFileSync(bak, 'utf8');     // always remap from the original
  writeFileSync(f, remap(src));
  remapped++;
}

// ---- 4. back up the referenced shorts ------------------------------------
let backed = 0;
for (const t of map) {
  const dir = join(RELEASES, t.release, 'shorts');
  const purple = join(dir, '_purple');
  mkdirSync(purple, { recursive: true });
  const src = join(dir, t.video + '.mp4');
  const dst = join(purple, t.video + '.mp4');
  if (existsSync(src) && !existsSync(dst)) { copyFileSync(src, dst); backed++; }
}

console.log(`fonts css written (${fontsCss.length}b), ${remapped} composition files remapped, ${backed} shorts backed up`);
