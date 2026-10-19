/**
 * Skills bundled with the backend, seeded into every instance's skill library
 * at boot — the way the `imp-skills` bootstrap skill ships, but as regular
 * registry entries that the Skills page lists and `imp install` fetches.
 *
 * Source: src/skills/bundled/<name>/** (SKILL.md at the root), embedded by
 * scripts/generate-bundled-skills.ts into bundled.generated.ts.
 *
 * Seeding is idempotent and never clobbers: a skill row that this seeder did
 * not create (no bundled marker in its history) is left alone, even with the
 * same name. A bundled skill whose content hash changed gets a new version.
 */
import JSZip from "jszip";
import { createHash, randomUUID } from "node:crypto";

import type { ExuluConfig } from "../exulu/app/index.ts";
import { extractBundleToVersion } from "./bundle-extractor.ts";
import { BUNDLED_SKILLS } from "./bundled.generated.ts";
import { parseFrontmatter } from "./frontmatter.ts";

export type BundledSkill = { name: string; files: Record<string, string> };

export const BUNDLED_LABEL = "Bundled with the IMP";

export function bundledSkillHash(skill: BundledSkill): string {
  const h = createHash("sha256");
  for (const path of Object.keys(skill.files).sort()) {
    h.update(path).update("\0").update(skill.files[path]!).update("\0");
  }
  return h.digest("hex");
}

export function bundledSkillDescription(skill: BundledSkill): string {
  const md = skill.files["SKILL.md"];
  if (!md) return "";
  return parseFrontmatter(Buffer.from(md, "base64").toString("utf8")).description ?? "";
}

/** The skill as the zip the registry publish route accepts: SKILL.md at the root. */
export async function bundledSkillZip(skill: BundledSkill): Promise<Buffer> {
  const zip = new JSZip();
  for (const [path, b64] of Object.entries(skill.files)) {
    zip.file(path, Buffer.from(b64, "base64"), path.startsWith("scripts/") ? { unixPermissions: 0o755 } : undefined);
  }
  return zip.generateAsync({ type: "nodebuffer", platform: "UNIX" });
}

type HistoryEntry = { version: number; created_at: string; label: string; source?: string; hash?: string };

const bundledMarker = (row: any): HistoryEntry | undefined => {
  const history: HistoryEntry[] = Array.isArray(row?.history) ? row.history : [];
  return [...history].reverse().find((h) => h?.source === "bundled");
};

export type SeedOutcome = { created: string[]; updated: string[]; unchanged: string[]; skipped: string[] };

export async function seedBundledSkills({
  db,
  config,
  skills = BUNDLED_SKILLS,
  log = (line: string) => console.log(`[SKILLS] ${line}`),
}: {
  db: any;
  config: ExuluConfig;
  skills?: ReadonlyArray<BundledSkill>;
  log?: (line: string) => void;
}): Promise<SeedOutcome> {
  const outcome: SeedOutcome = { created: [], updated: [], unchanged: [], skipped: [] };
  if (!config.fileUploads) {
    log("bundled skills not seeded: file uploads are not configured");
    return outcome;
  }
  for (const skill of skills) {
    const hash = bundledSkillHash(skill);
    const now = new Date().toISOString();
    const existing = await db("skills").where({ name: skill.name }).first();
    if (existing) {
      const marker = bundledMarker(existing);
      if (!marker) {
        outcome.skipped.push(skill.name);
        log(`"${skill.name}" exists but was not seeded by the IMP — left untouched`);
        continue;
      }
      if (marker.hash === hash) {
        outcome.unchanged.push(skill.name);
        continue;
      }
      const nextVersion = (existing.current_version ?? 1) + 1;
      await extractBundleToVersion({ bytes: await bundledSkillZip(skill), skillId: existing.id, version: nextVersion, config });
      const history: HistoryEntry[] = Array.isArray(existing.history) ? existing.history : [];
      await db("skills")
        .where({ id: existing.id })
        .update({
          description: bundledSkillDescription(skill),
          current_version: nextVersion,
          updatedAt: now,
          history: JSON.stringify([...history, { version: nextVersion, created_at: now, label: BUNDLED_LABEL, source: "bundled", hash }]),
        });
      outcome.updated.push(skill.name);
      log(`"${skill.name}" updated to v${nextVersion}`);
      continue;
    }
    const skillId = randomUUID();
    await extractBundleToVersion({ bytes: await bundledSkillZip(skill), skillId, version: 1, config });
    await db("skills").insert({
      id: skillId,
      name: skill.name,
      description: bundledSkillDescription(skill),
      s3folder: `skills/${skillId}`,
      tags: JSON.stringify(["bundled"]),
      usage_count: 0,
      favorite_count: 0,
      current_version: 1,
      history: JSON.stringify([{ version: 1, created_at: now, label: BUNDLED_LABEL, source: "bundled", hash }]),
      rights_mode: "public",
      created_by: null,
    });
    outcome.created.push(skill.name);
    log(`"${skill.name}" added to the skill library`);
  }
  return outcome;
}
