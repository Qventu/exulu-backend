// Extract structured content from every release page into releases.json.
// Uses parse5 from the backend's node_modules for real HTML parsing.
import { createRequire } from 'node:module';
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RELEASES_DIR = join(__dirname, '..');
const require = createRequire(join(RELEASES_DIR, '..', 'package.json'));
const parse5 = require('parse5');

// ---------- tiny DOM helpers over the parse5 tree ----------
const isEl = (n) => n && n.tagName;
const attr = (n, name) => (n.attrs || []).find((a) => a.name === name)?.value;
const hasClass = (n, c) => (attr(n, 'class') || '').split(/\s+/).includes(c);

function* walk(node) {
  yield node;
  for (const child of node.childNodes || []) yield* walk(child);
}
const find = (root, pred) => {
  for (const n of walk(root)) if (isEl(n) && pred(n)) return n;
  return null;
};
const findAll = (root, pred) => {
  const out = [];
  for (const n of walk(root)) if (isEl(n) && pred(n)) out.push(n);
  return out;
};
const innerHTML = (n) => parse5.serialize(n);
const text = (n) => {
  let out = '';
  for (const c of walk(n)) if (c.nodeName === '#text') out += c.value;
  return out.replace(/\s+/g, ' ').trim();
};

// ---------- naive CSS rule splitter (handles one level of @media nesting) ----------
function splitCssRules(css) {
  // strip comments
  css = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [];
  let depth = 0, start = 0;
  for (let i = 0; i < css.length; i++) {
    const ch = css[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        rules.push(css.slice(start, i + 1).trim());
        start = i + 1;
      }
    }
  }
  return rules.filter(Boolean);
}

// Selectors owned by the master page chrome — drop these rules from per-release CSS.
const CHROME_SELECTOR = /^\s*(\*|html|body|:root|\.wrap|header(\s|$|\{)|footer|h1(\.hero)?|h1\s|\.pill|\.lede|\.hero|\.feature(\s*h2|\s*\.one-liner|\s*pre|\s*\.snippet-label)?|\.slice(\s+(video|p|ul|li(\s+strong)?|\.fineprint|p\s+a|li\s+a))?|a)\s*(,|$)/;

function filterReleaseCss(css) {
  const kept = [];
  for (const rule of splitCssRules(css)) {
    if (rule.startsWith('@media')) {
      const m = rule.match(/^(@media[^{]+)\{([\s\S]*)\}$/);
      if (!m) continue;
      const inner = filterReleaseCss(m[2]);
      if (inner.trim()) kept.push(`${m[1].trim()} {\n${inner}\n}`);
      continue;
    }
    if (rule.startsWith('@')) { kept.push(rule); continue; } // @keyframes etc.
    const selector = rule.slice(0, rule.indexOf('{')).trim();
    // Drop a rule only when EVERY selector in the list is chrome-owned.
    const selectors = selector.split(',').map((s) => s.trim());
    const allChrome = selectors.every((s) =>
      /^(\*|html|body|:root)$/.test(s) ||
      /^(\.wrap|footer|header)(\s|$|::|:)/.test(s) || s === 'footer' || s === 'header' || s === '.wrap' ||
      /^h1(\.hero)?( |$|\s)/.test(s) || s === 'h1.hero' || s === 'h1.hero em' || s === 'h1' ||
      s === '.pill' || s === '.lede' || s === '.lede a' ||
      s === '.feature' || s === '.feature h2' || s === '.feature .one-liner' ||
      s === '.feature pre' || s === '.feature .snippet-label' ||
      s === '.slice' || s === '.slice video' || s === '.slice p' || s === '.slice ul' ||
      s === '.slice li' || s === '.slice li strong' || s === '.slice .fineprint' ||
      s === '.slice p a, .slice li a' || s === '.slice p a' || s === '.slice li a' ||
      s === '.one-liner' || s === '.snippet-label' || s === 'pre' || s === 'pre code' || s === 'video'
    );
    if (!allChrome) kept.push(rule);
  }
  return kept.join('\n');
}

// ---------- per-release extraction ----------
const sectionsFrom = (root) =>
  findAll(root, (n) => n.tagName === 'section' && hasClass(n, 'feature')).map((sec) => {
    const h2 = find(sec, (n) => n.tagName === 'h2');
    const oneLiner = find(sec, (n) => hasClass(n, 'one-liner'));
    const videos = findAll(sec, (n) => n.tagName === 'video').map((v) => ({
      // pages with inlined data-URI videos carry the clip name in data-short
      src: attr(v, 'data-short') ? `./shorts/${attr(v, 'data-short')}` : attr(v, 'src'),
      poster: attr(v, 'poster'),
    }));
    return {
      id: attr(sec, 'id') || null,
      heading: h2 ? innerHTML(h2).trim() : null,
      oneLiner: oneLiner ? innerHTML(oneLiner).trim() : null,
      html: innerHTML(sec).trim(),
      videos,
    };
  });

function extractRelease(slug) {
  const file = join(RELEASES_DIR, slug, 'index.html');
  if (!existsSync(file)) return null;
  const html = readFileSync(file, 'utf8');
  const doc = parse5.parse(html);

  const date = slug.slice(0, 10);
  const title = text(find(doc, (n) => n.tagName === 'title') || { childNodes: [] });

  const styleNode = find(doc, (n) => n.tagName === 'style');
  const css = styleNode ? innerHTML(styleNode) : '';

  const pillNode = find(doc, (n) => hasClass(n, 'pill'));
  const heroNode = find(doc, (n) => n.tagName === 'h1');
  const ledeNode = find(doc, (n) => hasClass(n, 'lede'));

  let sections = sectionsFrom(doc);

  // Curated customer-facing copy override: _build/copy/<slug>.html replaces
  // the section bodies, guarded so structure (headings + videos) must match.
  const copyFile = join(__dirname, 'copy', `${slug}.html`);
  let copySource = 'source-page';
  if (existsSync(copyFile)) {
    const frag = parse5.parseFragment(readFileSync(copyFile, 'utf8'));
    const override = sectionsFrom(frag);
    const key = (list, f) => JSON.stringify(list.map(f));
    const headsOk = key(override, (s) => textOf(s.heading)) === key(sections, (s) => textOf(s.heading));
    const vidsOk = key(override, (s) => s.videos.map((v) => v.src)) === key(sections, (s) => s.videos.map((v) => v.src));
    if (override.length === sections.length && headsOk && vidsOk) {
      sections = override;
      copySource = 'copy-override';
    } else {
      console.warn(`COPY OVERRIDE REJECTED for ${slug}: sections ${override.length}/${sections.length}, headings ${headsOk ? 'ok' : 'MISMATCH'}, videos ${vidsOk ? 'ok' : 'MISMATCH'}`);
    }
  }

  const releasedMatch = html.match(/Released ([A-Z][a-z]+ \d+, \d{4})/);

  return {
    slug,
    date,
    title,
    pill: pillNode ? text(pillNode) : null,
    heroHtml: heroNode ? innerHTML(heroNode).trim() : null,
    heroText: heroNode ? text(heroNode) : null,
    ledeHtml: ledeNode ? innerHTML(ledeNode).trim() : null,
    releasedLabel: releasedMatch ? releasedMatch[1] : null,
    scopedCss: filterReleaseCss(css),
    sections,
    copySource,
    videoCount: sections.reduce((a, s) => a + s.videos.length, 0),
  };
}

// normalize heading HTML to comparable text
function textOf(htmlStr) {
  return (htmlStr || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

const slugs = readdirSync(RELEASES_DIR)
  .filter((d) => /^2026-\d{2}-\d{2}-/.test(d))
  .sort();

const releases = slugs.map(extractRelease).filter(Boolean);
writeFileSync(join(__dirname, 'releases.json'), JSON.stringify(releases, null, 2));

for (const r of releases) {
  console.log(
    `${r.slug}: ${r.sections.length} sections, ${r.videoCount} videos, css ${r.scopedCss.length}b, copy=${r.copySource}`
  );
}
console.log(`\n${releases.length} releases extracted.`);
