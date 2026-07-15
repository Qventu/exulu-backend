// Inline a release page's videos so the standalone index.html is fully
// self-contained. Base64 lives in a JSON <script> and is hydrated into
// blob: URLs at runtime — NOT data: URIs, because the Exulu artifact viewer's
// CSP is `media-src 'self' blob:` (data: media is rejected; blob: is allowed,
// and the artifact iframe sandbox includes allow-scripts).
// Keeps data-short="<name>.mp4" markers so the master pipeline still resolves
// clips. Usage: node _build/embed-page-videos.mjs <release-slug>
import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RELEASES = join(__dirname, '..');
const slug = process.argv[2];
if (!slug) { console.error('usage: node embed-page-videos.mjs <release-slug>'); process.exit(1); }

const file = join(RELEASES, slug, 'index.html');
const bak = join(RELEASES, slug, 'index.external-videos.bak.html');
// always regenerate from the original page (with ./shorts/ srcs)
if (!existsSync(bak)) copyFileSync(file, bak);
let html = readFileSync(bak, 'utf8');

const store = {};
let embedded = 0;
html = html.replace(/<video\b([^>]*)>/g, (tag, attrs) => {
  const name = attrs.match(/src="\.\/shorts\/([^"]+\.mp4)"/)?.[1] || attrs.match(/data-short="([^"]+\.mp4)"/)?.[1];
  if (!name) return tag;
  const enc = join(__dirname, 'enc', `${slug}__${name}`);
  const raw = join(RELEASES, slug, 'shorts', name);
  const src = existsSync(enc) ? enc : raw;
  if (!existsSync(src)) { console.error(`MISSING VIDEO: ${name}`); return tag; }
  store[name] = readFileSync(src).toString('base64');
  embedded++;
  const rest = attrs
    .replace(/\s*src="[^"]*"/, '')
    .replace(/\s*data-short="[^"]*"/, '')
    .replace(/\s*poster="[^"]*"/, '')
    .replace(/\s*autoplay\b/, ''); // playback is driven by the hydration script
  return `<video data-short="${name}" width="1920" height="1080"${rest}>`;
});

// base64 alphabet cannot produce "</script", so raw JSON injection is safe
const runtime = `
<script id="vdata" type="application/json">${JSON.stringify(store)}</script>
<script>
(function () {
  'use strict';
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var el = document.getElementById('vdata');
  var DATA = JSON.parse(el.textContent);
  el.textContent = '';
  var vids = Array.prototype.slice.call(document.querySelectorAll('video[data-short]'));
  vids.forEach(function (v) {
    var b64 = DATA[v.dataset.short];
    if (!b64) return;
    var bin = atob(b64), bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    v.src = URL.createObjectURL(new Blob([bytes], { type: 'video/mp4' }));
    v.muted = true;
    if (reduce) { v.controls = true; return; }
  });
  if (!reduce && 'IntersectionObserver' in window) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        var v = e.target;
        if (e.isIntersecting && e.intersectionRatio >= 0.25) v.play().catch(function () {});
        else if (!v.paused) v.pause();
      });
    }, { threshold: [0, 0.25] });
    vids.forEach(function (v) { io.observe(v); });
  } else if (!reduce) {
    vids.forEach(function (v) { v.play().catch(function () {}); });
  }
})();
</script>`;

const idx = html.toLowerCase().lastIndexOf('</body>');
html = idx === -1 ? html + runtime : html.slice(0, idx) + runtime + '\n' + html.slice(idx);

writeFileSync(file, html);
const mb = (n) => (n / 1024 / 1024).toFixed(1) + ' MB';
console.log(`${slug}: ${embedded} videos embedded via blob hydration, page ${mb(Buffer.byteLength(html))}`);
console.log(`original kept at ${bak}`);
