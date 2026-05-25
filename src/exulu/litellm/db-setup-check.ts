import { readFileSync, existsSync } from "node:fs";

/**
 * Pure helpers for reasoning about LiteLLM's database_url. No side effects,
 * no DB connections — easy to unit-test. Consumed by db-init.ts, which runs
 * during ExuluDatabase.init and decides whether to push LiteLLM's schema.
 *
 * Why this exists: LiteLLM's own auto schema sync would run
 * `prisma db push --accept-data-loss`, which drops any tables in the public
 * schema that are not in LiteLLM's Prisma schema. Pointing LiteLLM at a
 * database that's shared with another application (most notably Exulu's
 * own Postgres) silently destroys that application's data. We replace
 * LiteLLM's sync with our own controlled one, gated on these checks.
 */

export type ParsedDbUrl = {
  host: string;
  port: number;
  database: string;
};

/**
 * Best-effort YAML extraction of `database_url` from a config.litellm.yaml.
 * We don't take a YAML-parser dependency for this — the file is shaped by
 * LiteLLM's documented config format and the line of interest is a simple
 * key:value pair under `general_settings`. Returns undefined if the key is
 * absent or commented out.
 */
export const readLiteLLMDatabaseUrl = (configPath: string): string | undefined => {
  if (!existsSync(configPath)) return undefined;
  const text = readFileSync(configPath, "utf8");
  // Match `  database_url: "postgres://..."` (with or without quotes,
  // optional inline comment). Skips commented-out lines (starting with `#`).
  const match = text.match(
    /^\s*database_url:\s*["']?([^"'\n#]+?)["']?\s*(#.*)?$/m,
  );
  if (!match) return undefined;
  const value = match[1]?.trim();
  if (!value) return undefined;
  // LiteLLM lets you write `os.environ/DATABASE_URL` to defer to an env var.
  // If we see that form, dereference it here so the safety check still works.
  if (value.startsWith("os.environ/")) {
    const envName = value.slice("os.environ/".length).trim();
    return process.env[envName];
  }
  return value;
};

/** Parse a postgres connection string into the parts we care about. */
export const parsePostgresUrl = (url: string): ParsedDbUrl | undefined => {
  try {
    const u = new URL(url);
    if (u.protocol !== "postgres:" && u.protocol !== "postgresql:") return undefined;
    return {
      host: u.hostname,
      port: u.port ? parseInt(u.port, 10) : 5432,
      database: u.pathname.replace(/^\//, ""),
    };
  } catch {
    return undefined;
  }
};

/** Build the Exulu Postgres connection target from env vars (same vars
 *  src/postgres/client.ts reads). Returns undefined if any are missing. */
export const getExuluPostgresTarget = (): ParsedDbUrl | undefined => {
  const host = process.env.POSTGRES_DB_HOST;
  const database = process.env.POSTGRES_DB_NAME ?? "exulu";
  if (!host) return undefined;
  return {
    host,
    port: parseInt(process.env.POSTGRES_DB_PORT ?? "5432", 10),
    database,
  };
};

/** Two database targets point to the same physical database when host,
 *  port, and database name all match. User credentials are intentionally
 *  not compared — a shared DB with different users is still shared. */
export const isSameDatabase = (a: ParsedDbUrl, b: ParsedDbUrl): boolean =>
  a.host === b.host && a.port === b.port && a.database === b.database;

export type DbSafetyCheckResult =
  | { ok: true; reason: "no-litellm-db-mode" }
  | { ok: true; reason: "isolated"; litellmTarget: ParsedDbUrl }
  | { ok: false; reason: "shared-with-exulu"; litellmTarget: ParsedDbUrl; exuluTarget: ParsedDbUrl }
  | { ok: false; reason: "unparseable-url"; rawUrl: string };

/**
 * Run the static (no DB connection) safety checks. Pure function — easy to
 * unit-test and safe to call at boot.
 */
export const checkLiteLLMDatabaseSafety = (configPath: string): DbSafetyCheckResult => {
  const litellmUrl = readLiteLLMDatabaseUrl(configPath);
  if (!litellmUrl) return { ok: true, reason: "no-litellm-db-mode" };

  const litellmTarget = parsePostgresUrl(litellmUrl);
  if (!litellmTarget) return { ok: false, reason: "unparseable-url", rawUrl: litellmUrl };

  const exuluTarget = getExuluPostgresTarget();
  if (exuluTarget && isSameDatabase(litellmTarget, exuluTarget)) {
    return { ok: false, reason: "shared-with-exulu", litellmTarget, exuluTarget };
  }

  return { ok: true, reason: "isolated", litellmTarget };
};
