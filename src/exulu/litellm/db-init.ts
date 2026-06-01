import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { Client } from "pg";
import {
  checkLiteLLMDatabaseSafety,
  readLiteLLMDatabaseUrl,
} from "./db-setup-check";

/**
 * Auto-setup for LiteLLM's database schema, run as part of ExuluDatabase.init.
 *
 * Behavior summary:
 *   - No database_url in config.litellm.yaml      → no-op (LiteLLM DB mode off).
 *   - database_url == Exulu's own Postgres        → loud WARNING, skip push.
 *   - Target DB contains non-LiteLLM_* tables     → loud WARNING, skip push.
 *   - Otherwise                                   → run `prisma db push` (no
 *                                                   --accept-data-loss).
 *
 * Why we warn-and-skip instead of throwing on the dangerous cases: a failed
 * boot is worse than a degraded boot when the user is trying to fix the
 * config. The warnings are formatted to be hard to miss in logs, and any
 * LiteLLM feature that needs the database will surface a clear runtime error.
 *
 * Idempotent: re-running on an already-set-up LiteLLM database is "already in
 * sync" no-op. Safe to call on every boot.
 */

const WARNING_BANNER = "════════════════════════════════════════════════════════════════════════";

const warn = (lines: string[]): void => {
  console.warn(`\n${WARNING_BANNER}`);
  console.warn("⚠  [EXULU-LITELLM] CONFIGURATION WARNING");
  for (const line of lines) console.warn(`   ${line}`);
  console.warn(`${WARNING_BANNER}\n`);
};

const log = (line: string): void => console.log(`[EXULU-LITELLM] ${line}`);

export const initLiteLLMDatabase = async (
  packageRoot: string,
): Promise<void> => {
  const configPath =
    process.env.LITELLM_CONFIG_PATH ?? resolve(process.cwd(), "./config.litellm.yaml");

  // Static checks (no DB connection): parses YAML, compares URLs to Exulu's
  // Postgres env vars. Pure function — cheap to call even when LiteLLM is off.
  const safety = checkLiteLLMDatabaseSafety(configPath);

  if (safety.ok && safety.reason === "no-litellm-db-mode") return;

  if (!safety.ok && safety.reason === "unparseable-url") {
    warn([
      `LiteLLM's database_url is not a valid postgres URL:`,
      `   ${safety.rawUrl}`,
      `Expected postgres://user:pass@host:port/database. Skipping setup.`,
    ]);
    return;
  }

  if (!safety.ok && safety.reason === "shared-with-exulu") {
    const { exuluTarget } = safety;
    warn([
      `LiteLLM's database_url points to the SAME database Exulu uses:`,
      `   ${exuluTarget.host}:${exuluTarget.port}/${exuluTarget.database}`,
      ``,
      `If LiteLLM's schema sync were to run against this database, it`,
      `would DROP every table that is not in LiteLLM's Prisma schema,`,
      `destroying all of Exulu's data. Setup has been SKIPPED.`,
      ``,
      `Fix: create a dedicated Postgres database for LiteLLM (e.g.`,
      `\`createdb litellm\`) and change database_url in ${configPath}`,
      `to point at it. Then restart Exulu.`,
    ]);
    return;
  }

  // safety.ok === true && reason === "isolated" from here on.
  const litellmUrl = readLiteLLMDatabaseUrl(configPath);
  if (!litellmUrl) {
    // Defensive: shouldn't happen if safety reported "isolated".
    return;
  }
  const target = "litellmTarget" in safety ? safety.litellmTarget : undefined;
  log(
    `LiteLLM database mode detected (${target?.host}:${target?.port}/${target?.database}).`,
  );

  // Ensure the target database itself exists. Postgres surfaces "database
  // doesn't exist" with SQLSTATE 3D000; when we see that, we try to create
  // it by connecting to the system `postgres` database with the same
  // credentials and running CREATE DATABASE. Failure (e.g. user lacks the
  // CREATEDB privilege) warns + skips with a copy-pasteable `createdb` cmd.
  const ensureDatabaseExists = async (): Promise<boolean> => {
    const probe = new Client({ connectionString: litellmUrl });
    try {
      await probe.connect();
      await probe.end();
      return true;
    } catch (err) {
      const code = (err as { code?: string })?.code;
      if (code !== "3D000") {
        warn([
          `Could not connect to LiteLLM's target database:`,
          `   ${err instanceof Error ? err.message : String(err)}`,
          ``,
          `Skipping LiteLLM database setup. LiteLLM features that depend on`,
          `the database will fail at runtime until this is resolved.`,
        ]);
        return false;
      }
      const url = new URL(litellmUrl);
      const targetDbName = url.pathname.replace(/^\//, "");
      if (!targetDbName) {
        warn([`LiteLLM database_url has no database name; cannot auto-create.`]);
        return false;
      }
      url.pathname = "/postgres";
      log(`Target database "${targetDbName}" does not exist; creating it…`);
      // Strict allow-list on the identifier — names with characters that
      // would require quoting are too risky to interpolate, so we refuse
      // and tell the operator to create the database themselves.
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(targetDbName)) {
        warn([
          `Refusing to auto-create database "${targetDbName}" — name`,
          `contains characters that would require quoting. Create it`,
          `manually: createdb -h ${url.hostname} -U ${url.username} ${targetDbName}`,
        ]);
        return false;
      }
      const admin = new Client({ connectionString: url.toString() });
      try {
        await admin.connect();
        await admin.query(`CREATE DATABASE "${targetDbName}"`);
        log(`✓ Created database "${targetDbName}".`);
        return true;
      } catch (createErr) {
        warn([
          `Failed to auto-create database "${targetDbName}":`,
          `   ${createErr instanceof Error ? createErr.message : String(createErr)}`,
          ``,
          `The connecting user likely lacks CREATEDB privilege. Create the`,
          `database manually:`,
          `   createdb -h ${url.hostname} -U ${url.username} ${targetDbName}`,
          `Then restart Exulu.`,
        ]);
        return false;
      } finally {
        try {
          await admin.end();
        } catch {
          // ignore
        }
      }
    }
  };

  if (!(await ensureDatabaseExists())) return;

  // Dynamic safety check: refuse to push into a database that contains
  // tables outside the LiteLLM schema. `prisma db push` without
  // --accept-data-loss would catch this too, but doing it ourselves lets
  // us produce a clearer, named-tables warning message.
  log("Checking that the target database is safe to push into…");
  const client = new Client({ connectionString: litellmUrl });
  let foreignTables: string[] = [];
  try {
    await client.connect();
    // Only BASE TABLE — LiteLLM creates several unprefixed VIEW objects on
    // top of its tables (DailyTagSpend, Last30dKeysBySpend, etc.) that we
    // do not want to flag as foreign. Application data lives in tables, so
    // filtering tables is what actually protects against data loss.
    const res = await client.query<{ table_name: string }>(
      `SELECT table_name
         FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_type = 'BASE TABLE'
          AND table_name NOT LIKE 'LiteLLM%'
          AND table_name <> '_prisma_migrations'
        ORDER BY table_name;`,
    );
    foreignTables = res.rows.map((r) => r.table_name);
  } catch (err) {
    warn([
      `Could not query LiteLLM's target database to verify it is safe`,
      `to push into:`,
      `   ${err instanceof Error ? err.message : String(err)}`,
      ``,
      `Skipping LiteLLM database setup. LiteLLM features that depend on the`,
      `database will fail at runtime until this is resolved.`,
    ]);
    return;
  } finally {
    try {
      await client.end();
    } catch {
      // ignore
    }
  }

  if (foreignTables.length > 0) {
    warn([
      `LiteLLM's target database contains ${foreignTables.length} table(s) that are NOT`,
      `part of LiteLLM's schema:`,
      ...foreignTables.slice(0, 10).map((t) => `   - ${t}`),
      ...(foreignTables.length > 10
        ? [`   … and ${foreignTables.length - 10} more`]
        : []),
      ``,
      `Refusing to run prisma db push to avoid data loss. Move LiteLLM to a`,
      `dedicated database, or remove these tables first if they are obsolete.`,
    ]);
    return;
  }

  // All checks passed — run prisma db push.
  const venvBin = resolve(packageRoot, "ee/python/.venv/bin");
  const prismaCli = resolve(venvBin, "prisma");
  const litellmProxyDir = resolve(
    packageRoot,
    "ee/python/.venv/lib/python3.12/site-packages/litellm/proxy",
  );
  const schemaPath = resolve(litellmProxyDir, "schema.prisma");

  if (!existsSync(prismaCli)) {
    warn([
      `Prisma CLI not found at ${prismaCli}.`,
      `Run \`npm run python:setup\` to create the venv and install prisma.`,
      `Skipping LiteLLM database setup.`,
    ]);
    return;
  }
  if (!existsSync(schemaPath)) {
    warn([
      `LiteLLM Prisma schema not found at ${schemaPath}.`,
      `Re-run \`npm run python:setup\`. Skipping LiteLLM database setup.`,
    ]);
    return;
  }

  log("Running `prisma db push` against LiteLLM's schema…");
  // No --accept-data-loss. If Prisma needs to drop anything, it errors out
  // and we want it to.
  const result = spawnSync(prismaCli, ["db", "push", "--skip-generate"], {
    cwd: litellmProxyDir,
    env: {
      ...process.env,
      DATABASE_URL: litellmUrl,
      PATH: `${venvBin}:${process.env.PATH ?? ""}`,
    },
    // Capture rather than inherit so the prisma noise doesn't bury other
    // Exulu boot logs; we'll print stdout/stderr only on failure.
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });

  if (result.error) {
    warn([
      `Failed to launch prisma: ${result.error.message}`,
      `Skipping LiteLLM database setup.`,
    ]);
    return;
  }
  if (result.status !== 0) {
    warn([
      `prisma db push exited with status ${result.status}.`,
      `stdout:`,
      ...(result.stdout || "(empty)").split("\n").map((l) => `   ${l}`),
      `stderr:`,
      ...(result.stderr || "(empty)").split("\n").map((l) => `   ${l}`),
    ]);
    return;
  }

  log("✓ LiteLLM database ready.");
};
