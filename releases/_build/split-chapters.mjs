// Split the generated releases.html into per-chapter fragments so review
// agents can diff a chapter against its source page without loading 20MB.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(__dirname, '..', 'releases.html'), 'utf8');
const outDir = join(__dirname, 'chapters');
mkdirSync(outDir, { recursive: true });

const re = /<article class="chapter" id="([^"]+)" data-release="[^"]+"[\s\S]*?<\/article>/g;
let m, n = 0;
while ((m = re.exec(html))) {
  writeFileSync(join(outDir, m[1] + '.html'), m[0]);
  n++;
}
// also dump the head CSS + runtime JS (without font/video base64) for code review
const css = html.match(/<style>\n:root[\s\S]*?<\/style>/)?.[0] || '';
writeFileSync(join(outDir, '_master.css.txt'), css);
const js = html.match(/<script>\n\(function \(\) \{[\s\S]*?<\/script>/)?.[0] || '';
writeFileSync(join(outDir, '_runtime.js.txt'), js);
console.log(`${n} chapters split, css ${css.length}b, js ${js.length}b`);
