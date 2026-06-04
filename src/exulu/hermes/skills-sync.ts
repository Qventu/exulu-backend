import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { listS3ObjectsByPrefix, getS3ObjectBytes } from "../../uppy/index.ts";
import type { ExuluConfig } from "../app/index.ts";
import { getProfileDir } from "./config";

/**
 * Syncs an advanced-mode agent's enabled Exulu skills from S3 into its Hermes
 * profile, so the agent can invoke them. Exulu skills are already stored in the
 * Anthropic "Agent Skills" layout (`<skillName>/SKILL.md` + assets), which is
 * exactly what Hermes' `skills.external_dirs` expects — so no transform is
 * needed, just a download.
 *
 * Files land in `${profileDir}/exulu-skills/<skillName>/…`; the provisioner adds
 * that directory to config.yaml `skills.external_dirs`. This is additive: it
 * sits alongside Hermes' own skills home (the learned/bundled skills) rather
 * than replacing it.
 *
 * Mirrors the canonical download loop in ee/invoke-skills/create-sandbox.ts but
 * without the sandbox-runtime dependencies. Hash-gated so we only re-download
 * when the enabled skill set/version changes.
 *
 * Design doc: docs/superpowers/specs/2026-06-03-hermes-agent-mode-design.md
 */

export type SyncSkill = { id: string; name: string; current_version?: number };

const SYNC_HASH_FILE = ".synced-hash";

/** The directory a profile's synced Exulu skills live in (and external_dirs points at). */
export const exuluSkillsDir = (profileId: string): string =>
  join(getProfileDir(profileId), "exulu-skills");

const computeHash = (skills: SyncSkill[]): string =>
  createHash("sha256")
    .update(
      JSON.stringify(
        skills.map((s) => `${s.id}@${s.current_version ?? 1}`).sort(),
      ),
    )
    .digest("hex");

/** Download one skill's S3 objects into `${dir}/<skillName>/…`, preserving layout. */
const downloadSkill = async (
  skill: SyncSkill,
  dir: string,
  config: ExuluConfig,
): Promise<void> => {
  const version = skill.current_version ?? 1;
  const versionPrefix = `skills/${skill.id}/v${version}/`;
  const files = await listS3ObjectsByPrefix(versionPrefix, config);
  for (const file of files) {
    // Strip any S3 general prefix and the version prefix to get the in-skill path.
    const idx = file.key.indexOf(versionPrefix);
    const relativePath =
      idx >= 0 ? file.key.slice(idx + versionPrefix.length) : file.key;
    if (!relativePath) continue; // directory marker
    const localPath = join(dir, skill.name, relativePath);
    await mkdir(dirname(localPath), { recursive: true });
    await writeFile(localPath, await getS3ObjectBytes(file.key, config));
  }
};

/**
 * Ensure the profile's enabled Exulu skills are present on disk. Returns the
 * skills directory, or undefined when there are no skills to sync. Hash-gated:
 * a no-op when the enabled set/version is unchanged.
 */
export const syncProfileSkills = async (
  profileId: string,
  skills: SyncSkill[],
  config: ExuluConfig,
): Promise<string | undefined> => {
  const dir = exuluSkillsDir(profileId);
  if (!skills || skills.length === 0) {
    // Nothing enabled — clear any previously-synced skills so the agent doesn't
    // keep using a skill that was turned off.
    await rm(dir, { recursive: true, force: true });
    return undefined;
  }

  const hash = computeHash(skills);
  const hashPath = join(dir, SYNC_HASH_FILE);
  const current = await readFile(hashPath, "utf8").catch(() => undefined);
  if (current?.trim() === hash) return dir; // up to date

  // Re-sync from clean to drop files from skills/versions no longer enabled.
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  for (const skill of skills) {
    await downloadSkill(skill, dir, config);
  }
  await writeFile(hashPath, hash, "utf8");
  return dir;
};
