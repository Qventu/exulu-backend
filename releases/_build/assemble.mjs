// Assemble releases.html — a single self-contained changelog page.
// Inputs: releases.json (extract.mjs), _build/enc/*.mp4 (encode-all.sh),
// agent-workbench-exulu.html (hand-ported chapter), frontend fonts + logo.
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RELEASES_DIR = join(__dirname, '..');
const FRONTEND = '/Users/daniel.claessen/Desktop/Projects/exulu/frontend';
const OUT = join(RELEASES_DIR, 'releases.html');

const releases = JSON.parse(readFileSync(join(__dirname, 'releases.json'), 'utf8'));
const bySlug = Object.fromEntries(releases.map((r) => [r.slug, r]));
const warnings = [];

// ---------------------------------------------------------------- curation
// Display order, newest first. name = sidebar label; headline/lede override
// the page hero where the original was generic ("What's new in Exulu.").
const ORDER = [
  { slug: '2026-07-13-connect-your-agent', name: 'Connect Your Agent' },
  { slug: '2026-07-08-projects', name: 'Projects' },
  { slug: '2026-07-08-routines', name: 'Routines' },
  { slug: '2026-07-08-agent-evals', name: 'Agent Evals' },
  { slug: '2026-07-08-context-management', name: 'Context Management' },
  { slug: '2026-07-08-chat-trust-and-control', name: 'Trust & Control in Chat' },
  { slug: '2026-07-08-chat-quality-of-life', name: 'Chat Quality of Life' },
  { slug: '2026-07-08-prompt-and-skill-libraries', name: 'Prompt & Skill Libraries' },
  { slug: '2026-07-08-admin-and-theming', name: 'Admin & Theming' },
  { slug: '2026-07-08-analytics', name: 'Analytics & Leaderboards' },
  { slug: '2026-07-08-feedback-management', name: 'Feedback Management' },
  { slug: '2026-07-08-project-search-and-budgets', name: 'Project Search & Budgets' },
  {
    // roundup release: split into one chapter per feature section
    slug: '2026-07-08-platform-roundup', name: 'Platform Roundup',
    splitNames: {
      'text-to-speech': 'Text-to-Speech',
      'memory-visibility': 'Memory Visibility',
      'file-sandbox-toggle': 'File Sandbox',
      'skill-sandbox-s3-artifacts': 'Sandbox Artifacts to S3',
      'sandbox-output-truncation': 'Sandbox Output Truncation',
      'exulu-read-api': 'RBAC-Safe Read API',
      'oauth-provider-scoped-tokens': 'OAuth Provider Consent',
      'models-decoupling': 'Model Catalog Decoupling',
      'unattributed-spend-hint': 'Unattributed Spend',
      'vertex-billing-labels': 'Vertex Billing Labels',
      'api-key-scoping': 'API-Key Agent Scoping',
      'also-shipped': 'Also Shipped',
    },
  },
  { slug: '2026-07-07-agentic-retrieval', name: 'Agentic Retrieval' },
  { slug: '2026-07-07-tool-configs', name: 'Tool Configs' },
  { slug: '2026-07-02-shareable-artifacts', name: 'Shareable Artifacts' },
  { slug: '2026-06-22-new-exulu-redesign', name: 'The Exulu Redesign' },
  {
    slug: '2026-06-22-agent-workbench', name: 'The Agent Workbench',
    headline: 'Build an agent on <em>one focused page</em>.',
    lede: 'The redesigned agent editor brings the model, tools, knowledge, safety, and ship-ready API snippets into a single page — no tabs, no wizard, no leaving the page.',
  },
  { slug: '2026-06-22-knowledge-and-cost', name: 'Knowledge & Cost' },
  {
    slug: '2026-06-10-summer-release', name: 'The Summer Drop',
    splitNames: {
      'oauth-tools': 'OAuth for Tools',
      'image-widget': 'In-Chat Image Generation',
      'personal-prompt': 'Personal System Prompt',
      'teams': 'Teams',
    },
  },
  { slug: '2026-05-29-transcription', name: 'Transcription with Speakers' },
  {
    slug: '2026-05-29-spring-platform-release', name: 'The Spring Drop',
    splitNames: {
      'session-files-panel': 'Session Files Panel',
      'followup-suggestions': 'Follow-up Suggestions',
      'litellm-proxy': 'LiteLLM Proxy',
      'skill-bundle-upload': 'Skill Bundle Upload',
      'gdpr-export-delete': 'GDPR Export & Delete',
    },
  },
  {
    slug: '2026-05-24-speech-to-text', name: 'Speech-to-Text',
    headline: 'Speak instead of <em>type</em>.',
  },
];

const MONTHS = [
  {
    key: '2026-07', label: 'July 2026',
    blurb: 'Connect your coding agent to the skills library — plus projects, routines, evals, and the July 8 platform drop, feature by feature.',
  },
  {
    key: '2026-06', label: 'June 2026',
    blurb: 'A calmer Exulu: the full redesign, the agent workbench, knowledge that knows what it costs — and the four features of the summer drop.',
  },
  {
    key: '2026-05', label: 'May 2026',
    blurb: 'Where this run started: voice in the chat, transcripts that know who is talking, and the spring drop split into its five features.',
  },
];

const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const prettyDate = (iso) => {
  const [y, m, d] = iso.split('-').map(Number);
  return `${MONTH_NAMES[m - 1]} ${d}, ${y}`;
};
const shortDate = (iso) => {
  const [, m, d] = iso.split('-').map(Number);
  return `${MONTH_NAMES[m - 1].slice(0, 3)} ${d}`;
};
const shortId = (slug) => 'r-' + slug.slice(11);

// sanity: every extracted release is in ORDER, and vice versa; every release
// falls under a MONTHS group (otherwise it silently vanishes from nav + body)
for (const r of releases) if (!ORDER.find((o) => o.slug === r.slug)) warnings.push(`NOT IN ORDER: ${r.slug}`);
for (const o of ORDER) if (!bySlug[o.slug]) warnings.push(`MISSING RELEASE: ${o.slug}`);
for (const o of ORDER) if (!MONTHS.find((m) => o.slug.startsWith(m.key))) warnings.push(`NO MONTH GROUP FOR: ${o.slug}`);

// ---------------------------------------------------------------- display list
// Roundup releases (splitNames) expand into one chapter per feature section,
// so every chapter on the page represents exactly one feature.
const DISPLAY = ORDER.flatMap((entry) => {
  if (!entry.splitNames) return [entry];
  const r = bySlug[entry.slug];
  if (!r) return [];
  return r.sections.map((s, i) => {
    const name = entry.splitNames[s.id];
    if (!name) warnings.push(`SPLIT NAME MISSING for ${entry.slug} section "${s.id}"`);
    return { slug: entry.slug, name: name || s.id, origin: entry.name, section: i, sectionId: s.id };
  });
});
const chapterId = (e) => (e.section != null ? 'r-' + e.sectionId : shortId(e.slug));
// cross-links that pointed at a roundup chapter now land on its first feature
const SPLIT_ALIAS = Object.fromEntries(
  ORDER.filter((e) => e.splitNames)
    .map((e) => [shortId(e.slug), chapterId(DISPLAY.find((d) => d.slug === e.slug))])
);
{
  const seen = new Set();
  for (const d of DISPLAY) {
    const id = chapterId(d);
    if (seen.has(id)) warnings.push(`DUPLICATE CHAPTER ID: ${id}`);
    seen.add(id);
  }
}

// ---------------------------------------------------------------- assets
const b64 = (path) => readFileSync(path).toString('base64');

// Fonts come from the new website's own files (exulu-website/web) so the page
// renders identically to the site CI. Inter + JetBrains Mono are embedded only
// because legacy inline styles inside the release content still reference them.
const WEBSITE = '/Users/daniel.claessen/Desktop/Projects/exulu/exulu-website/web';
const FONT_DIR = join(WEBSITE, 'public', 'fonts');
const fontFaces = [
  ['Aspekta', 400, 'inter-tight-400.woff2'],
  ['Aspekta', 500, 'inter-tight-500.woff2'],
  ['RobotoMono', 400, 'roboto-mono-400.woff2'],
  ['Inter', 400, 'inter-regular.woff2'],
  ['JetBrains Mono', 400, 'jetbrains-mono-regular.woff2'],
].map(([family, weight, file]) =>
  `@font-face{font-family:'${family}';font-style:normal;font-weight:${weight};font-display:swap;src:url(data:font/woff2;base64,${b64(join(FONT_DIR, file))}) format('woff2')}`
).join('\n');

// New-CI wordmark, inlined from the website's Wordmark.tsx (currentColor fill).
const logoSvg = `<svg class="logo-svg" viewBox="0 0 325 86" role="img" aria-label="Exulu" fill="currentColor"><g transform="translate(-45,-36)"><path d="M137.459 81.821C137.905 86.1972 138.678 88.4392 140.791 91.2467C144.123 95.8451 149.008 98.316 154.566 98.316C160.897 98.316 166.895 94.8352 169.894 89.4491L177.338 92.2566C173.119 100.895 164.342 106.173 154.566 106.173C139.351 106.173 128.462 94.9497 128.462 79.2424C128.462 63.5352 139.238 51.9752 154.233 51.9752C169.227 51.9752 180.223 63.3063 180.223 78.4547C180.223 79.128 180.223 80.5889 180.11 81.821H137.459ZM171.226 75.5395C170.893 71.4999 170.114 69.2579 168.341 66.6726C165.122 62.2964 159.897 59.6033 154.233 59.6033C148.568 59.6033 143.457 62.2964 140.458 66.787C138.905 69.2579 138.238 71.3854 137.572 75.5395H171.226Z"/><path d="M194.885 104.934H184.555L201.322 82.1173C202.582 80.4072 202.575 78.0642 201.322 76.3608L184.229 53.2006H194.891L208.933 72.7925C211.685 76.6302 211.672 81.8278 208.893 85.6519L194.891 104.934H194.885Z"/><path d="M229.912 104.934L215.91 85.6519C213.131 81.8278 213.118 76.6302 215.87 72.7925L229.912 53.2006H240.575L223.481 76.3608C222.221 78.0709 222.221 80.4072 223.481 82.1173L240.248 104.934H229.919H229.912Z"/><path d="M304.678 104.934V37.5H313.122V104.934H304.678Z"/><path d="M100.732 65.5213L82.3322 46.9324C79.8531 44.4346 78.4603 41.0414 78.4603 37.5H69.1836C69.1836 43.5257 71.5561 49.3023 75.7746 53.5641L84.7846 62.6666C85.4244 63.3129 84.718 64.3834 83.8783 64.0333L52.6696 50.9787C51.2501 53.7391 50.0373 56.6207 49.0443 59.61L80.3262 72.6982C81.1659 73.0483 80.9194 74.3141 80.0064 74.3141H46.0987C45.9854 75.8626 45.9254 77.4246 45.9254 79C45.9254 80.5754 45.9854 82.1374 46.0987 83.6859H80.0064C80.9127 83.6859 81.1659 84.9517 80.3262 85.3018L49.0443 98.39C50.0373 101.379 51.2501 104.261 52.6696 107.021L83.8783 93.9667C84.718 93.6166 85.4244 94.6871 84.7846 95.3334L75.7746 104.436C71.5561 108.698 69.1903 114.474 69.1903 120.5H78.4669C78.4669 116.959 79.8597 113.565 82.3388 111.061L100.739 92.472C104.417 88.7556 106.257 83.8744 106.257 79C106.257 74.1188 104.417 69.2377 100.739 65.528L100.732 65.5213Z"/><path d="M282.579 53.2073V86.3117C282.579 90.3513 281.913 92.5932 280.247 94.613C278.248 97.0839 273.469 98.5382 269.917 98.5382C266.365 98.5382 261.587 97.0772 259.588 94.613C257.922 92.5932 257.255 90.3513 257.255 86.3117V53.2073H248.705V86.3117C248.705 93.3809 250.038 97.3061 253.816 100.787C257.595 104.268 264.259 106.173 269.924 106.173C275.589 106.173 282.253 104.268 286.031 100.787C289.81 97.3061 291.143 93.3809 291.143 86.3117V53.2073H282.593H282.579Z"/><path d="M360.511 53.2073V86.3117C360.511 90.3513 359.845 92.5932 358.179 94.613C356.179 97.0839 351.401 98.5382 347.849 98.5382C344.297 98.5382 339.519 97.0772 337.519 94.613C335.853 92.5932 335.187 90.3513 335.187 86.3117V53.2073H326.637V86.3117C326.637 93.3809 327.97 97.3061 331.748 100.787C335.527 104.268 342.191 106.173 347.856 106.173C353.52 106.173 360.185 104.268 363.963 100.787C367.742 97.3061 369.075 93.3809 369.075 86.3117V53.2073H360.524H360.511Z"/></g></svg>`;

// videos
const ENC_DIR = join(__dirname, 'enc');
const encFiles = new Set(readdirSync(ENC_DIR).filter((f) => f.endsWith('.mp4')));
const usedVideos = new Map(); // key -> base64

// ---------------------------------------------------------------- content transforms
function rewriteCrossLinks(html, slug) {
  // Source pages link to sibling releases (../<slug>/index.html) — in the
  // single-file page those become in-page chapter anchors.
  return html.replace(/href="\.\.\/(2026-[0-9-]+-[a-z-]+)\/(?:index\.html)?"/g, (m, target) => {
    if (!bySlug[target]) { warnings.push(`CROSS-LINK TO UNKNOWN RELEASE in ${slug}: ${target}`); return m; }
    const id = shortId(target);
    return `href="#${SPLIT_ALIAS[id] || id}"`;
  }).replace(/<a href="#">([^<]*)<\/a>/g, '<strong>$1</strong>'); // stub links from source pages
}

function transformSectionHtml(html, slug) {
  html = rewriteCrossLinks(html, slug);
  // Replace each <video src="./shorts/X.mp4" ...> with a hydratable figure.
  // Source closing tags are stripped FIRST so the emitted </video> survives
  // (the button must be a sibling of the video, not fallback content).
  return html.replace(/<\/video>/g, '').replace(/<video\b[^>]*>/g, (tag) => {
    const src = tag.match(/data-short="([^"]+)"/)?.[1] || tag.match(/src="\.\/shorts\/([^"]+)"/)?.[1];
    if (!src) { warnings.push(`VIDEO WITHOUT SRC in ${slug}`); return ''; }
    const key = `${slug}__${src}`;
    if (!encFiles.has(key)) { warnings.push(`NO ENCODED FILE: ${key}`); return ''; }
    if (!usedVideos.has(key)) usedVideos.set(key, b64(join(ENC_DIR, key)));
    return `<figure class="demo"><video data-vid="${key}" muted playsinline loop preload="none"></video>` +
      `<button class="vbtn" type="button" aria-label="Pause video" hidden></button></figure>`;
  });
}

function renderChapter(entry, index, total) {
  const r = bySlug[entry.slug];
  const num = String(total - index).padStart(2, '0');
  const isWorkbench = entry.slug === '2026-06-22-agent-workbench';
  const id = chapterId(entry);

  let headline, lede, body, kicker;
  if (entry.section != null) {
    // split roundup: this chapter is a single feature section
    const s = r.sections[entry.section];
    kicker = entry.origin;
    headline = s.heading || entry.name;
    lede = s.oneLiner ? `<p class="ch-lede">${s.oneLiner}</p>` : '';
    const inner = s.html
      .replace(/<h2>[\s\S]*?<\/h2>\s*/, '')
      .replace(/<p class="one-liner">[\s\S]*?<\/p>\s*/, '');
    body = `<section class="feature">${transformSectionHtml(inner, entry.slug)}</section>`;
  } else {
    kicker = entry.name;
    headline = entry.headline || r.heroHtml || entry.name;
    const ledeHtml = entry.lede || (r.ledeHtml ? rewriteCrossLinks(r.ledeHtml, entry.slug) : '');
    lede = ledeHtml ? `<p class="ch-lede">${ledeHtml}</p>` : '';
    if (isWorkbench) {
      body = readFileSync(join(__dirname, 'agent-workbench-exulu.html'), 'utf8');
    } else {
      body = r.sections.map((s) => {
        const sid = s.id ? ` id="${id}--${s.id}"` : '';
        return `<section class="feature"${sid}>${transformSectionHtml(s.html, entry.slug)}</section>`;
      }).join('\n');
    }
  }

  return `
<article class="chapter" id="${id}" data-release="${entry.slug}" aria-labelledby="${id}-h">
  <header class="ch-head">
    <div class="ch-meta">
      <span class="ch-num" aria-hidden="true">${num}</span>
      <span class="pill">${prettyDate(r.date)}</span>
      <span class="ch-name">${kicker}</span>
    </div>
    <h1 class="ch-title" id="${id}-h">${headline}</h1>
    ${lede}
  </header>
  ${body}
</article>`;
}

// ---------------------------------------------------------------- scoped css
const scopedCss = ORDER
  .filter((e) => e.slug !== '2026-06-22-agent-workbench')
  .map((e) => {
    let css = bySlug[e.slug]?.scopedCss?.trim();
    // New CI: remap hardcoded purple hues from the source pages (~hue 258)
    // to the lime-family accent (hue 86), preserving saturation/lightness.
    if (css) css = css.replace(/hsl\((?:257\.94|257\.9412|258)(?=[\s,])/g, 'hsl(86');
    return css ? `[data-release="${e.slug}"] {\n${css}\n}` : '';
  })
  .filter(Boolean)
  .join('\n\n');

// ---------------------------------------------------------------- sidebar + months
function navMarkup() {
  return MONTHS.map((m) => {
    const items = DISPLAY.filter((e) => e.slug.startsWith(m.key));
    return `<div class="nav-group">
  <div class="nav-month">${m.label}</div>
  ${items.map((e) => `<a class="nav-link" href="#${chapterId(e)}" data-chapter="${chapterId(e)}"><span class="nl-name">${e.name}</span><span class="nl-date">${shortDate(bySlug[e.slug].date)}</span></a>`).join('\n  ')}
</div>`;
  }).join('\n');
}

function chaptersMarkup() {
  const total = DISPLAY.length;
  let out = '';
  let i = 0;
  for (const m of MONTHS) {
    const items = DISPLAY.filter((e) => e.slug.startsWith(m.key));
    out += `\n<div class="month"><span class="month-kicker">Chapter</span><h2 class="month-title">${m.label}</h2><p class="month-blurb">${m.blurb}</p></div>\n`;
    for (const e of items) { out += renderChapter(e, i, total); i++; }
  }
  return out;
}

const chaptersHtml = chaptersMarkup(); // NOTE: populates usedVideos — must run before stats
const featureCount = releases.reduce((a, r) => a + r.sections.length, 0) + 9; // +9 workbench cards
const stats = {
  chapters: DISPLAY.length,
  demos: usedVideos.size,
  improvements: `${Math.floor(featureCount / 10) * 10}+`,
};

// ---------------------------------------------------------------- master css
const MASTER_CSS = readFileSync(join(__dirname, 'master.css'), 'utf8');

// ---------------------------------------------------------------- runtime js
const RUNTIME_JS = String.raw`
(function () {
  'use strict';
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ---- video store: base64 -> blob URL, hydrated lazily -------------------
  var vdataEl = document.getElementById('vdata');
  var VDATA = JSON.parse(vdataEl.textContent);
  vdataEl.textContent = ''; // release the ~19MB DOM text node
  var urls = {};
  function urlFor(key) {
    if (urls[key]) return urls[key];
    var b64 = VDATA[key];
    if (!b64) return null;
    var bin = atob(b64), bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    urls[key] = URL.createObjectURL(new Blob([bytes], { type: 'video/mp4' }));
    delete VDATA[key]; // release the base64 string
    return urls[key];
  }

  var vids = Array.prototype.slice.call(document.querySelectorAll('video[data-vid]'));
  var playIcon = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>';
  var pauseIcon = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>';

  vids.forEach(function (v) {
    var btn = v.parentElement.querySelector('.vbtn');
    if (!btn) return;
    btn.innerHTML = pauseIcon;
    btn.addEventListener('click', function () {
      if (v.paused) { v.play().catch(function () {}); v.dataset.userPaused = ''; }
      else { v.pause(); v.dataset.userPaused = '1'; }
    });
    v.addEventListener('play', function () { btn.innerHTML = pauseIcon; btn.setAttribute('aria-label', 'Pause video'); btn.hidden = false; });
    v.addEventListener('pause', function () { btn.innerHTML = playIcon; btn.setAttribute('aria-label', 'Play video'); btn.hidden = false; });
  });

  function hydrate(v) {
    if (v.dataset.ready) return;
    var u = urlFor(v.dataset.vid);
    if (!u) return;
    v.muted = true;
    v.src = u;
    v.dataset.ready = '1';
    if (reduce) { v.controls = true; v.preload = 'metadata'; }
  }

  if ('IntersectionObserver' in window) {
    var loadIO = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) { hydrate(e.target); loadIO.unobserve(e.target); }
      });
    }, { rootMargin: '900px 0px' });
    var playIO = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        var v = e.target;
        if (reduce) return;
        if (e.isIntersecting && e.intersectionRatio >= 0.25) {
          hydrate(v);
          if (!('userPaused' in v.dataset) || v.dataset.userPaused !== '1') v.play().catch(function () {});
        } else { if (!v.paused) v.pause(); }
      });
    }, { threshold: [0, 0.25] });
    vids.forEach(function (v) { loadIO.observe(v); playIO.observe(v); });
  } else {
    vids.forEach(function (v) { hydrate(v); if (!reduce) v.autoplay = true; });
  }
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) vids.forEach(function (v) { if (!v.paused) { v.pause(); v.dataset.autoPaused = '1'; } });
    else vids.forEach(function (v) { if (v.dataset.autoPaused === '1') { delete v.dataset.autoPaused; v.play().catch(function () {}); } });
  });

  // ---- reveal on scroll ----------------------------------------------------
  var rvs = Array.prototype.slice.call(document.querySelectorAll('.rv, .feature'));
  rvs.forEach(function (el) { el.classList.add('rv'); });
  if (!reduce && 'IntersectionObserver' in window) {
    var rvIO = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) { e.target.classList.add('in'); rvIO.unobserve(e.target); }
      });
    }, { threshold: 0.06, rootMargin: '0px 0px -6% 0px' });
    rvs.forEach(function (el) { rvIO.observe(el); });
  } else {
    rvs.forEach(function (el) { el.classList.add('in'); });
  }

  // ---- scroll-spy ----------------------------------------------------------
  var links = Array.prototype.slice.call(document.querySelectorAll('.nav-link'));
  var byId = {};
  links.forEach(function (l) { byId[l.dataset.chapter] = l; });
  var tbCurrent = document.getElementById('tb-current');
  var current = null;
  function setActive(id) {
    if (id === current) return;
    current = id;
    links.forEach(function (l) {
      var on = l.dataset.chapter === id;
      l.classList.toggle('active', on);
      if (on) { l.setAttribute('aria-current', 'true'); } else { l.removeAttribute('aria-current'); }
    });
    var link = byId[id];
    if (link) {
      if (tbCurrent) tbCurrent.textContent = link.querySelector('.nl-name').textContent;
      var sc = link.closest('.nav-scroll');
      if (sc) {
        var lr = link.getBoundingClientRect(), sr = sc.getBoundingClientRect();
        if (lr.top < sr.top + 40 || lr.bottom > sr.bottom - 40) link.scrollIntoView({ block: 'center', behavior: reduce ? 'auto' : 'smooth' });
      }
    } else if (tbCurrent) { tbCurrent.textContent = ''; }
  }
  var chapters = Array.prototype.slice.call(document.querySelectorAll('.chapter'));
  if ('IntersectionObserver' in window) {
    var visible = {};
    var spyIO = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) { visible[e.target.id] = e.isIntersecting; });
      for (var i = chapters.length - 1; i >= 0; i--) {
        if (visible[chapters[i].id]) { setActive(chapters[i].id); return; }
      }
      setActive(null);
    }, { rootMargin: '-35% 0px -55% 0px' });
    chapters.forEach(function (c) { spyIO.observe(c); });
  }

  // ---- drawer --------------------------------------------------------------
  var burger = document.getElementById('burger');
  var scrim = document.getElementById('scrim');
  function navOpen() { return document.body.classList.contains('nav-open'); }
  function setNav(open) {
    document.body.classList.toggle('nav-open', open);
    burger.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) {
      var first = document.querySelector('.nav-link.active') || document.querySelector('.nav-link');
      if (first) first.focus();
    } else { burger.focus(); }
  }
  burger.addEventListener('click', function () { setNav(!navOpen()); });
  scrim.addEventListener('click', function () { setNav(false); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && navOpen()) setNav(false); });
  links.forEach(function (l) {
    l.addEventListener('click', function () { if (navOpen()) { document.body.classList.remove('nav-open'); burger.setAttribute('aria-expanded', 'false'); } });
  });

  // ---- progress bar ----------------------------------------------------------
  var bar = document.getElementById('progress');
  var ticking = false;
  function onScroll() {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(function () {
      var h = document.documentElement;
      var max = h.scrollHeight - h.clientHeight;
      bar.style.transform = 'scaleX(' + (max > 0 ? h.scrollTop / max : 0) + ')';
      ticking = false;
    });
  }
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  // ---- copy buttons on code blocks -------------------------------------------
  var copySvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>';
  Array.prototype.slice.call(document.querySelectorAll('.chapter pre')).forEach(function (pre) {
    if (pre.closest('.codepane') || pre.closest('.codeblk')) return;
    var wrap = document.createElement('div');
    wrap.className = 'codewrap';
    pre.parentNode.insertBefore(wrap, pre);
    wrap.appendChild(pre);
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'copy';
    btn.innerHTML = copySvg + '<span>Copy</span>';
    btn.addEventListener('click', function () {
      function done() {
        btn.classList.add('ok');
        btn.querySelector('span').textContent = 'Copied';
        setTimeout(function () { btn.classList.remove('ok'); btn.querySelector('span').textContent = 'Copy'; }, 1600);
      }
      function fallback() {
        var ta = document.createElement('textarea');
        ta.value = pre.innerText;
        ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.select();
        try { document.execCommand('copy'); done(); } catch (e) {}
        document.body.removeChild(ta);
      }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(pre.innerText).then(done, fallback);
      } else { fallback(); }
    });
    wrap.appendChild(btn);
  });
})();
`;

// ---------------------------------------------------------------- page
const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Exulu — Releases</title>
<meta name="description" content="Everything we shipped in Exulu — ${stats.chapters} features with live demos, chaptered from May to July 2026." />
<style>
${fontFaces}
</style>
<style>
${MASTER_CSS}
/* ============ per-release scoped styles (ported from source pages) ======= */
${scopedCss}
</style>
<noscript><style>.rv, .feature { opacity: 1 !important; transform: none !important; } .vbtn, .scroll-cue { display: none !important; }</style></noscript>
</head>
<body>
<a class="skip" href="#content">Skip to content</a>
<div id="progress" role="presentation"></div>

<header class="topbar">
  <span class="brand">${logoSvg}</span>
  <span id="tb-current"></span>
  <button id="burger" class="burger" type="button" aria-label="Open navigation" aria-expanded="false" aria-controls="sidenav">
    <svg class="bars" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 7h16M4 12h16M4 17h16"/></svg>
    <svg class="x" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>
  </button>
</header>

<aside class="sidebar" id="sidenav" aria-label="Releases">
  <div class="brand">${logoSvg}<span class="brand-tag">Releases</span></div>
  <p class="side-title">The changelog.</p>
  <p class="side-sub">Every feature we shipped — newest first.</p>
  <nav class="nav-scroll" aria-label="Jump to release">
${navMarkup()}
  </nav>
  <div class="side-foot">
    <span>${stats.chapters} features · ${stats.demos} demos</span>
    <a href="https://docs.exulu.com">Docs →</a>
  </div>
</aside>
<div class="scrim" id="scrim" role="presentation"></div>

<main id="content">
  <section class="intro">
    <div class="intro-bg" aria-hidden="true"></div>
    <div class="col intro-inner">
      <span class="pill">Exulu · Release Notes · 2026</span>
      <h1>Everything we <em>shipped</em>.</h1>
      <p class="lede">Three months of Exulu, chaptered. Projects, routines, evals, a full redesign — every feature below is the real product, demoed in motion, with the API calls to match.</p>
      <div class="meta-chips">
        <span class="chip"><b>${stats.chapters}</b> features</span>
        <span class="chip"><b>${stats.improvements}</b> improvements</span>
        <span class="chip"><b>${stats.demos}</b> live demos</span>
        <span class="chip"><b>May → July</b> 2026</span>
      </div>
      <noscript><p style="margin-top:22px;font-size:14px;color:hsl(var(--muted-foreground))">The embedded demo videos need JavaScript — enable it to see every feature in motion.</p></noscript>
    </div>
    <div class="scroll-cue" aria-hidden="true">Scroll
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 4v16m0 0l-6-6m6 6l6-6"/></svg>
    </div>
  </section>

  <div class="col">
${chaptersHtml}

    <footer class="foot">
      <p class="sign">Onward<em>.</em></p>
      <p>That's three months of Exulu. The next chapter is already in progress — and everything you just read is live in your workspace today.</p>
      <div class="foot-meta">
        <span class="brand">${logoSvg}</span>
        <span>Releases · May – July 2026 · <a href="https://docs.exulu.com">docs.exulu.com</a></span>
      </div>
    </footer>
  </div>
</main>

<script id="vdata" type="application/json">${JSON.stringify(Object.fromEntries(usedVideos))}</script>
<script>
${RUNTIME_JS}
</script>
</body>
</html>
`;

writeFileSync(OUT, page);

const mb = (n) => (n / 1024 / 1024).toFixed(1) + ' MB';
console.log(`releases.html written: ${mb(Buffer.byteLength(page))}`);
console.log(`chapters: ${DISPLAY.length} (from ${ORDER.length} releases), videos embedded: ${usedVideos.size}, feature sections: ${featureCount}`);
if (warnings.length) { console.log('\nWARNINGS:'); warnings.forEach((w) => console.log(' - ' + w)); }
else console.log('no warnings');
