import JSZip from "jszip";

/** Parse a leading --- fenced block of simple `key: value` scalar lines. */
export function parseFrontmatter(md: string): Record<string, string> {
  const match = /^﻿?---\r?\n([\s\S]*?)\r?\n---/.exec(md);
  if (!match) return {};
  const block = match[1]!;
  const out: Record<string, string> = {};
  for (const line of block.split(/\r?\n/)) {
    const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1]!;
    let v = m[2]!.trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[key] = v;
  }
  return out;
}

/** Locate the post-unwrap-root SKILL.md inside a zip buffer and read its meta. */
export async function parseSkillFrontmatter(
  zipBytes: Buffer,
): Promise<{ name?: string; description?: string }> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(zipBytes);
  } catch {
    return {};
  }
  const paths: string[] = [];
  zip.forEach((p, entry) => {
    if (!entry.dir) paths.push(p);
  });
  const heads = new Set(paths.map((p) => p.split("/")[0]).filter(Boolean));
  let strip = (p: string) => p;
  if (heads.size === 1) {
    const head = [...heads][0] + "/";
    if (paths.every((p) => p.startsWith(head))) strip = (p) => p.slice(head.length);
  }
  const skillPath = paths.find((p) => strip(p) === "SKILL.md");
  if (!skillPath) return {};
  const md = await zip.file(skillPath)!.async("string");
  const fm = parseFrontmatter(md);
  return { name: fm.name, description: fm.description };
}
