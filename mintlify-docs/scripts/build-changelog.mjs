// Generates changelog/index.mdx from the release pipeline's structured output.
// Full-content version: converts each release section's HTML (paragraphs, code
// snippets, notes, lists) to MDX and embeds the demo shorts copied into
// images/changelog/ (<slug>__<video>.mp4 + .jpg poster).
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BACKEND = join(ROOT, "..");
const SRC = process.env.RELEASES_JSON ?? join(BACKEND, "releases", "_build", "releases.json");
const MEDIA_DIR = join(ROOT, "images", "changelog");
const releases = JSON.parse(readFileSync(SRC, "utf8"));

const require = createRequire(join(BACKEND, "package.json"));
const parse5 = require("parse5");

const warnings = [];

const fmtDate = (iso) => new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
// Rename the product in prose, but never inside technical identifiers like @exulu/backend
// or exulu.com — and NEVER inside code (inline or blocks), where env vars and API paths
// keep the EXULU_ prefix.
const rename = (s = "") => s.replace(/(@exulu\/|exulu\.com)|exulu/gi, (m, ident) => ident ?? "IMP");
const clean = (s = "") => rename(s).replace(/\s+/g, " ").trim();
const releaseName = (slug) => { const s = clean(slug.slice(11).replace(/-/g, " ")); return s.charAt(0).toUpperCase() + s.slice(1); };

// ---------- parse5 helpers ----------
const isEl = (n) => n && n.tagName;
const attr = (n, name) => (n.attrs || []).find((a) => a.name === name)?.value;
const hasClass = (n, c) => (attr(n, "class") || "").split(/\s+/).includes(c);
const rawText = (n) => {
  let out = "";
  const walk = (x) => {
    if (x.nodeName === "#text") out += x.value;
    for (const c of x.childNodes || []) walk(c);
  };
  walk(n);
  return out;
};

// Escape plain prose for MDX: `{` opens an expression, `<` opens JSX.
const mdxEscape = (s) => s.replace(/\{/g, "\\{").replace(/</g, "\\<");

// Inline conversion for prose nodes (p, li, note bodies).
// Text runs are renamed (Exulu -> IMP) and MDX-escaped; code spans stay verbatim.
function inline(node) {
  let out = "";
  for (const c of node.childNodes || []) {
    if (c.nodeName === "#text") { out += mdxEscape(rename(c.value.replace(/\s+/g, " "))); continue; }
    if (!isEl(c)) continue;
    switch (c.tagName) {
      case "code": out += "`" + rawText(c).replace(/\s+/g, " ").trim() + "`"; break;
      case "strong": case "b": out += `**${inline(c).trim()}**`; break;
      case "em": case "i": out += `_${inline(c).trim()}_`; break;
      case "a": {
        const href = attr(c, "href") || "";
        const text = inline(c).trim();
        out += /^https?:\/\//.test(href) ? `[${text}](${href})` : `**${text}**`;
        break;
      }
      case "br": out += " "; break;
      default: out += inline(c);
    }
  }
  return out;
}
const proseLine = (node) => inline(node).replace(/[ \t]+/g, " ").trim();

function codeLang(label, content) {
  if (/sdk|typescript/i.test(label)) return "typescript";
  if (/graphql/i.test(label)) return "graphql";
  if (/rest|curl|cli|terminal|command/i.test(label)) return "bash";
  if (/json|payload|config/i.test(label)) return "json";
  if (/variable/i.test(label)) return "text";
  const c = content.trimStart();
  if (/^(curl|\$|#|exulu |npx |npm )/m.test(c)) return "bash";
  if (/^(query|mutation|fragment)\b/.test(c)) return "graphql";
  if (/^[[{]/.test(c)) return "json";
  if (/\b(const|await|import|=>)\b/.test(c)) return "typescript";
  return "text";
}

function videoEmbed(slug, tag) {
  const src = attr(tag, "data-short") || (attr(tag, "src") || "").replace(/^\.\/shorts\//, "");
  if (!src) return "";
  const key = `${slug}__${src}`;
  if (!existsSync(join(MEDIA_DIR, key))) { warnings.push(`missing video: ${key}`); return ""; }
  const poster = existsSync(join(MEDIA_DIR, key.replace(/\.mp4$/, ".jpg")))
    ? ` poster="/images/changelog/${key.replace(/\.mp4$/, ".jpg")}"`
    : "";
  return `<video controls muted playsInline preload="none"${poster} src="/images/changelog/${key}" className="w-full rounded-lg" />`;
}

// Convert one feature section's HTML to MDX blocks (heading + one-liner are
// emitted by the caller and skipped here).
function sectionBody(html, slug) {
  const frag = parse5.parseFragment(html);
  const blocks = [];
  let pendingLabel = null;
  let skippedH2 = false, skippedOneLiner = false;

  const visit = (n) => {
    if (!isEl(n)) return;
    if (n.tagName === "h2" && !skippedH2) { skippedH2 = true; return; }
    if (n.tagName === "p" && hasClass(n, "one-liner") && !skippedOneLiner) { skippedOneLiner = true; return; }
    if (n.tagName === "video") { blocks.push(videoEmbed(slug, n)); return; }
    if (n.tagName === "figure") { for (const c of n.childNodes || []) if (isEl(c) && c.tagName === "video") blocks.push(videoEmbed(slug, c)); return; }
    if (n.tagName === "div" && hasClass(n, "snippet-label")) { pendingLabel = rawText(n).trim(); return; }
    if (n.tagName === "pre") {
      const content = rawText(n).replace(/\s+$/, "");
      const lang = codeLang(pendingLabel || "", content);
      const title = pendingLabel ? ` ${pendingLabel}` : "";
      pendingLabel = null;
      blocks.push("```" + lang + title + "\n" + content + "\n```");
      return;
    }
    if (n.tagName === "div" && (hasClass(n, "flag-note") || hasClass(n, "fineprint"))) {
      const body = proseLine(n);
      if (body) blocks.push(`<Note>${body}</Note>`);
      return;
    }
    if (n.tagName === "p") { const t = proseLine(n); if (t) blocks.push(t); return; }
    if (n.tagName === "ul" || n.tagName === "ol") {
      const marker = n.tagName === "ol" ? "1." : "-";
      const items = (n.childNodes || []).filter((c) => isEl(c) && c.tagName === "li").map((li) => `${marker} ${proseLine(li)}`);
      if (items.length) blocks.push(items.join("\n"));
      return;
    }
    if (/^h[3-6]$/.test(n.tagName)) { const t = clean(rawText(n)); if (t) blocks.push(`#### ${mdxEscape(t)}`); return; }
    if (n.tagName === "button" || n.tagName === "style" || n.tagName === "script") return;
    for (const c of n.childNodes || []) visit(c); // generic containers (div.slice, section)
  };
  for (const c of frag.childNodes || []) visit(c);
  return blocks.filter(Boolean).join("\n\n");
}

const stripTags = (s = "") => s.replace(/<[^>]+>/g, "");

const updates = [...releases]
  .sort((a, b) => (a.date < b.date ? 1 : -1))
  .map((r) => {
    let body;
    if ((r.sections ?? []).length) {
      body = r.sections
        .map((s) => {
          const heading = mdxEscape(clean(stripTags(s.heading ?? "")));
          const oneLiner = mdxEscape(clean(stripTags(s.oneLiner ?? "")));
          const rest = sectionBody(s.html ?? "", r.slug);
          return [`### ${heading}`, oneLiner, rest].filter(Boolean).join("\n\n");
        })
        .join("\n\n");
    } else {
      // releases with no extractable sections (hand-ported pages): fall back to the lede
      body = mdxEscape(clean(stripTags(r.ledeHtml ?? r.heroText ?? "")));
    }
    const desc = releaseName(r.slug).replace(/"/g, "&quot;");
    return `<Update label="${fmtDate(r.date)}" description="${desc}">\n\n${body}\n\n</Update>`;
  })
  .join("\n\n");

writeFileSync(join(ROOT, "changelog", "index.mdx"),
`---
title: "Changelog"
description: "What shipped in IMP, release by release."
mode: "wide"
---

{/* GENERATED by scripts/build-changelog.mjs — do not hand-edit. */}

${updates}
`);
for (const w of warnings) console.warn(`WARN: ${w}`);
console.log(`changelog/index.mdx written — ${releases.length} releases${warnings.length ? `, ${warnings.length} warnings` : ""}`);
