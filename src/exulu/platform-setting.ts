/**
 * Resolve a platform setting across its three layers: a value stored in
 * platform_configurations, an environment variable, and the default declared
 * in code.
 *
 * This is the third place in the codebase that needs this shape
 * (src/exulu/entities/config.ts for entity models, src/exulu/embedder-settings.ts
 * for embedders, and now Transcripts settings). It exists so the next one is
 * not a fourth hand-rolled copy.
 *
 * Nullish checks, never truthiness: a stored `false`, `0` or `""` is a
 * deliberate admin choice and must beat the env value. A `||` chain here
 * would silently discard every falsy setting.
 *
 * Design doc: docs/superpowers/specs/2026-09-30-transcripts-settings-design.md §2
 */
export type SettingSource = "database" | "env" | "code";

export interface ResolvedSetting<T> {
  value: T;
  source: SettingSource;
}

export function resolveSetting<T>(
  stored: T | null | undefined,
  envValue: T | null | undefined,
  codeDefault: T,
): ResolvedSetting<T> {
  if (stored !== null && stored !== undefined) {
    return { value: stored, source: "database" };
  }
  if (envValue !== null && envValue !== undefined) {
    return { value: envValue, source: "env" };
  }
  return { value: codeDefault, source: "code" };
}
