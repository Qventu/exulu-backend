# Value Ledger — Phase 0 + Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a standalone Next.js app that reads only the LiteLLM database and emails a monthly report making LLM spend defensible and adoption legible.

**Architecture:** A new independent repo at `~/Desktop/Projects/exulu/adoption-and-value-tracker`. It holds its own small Postgres schema (config, frozen monthly snapshots, job log) and opens a **read-only** connection to LiteLLM's Postgres. Metric functions are pure over a narrow `LiteLLMSource` interface, so all metric maths is unit-tested against fixtures with no database. A monthly job builds an immutable snapshot; the report renders exclusively from that snapshot.

**Tech Stack:** Next.js 15 (App Router), TypeScript, Node 22.18.0, pnpm, Drizzle ORM (own schema) + `pg` (raw read-only LiteLLM queries), Vitest, nodemailer, Docker Compose Postgres for integration tests.

**Spec:** `../specs/2026-08-11-litellm-value-ledger-design.md`

## Global Constraints

Every task's requirements implicitly include this section.

- **G1 — Never sum across tag dimensions.** A single request carries many tags (`user_id_*`, `team_id_*`, `project_id_*`, …). Summing all tag rows over-counts spend by roughly the tag count. **Totals come from `LiteLLM_SpendLogs` only.** Tag aggregation is valid *within* one dimension (a request carries exactly one `user_id_*` tag), never across.
- **G2 — Read-only against LiteLLM.** The LiteLLM pool must use a read-only role. No writes, no DDL, no `Exulu` database access of any kind.
- **G3 — Snapshot immutability.** Once a month's snapshot row exists it is never updated or recomputed. The FX rate in force is frozen into the row. Re-running the job for an existing month is a no-op that logs and exits.
- **G4 — Team-level only, min-N = 5.** No per-person figures may appear in a snapshot or report. Teams with fewer than 5 active users roll into `"Other"`. Agents may be named; people may not.
- **G5 — Evidence-Lock.** Every number rendered into the report must have been emitted through the number registry. The report build throws if any numeric token in the output was not registered.
- **G6 — No partial reports.** If the month's data fails the completeness guard, the job throws, logs to `job_run`, and sends nothing.
- **G7 — Observe only.** No feature may prompt, survey, or ask a user anything.
- **G8 — Money units.** `LiteLLM_SpendLogs.spend` is USD. Reporting currency and `fxRateUsdToReporting` come from config and are frozen per snapshot. Never mix units in one expression.

## File Structure

```
adoption-and-value-tracker/
├── docker-compose.test.yml          Postgres for integration tests
├── drizzle.config.ts
├── .env.example
├── scripts/
│   └── phase0-probe.ts              Read-only production probe (Task 1)
├── src/
│   ├── config.ts                    Env parsing + typed config
│   ├── db/
│   │   ├── schema.ts                Own tables: config, value_month_snapshot, job_run
│   │   ├── client.ts                Own Drizzle client
│   │   └── litellm.ts               Read-only pg pool
│   ├── litellm/
│   │   ├── types.ts                 Row types + LiteLLMSource interface
│   │   ├── source-sql.ts            SQL implementation
│   │   └── source-fake.ts           Fixture implementation for tests
│   ├── metrics/
│   │   ├── types.ts                 Snapshot + panel types
│   │   ├── tags.ts                  Tag parsing
│   │   ├── min-n.ts                 Team roll-up
│   │   ├── bar.ts                   Panel 1
│   │   ├── adoption.ts              Panel 2
│   │   ├── reliability.ts           Panel 3
│   │   └── waste.ts                 Panel 4
│   ├── snapshot/
│   │   ├── build.ts                 Orchestrates panels
│   │   ├── guard.ts                 Completeness guard
│   │   └── freeze.ts                Write-once persistence
│   ├── report/
│   │   ├── registry.ts              Number registry + formatters
│   │   ├── evidence-lock.ts         Verification
│   │   ├── html.ts                  HTML renderer
│   │   ├── csv.ts                   CSV renderer
│   │   └── send.ts                  SMTP delivery
│   ├── jobs/
│   │   └── monthly.ts               Orchestration entry point
│   └── app/
│       └── api/jobs/monthly/route.ts  Token-authenticated trigger
└── tests/
    ├── metrics/*.test.ts
    ├── snapshot/*.test.ts
    └── report/*.test.ts
```

---

## Phase 0 — Empirical verification

### Task 1: Read-only production probe script

Standalone script Daniel runs against OPEN's live LiteLLM Postgres. It writes a findings
file that gets pasted back. It must be safe: read-only statements only, and a hard
statement timeout.

**Files:**
- Create: `~/Desktop/Projects/exulu/adoption-and-value-tracker/scripts/phase0-probe.ts`
- Create: `~/Desktop/Projects/exulu/adoption-and-value-tracker/scripts/README.md`

**Interfaces:**
- Consumes: nothing (runs before the app exists)
- Produces: a findings markdown file whose numbers feed Task 5's assumptions and the first report's coverage baseline

- [ ] **Step 1: Create the repo and init git**

```bash
mkdir -p ~/Desktop/Projects/exulu/adoption-and-value-tracker/scripts
cd ~/Desktop/Projects/exulu/adoption-and-value-tracker
git init
printf 'node_modules\n.env\n.next\ndist\nphase0-findings.md\n' > .gitignore
```

- [ ] **Step 2: Minimal package.json so the script can run**

```bash
cd ~/Desktop/Projects/exulu/adoption-and-value-tracker
cat > package.json <<'EOF'
{
  "name": "adoption-and-value-tracker",
  "private": true,
  "type": "module",
  "scripts": {
    "phase0": "tsx scripts/phase0-probe.ts"
  },
  "dependencies": {
    "pg": "^8.13.1"
  },
  "devDependencies": {
    "@types/node": "^22.10.2",
    "@types/pg": "^8.11.10",
    "tsx": "^4.19.2",
    "typescript": "^5.7.2"
  }
}
EOF
pnpm install
```

- [ ] **Step 3: Write the probe script**

Create `scripts/phase0-probe.ts`:

```ts
/**
 * Phase 0 probe — READ ONLY.
 * Answers the runtime unknowns the Value Ledger design depends on.
 * Usage: LITELLM_DATABASE_URL=postgres://... pnpm phase0 > phase0-findings.md
 */
import pg from "pg";

const url = process.env.LITELLM_DATABASE_URL;
if (!url) {
  console.error("LITELLM_DATABASE_URL is required");
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: url, max: 2 });

type Probe = { name: string; question: string; sql: string };

const PROBES: Probe[] = [
  {
    name: "row_volume",
    question: "How many SpendLogs rows in the last 90 days, and what is the date range?",
    sql: `SELECT COUNT(*) AS rows,
                 MIN("startTime") AS earliest,
                 MAX("startTime") AS latest
          FROM "LiteLLM_SpendLogs"
          WHERE "startTime" >= NOW() - INTERVAL '90 days'`,
  },
  {
    name: "session_id_populated",
    question: "Is session_id populated? (design assumes it may not be)",
    sql: `SELECT COUNT(*) AS total,
                 COUNT(session_id) AS with_session_id,
                 COUNT(DISTINCT session_id) AS distinct_sessions
          FROM "LiteLLM_SpendLogs"
          WHERE "startTime" >= NOW() - INTERVAL '30 days'`,
  },
  {
    name: "status_values",
    question: "What distinct status values exist? (adapter treats 'success' as success)",
    sql: `SELECT status, COUNT(*) AS n
          FROM "LiteLLM_SpendLogs"
          WHERE "startTime" >= NOW() - INTERVAL '30 days'
          GROUP BY status ORDER BY n DESC`,
  },
  {
    name: "tag_coverage",
    question: "What share of spend carries user_id_ / team_id_ / project_id_ tags?",
    sql: `WITH s AS (
            SELECT spend, request_tags::jsonb AS tags
            FROM "LiteLLM_SpendLogs"
            WHERE "startTime" >= NOW() - INTERVAL '30 days'
          )
          SELECT ROUND(SUM(spend)::numeric, 2) AS total_spend,
                 ROUND(SUM(spend) FILTER (WHERE EXISTS (
                   SELECT 1 FROM jsonb_array_elements_text(tags) t
                   WHERE t LIKE 'user_id\\_%'))::numeric, 2) AS spend_with_user_tag,
                 ROUND(SUM(spend) FILTER (WHERE EXISTS (
                   SELECT 1 FROM jsonb_array_elements_text(tags) t
                   WHERE t LIKE 'team_id\\_%'))::numeric, 2) AS spend_with_team_tag,
                 ROUND(SUM(spend) FILTER (WHERE EXISTS (
                   SELECT 1 FROM jsonb_array_elements_text(tags) t
                   WHERE t LIKE 'project_id\\_%'))::numeric, 2) AS spend_with_project_tag
          FROM s`,
  },
  {
    name: "tag_dimensions_seen",
    question: "Which tag prefixes actually occur, and how often?",
    sql: `SELECT split_part(t, '_', 1) || '_' || split_part(t, '_', 2) AS prefix,
                 COUNT(*) AS n
          FROM "LiteLLM_SpendLogs" s,
               LATERAL jsonb_array_elements_text(s.request_tags::jsonb) AS t
          WHERE s."startTime" >= NOW() - INTERVAL '30 days'
          GROUP BY 1 ORDER BY n DESC LIMIT 30`,
  },
  {
    name: "user_column_collapse",
    question: "Does the LiteLLM user column collapse to one identity (master key)?",
    sql: `SELECT "user", COUNT(*) AS n, ROUND(SUM(spend)::numeric, 2) AS spend
          FROM "LiteLLM_SpendLogs"
          WHERE "startTime" >= NOW() - INTERVAL '30 days'
          GROUP BY 1 ORDER BY n DESC LIMIT 10`,
  },
  {
    name: "daily_tag_grain",
    question: "Is LiteLLM_DailyTagSpend one row per (tag, date) or finer?",
    sql: `SELECT date, tag, COUNT(*) AS rows_for_pair
          FROM "LiteLLM_DailyTagSpend"
          WHERE date >= (NOW() - INTERVAL '14 days')::date
          GROUP BY 1, 2 HAVING COUNT(*) > 1
          ORDER BY rows_for_pair DESC LIMIT 5`,
  },
  {
    name: "prompt_storage_enabled",
    question: "Is store_prompts_in_spend_logs on? (Phase 3 depends on it; expect empty)",
    sql: `SELECT COUNT(*) AS total,
                 COUNT(*) FILTER (WHERE proxy_server_request::text NOT IN ('{}', 'null', ''))
                   AS with_request_body,
                 COUNT(*) FILTER (WHERE response::text NOT IN ('{}', 'null', ''))
                   AS with_response
          FROM "LiteLLM_SpendLogs"
          WHERE "startTime" >= NOW() - INTERVAL '7 days'`,
  },
  {
    name: "provisioned_users",
    question: "How many users are provisioned vs active in the last 60 days?",
    sql: `SELECT (SELECT COUNT(*) FROM "LiteLLM_UserTable") AS provisioned_users,
                 (SELECT COUNT(*) FROM "LiteLLM_TeamTable") AS teams`,
  },
];

async function main() {
  const client = await pool.connect();
  await client.query("SET default_transaction_read_only = on");
  await client.query("SET statement_timeout = '60s'");

  console.log("# Phase 0 findings\n");
  console.log(`Run at: ${new Date().toISOString()}\n`);

  for (const probe of PROBES) {
    console.log(`## ${probe.name}\n`);
    console.log(`**${probe.question}**\n`);
    try {
      const res = await client.query(probe.sql);
      if (res.rows.length === 0) {
        console.log("_no rows_\n");
      } else {
        console.log("```json");
        console.log(JSON.stringify(res.rows, null, 2));
        console.log("```\n");
      }
    } catch (err) {
      console.log("```");
      console.log(`ERROR: ${(err as Error).message}`);
      console.log("```\n");
    }
  }

  client.release();
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 4: Write scripts/README.md**

```markdown
# Phase 0 probe

Read-only. Sets `default_transaction_read_only` and a 60s statement timeout.

## Run

    LITELLM_DATABASE_URL='postgres://readonly_user:...@host:5432/litellm' \
      pnpm phase0 > phase0-findings.md

Then paste `phase0-findings.md` back into the design conversation.

If a probe errors with `relation does not exist`, that is a finding, not a failure —
it means this LiteLLM version lacks that table. Report it as-is.
```

- [ ] **Step 5: Verify the script compiles and fails cleanly without a connection string**

Run: `cd ~/Desktop/Projects/exulu/adoption-and-value-tracker && pnpm phase0`
Expected: exits 1 with `LITELLM_DATABASE_URL is required` — no stack trace.

- [ ] **Step 6: Commit**

```bash
cd ~/Desktop/Projects/exulu/adoption-and-value-tracker
git add -A
git commit -m "feat: phase 0 read-only litellm probe script"
```

> **Implemented 2026-08-11 (commits ce5ec2f, 0e257c8).** Two refinements landed during
> review and are in the code rather than above: the `pool.connect()` call and the two
> `SET` statements are wrapped so a connection failure writes a `## CONNECTION FAILED`
> section to **stdout** (it would otherwise leave an empty `phase0-findings.md` with the
> error only on stderr), and cleanup moved into a `finally` guarded by `if (client)`.

- [ ] **Step 7: Hand off to Daniel**

Ask Daniel to run the probe against production and paste back `phase0-findings.md`.
**Do not start Task 2 until the findings are in hand** — they set the coverage baseline
and confirm the `status` vocabulary that Task 5's adapter depends on.

---

## Phase 1 — Snapshot and report

### Task 2: Scaffold the app

**Files:**
- Create: `package.json`, `tsconfig.json`, `next.config.ts`, `vitest.config.ts`,
  `.env.example`, `docker-compose.test.yml`, `src/config.ts`
- Test: `tests/config.test.ts`

**Interfaces:**
- Produces: `loadConfig(): AppConfig` with fields `ownDatabaseUrl`, `litellmDatabaseUrl`,
  `hourlyRate`, `reportingCurrency`, `fxRateUsdToReporting`, `fxRateSetOn`, `minN`,
  `smtp{host,port,user,pass,from}`, `reportRecipients: string[]`, `jobToken`

- [ ] **Step 1: Add dependencies**

```bash
cd ~/Desktop/Projects/exulu/adoption-and-value-tracker
pnpm add next@^15 react react-dom pg drizzle-orm nodemailer zod
pnpm add -D typescript @types/node @types/react @types/pg @types/nodemailer \
  vitest drizzle-kit tsx
```

- [ ] **Step 2: Write the failing config test**

Create `tests/config.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config";

const VALID = {
  OWN_DATABASE_URL: "postgres://localhost/avt",
  LITELLM_DATABASE_URL: "postgres://localhost/litellm",
  HOURLY_RATE: "140",
  REPORTING_CURRENCY: "EUR",
  FX_RATE_USD_TO_REPORTING: "0.92",
  FX_RATE_SET_ON: "2026-08-01",
  SMTP_HOST: "smtp.example.com",
  SMTP_PORT: "587",
  SMTP_USER: "u",
  SMTP_PASS: "p",
  SMTP_FROM: "ledger@example.com",
  REPORT_RECIPIENTS: "a@example.com, b@example.com",
  JOB_TOKEN: "secrettoken",   // must satisfy min(8)
};

describe("parseConfig", () => {
  it("parses a valid environment", () => {
    const cfg = parseConfig(VALID);
    expect(cfg.hourlyRate).toBe(140);
    expect(cfg.fxRateUsdToReporting).toBe(0.92);
    expect(cfg.reportRecipients).toEqual(["a@example.com", "b@example.com"]);
    expect(cfg.minN).toBe(5);
  });

  it("rejects a missing FX rate rather than defaulting to 1", () => {
    const { FX_RATE_USD_TO_REPORTING, ...rest } = VALID;
    expect(() => parseConfig(rest)).toThrow(/FX_RATE_USD_TO_REPORTING/);
  });

  it("rejects a non-positive hourly rate", () => {
    expect(() => parseConfig({ ...VALID, HOURLY_RATE: "0" })).toThrow();
  });
});
```

The FX test matters: silently defaulting to 1.0 would make the headline break-even
number wrong by the exchange rate with no visible symptom.

- [ ] **Step 3: Run it to confirm it fails**

Run: `pnpm vitest run tests/config.test.ts`
Expected: FAIL — cannot find module `../src/config`

- [ ] **Step 4: Implement src/config.ts**

```ts
import { z } from "zod";

const Env = z.object({
  OWN_DATABASE_URL: z.string().min(1),
  LITELLM_DATABASE_URL: z.string().min(1),
  HOURLY_RATE: z.coerce.number().positive(),
  REPORTING_CURRENCY: z.string().length(3),
  FX_RATE_USD_TO_REPORTING: z.coerce.number().positive(),
  FX_RATE_SET_ON: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  MIN_N: z.coerce.number().int().min(1).default(5),
  SMTP_HOST: z.string().min(1),
  SMTP_PORT: z.coerce.number().int().positive(),
  SMTP_USER: z.string().min(1),
  SMTP_PASS: z.string().min(1),
  SMTP_FROM: z.string().min(1),
  REPORT_RECIPIENTS: z.string().min(1),
  JOB_TOKEN: z.string().min(8),
});

export type AppConfig = {
  ownDatabaseUrl: string;
  litellmDatabaseUrl: string;
  hourlyRate: number;
  reportingCurrency: string;
  fxRateUsdToReporting: number;
  fxRateSetOn: string;
  minN: number;
  smtp: { host: string; port: number; user: string; pass: string; from: string };
  reportRecipients: string[];
  jobToken: string;
};

export function parseConfig(env: Record<string, string | undefined>): AppConfig {
  const e = Env.parse(env);
  return {
    ownDatabaseUrl: e.OWN_DATABASE_URL,
    litellmDatabaseUrl: e.LITELLM_DATABASE_URL,
    hourlyRate: e.HOURLY_RATE,
    reportingCurrency: e.REPORTING_CURRENCY,
    fxRateUsdToReporting: e.FX_RATE_USD_TO_REPORTING,
    fxRateSetOn: e.FX_RATE_SET_ON,
    minN: e.MIN_N,
    smtp: {
      host: e.SMTP_HOST, port: e.SMTP_PORT, user: e.SMTP_USER,
      pass: e.SMTP_PASS, from: e.SMTP_FROM,
    },
    reportRecipients: e.REPORT_RECIPIENTS.split(",").map((s) => s.trim()).filter(Boolean),
    jobToken: e.JOB_TOKEN,
  };
}

export function loadConfig(): AppConfig {
  return parseConfig(process.env);
}
```

- [ ] **Step 5: Add configs**

`vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";
export default defineConfig({ test: { environment: "node", include: ["tests/**/*.test.ts"] } });
```

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022", "module": "ESNext", "moduleResolution": "bundler",
    "strict": true, "noUncheckedIndexedAccess": true, "esModuleInterop": true,
    "skipLibCheck": true, "resolveJsonModule": true, "jsx": "preserve",
    "lib": ["ES2022", "DOM"], "types": ["node"], "noEmit": true
  },
  "include": ["src", "tests", "scripts", "*.ts"]
}
```

`docker-compose.test.yml`:

```yaml
services:
  postgres:
    image: postgres:16
    environment:
      POSTGRES_PASSWORD: test
      POSTGRES_USER: test
      POSTGRES_DB: test
    ports: ["55432:5432"]
```

`.env.example`: one line per key in the `Env` schema above, with `FX_RATE_SET_ON`
commented as "date this rate was fixed; frozen into each snapshot".

- [ ] **Step 6: Run the tests**

Run: `pnpm vitest run tests/config.test.ts`
Expected: 3 passed

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat: scaffold app with validated config"
```

---

### Task 3: Own database schema

**Files:**
- Create: `src/db/schema.ts`, `src/db/client.ts`, `drizzle.config.ts`
- Test: `tests/db/schema.test.ts`

**Interfaces:**
- Produces: tables `valueMonthSnapshot` (columns `month` PK text `YYYY-MM`, `payload`
  jsonb, `createdAt` timestamptz) and `jobRun` (`id` serial, `job` text, `month` text,
  `status` text, `message` text, `startedAt`, `finishedAt`)
- Consumes: `AppConfig.ownDatabaseUrl` from Task 2

Config lives in env rather than a `config` table: there is one tenant, and env keeps the
frozen FX rate auditable in deployment config rather than mutable at runtime.

- [ ] **Step 1: Write the failing test**

Create `tests/db/schema.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { valueMonthSnapshot, jobRun } from "../../src/db/schema";

describe("schema", () => {
  it("keys snapshots by month so a month can only exist once", () => {
    expect(valueMonthSnapshot.month.primary).toBe(true);
  });

  it("exposes a job run log", () => {
    expect(jobRun.status.name).toBe("status");
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `pnpm vitest run tests/db/schema.test.ts`
Expected: FAIL — cannot find module `../../src/db/schema`

- [ ] **Step 3: Implement src/db/schema.ts**

```ts
import { jsonb, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

/**
 * One row per month, written exactly once. The primary key on `month` is the
 * database-level guarantee behind snapshot immutability (G3).
 */
export const valueMonthSnapshot = pgTable("value_month_snapshot", {
  month: text("month").primaryKey(),
  payload: jsonb("payload").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const jobRun = pgTable("job_run", {
  id: serial("id").primaryKey(),
  job: text("job").notNull(),
  month: text("month"),
  status: text("status").notNull(),
  message: text("message"),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
});
```

- [ ] **Step 4: Implement src/db/client.ts**

```ts
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

export function createOwnDb(connectionString: string) {
  const pool = new pg.Pool({ connectionString, max: 5 });
  return { db: drizzle(pool, { schema }), pool };
}
```

- [ ] **Step 5: Add drizzle.config.ts and generate the migration**

```ts
import type { Config } from "drizzle-kit";
export default {
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: { url: process.env.OWN_DATABASE_URL! },
} satisfies Config;
```

Run: `pnpm drizzle-kit generate`
Expected: a migration appears under `drizzle/`

- [ ] **Step 6: Run the tests**

Run: `pnpm vitest run tests/db/schema.test.ts`
Expected: 2 passed

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat: own postgres schema for snapshots and job runs"
```

---

### Task 4: Tag parsing

Tags look like `user_id_42`, `team_name_open_digital`, `routine_id_abc`. Dimension
prefixes themselves contain underscores and values may too, so parsing must match the
**longest known prefix**, not split on `_`.

**Files:**
- Create: `src/metrics/tags.ts`
- Test: `tests/metrics/tags.test.ts`

**Interfaces:**
- Produces: `TAG_DIMENSIONS` (readonly string tuple), `type Dimension`,
  `parseTag(tag: string): { dimension: Dimension; value: string } | null`,
  `valuesForDimension(tags: string[], dim: Dimension): string[]`

- [ ] **Step 1: Write the failing test**

Create `tests/metrics/tags.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parseTag, valuesForDimension } from "../../src/metrics/tags";

describe("parseTag", () => {
  it("parses a simple id tag", () => {
    expect(parseTag("user_id_42")).toEqual({ dimension: "user_id", value: "42" });
  });

  it("prefers the longest matching prefix so user_name is not read as user_id", () => {
    expect(parseTag("user_name_daniel")).toEqual({
      dimension: "user_name", value: "daniel",
    });
  });

  it("keeps underscores inside the value", () => {
    expect(parseTag("team_name_open_digital_experience")).toEqual({
      dimension: "team_name", value: "open_digital_experience",
    });
  });

  it("returns null for an unknown prefix", () => {
    expect(parseTag("something_else_1")).toBeNull();
  });

  it("returns null for a prefix with an empty value", () => {
    expect(parseTag("user_id_")).toBeNull();
  });
});

describe("valuesForDimension", () => {
  it("extracts only the requested dimension", () => {
    const tags = ["user_id_1", "team_id_9", "user_id_2"];
    expect(valuesForDimension(tags, "user_id")).toEqual(["1", "2"]);
  });
});

describe("parseClientTool", () => {
  it("reads the coarse User-Agent tag", () => {
    expect(parseClientTool("User-Agent: claude-cli")).toBe("claude-cli");
  });

  it("ignores the version-specific variant so tools are not double counted", () => {
    // Production emits both forms for the same request; counting both would
    // report claude-cli twice and inflate every tool share.
    expect(parseClientTool("User-Agent: claude-cli/2.1.170 (external, cli)")).toBeNull();
  });

  it("returns null for an Exulu dimension tag", () => {
    expect(parseClientTool("user_id_42")).toBeNull();
  });

  it("is not confused by parseTag — User-Agent tags are not dimensions", () => {
    expect(parseTag("User-Agent: claude-cli")).toBeNull();
  });
});
```

Import `parseClientTool` alongside `parseTag` and `valuesForDimension` at the top of the
test file.

- [ ] **Step 2: Run it to confirm it fails**

Run: `pnpm vitest run tests/metrics/tags.test.ts`
Expected: FAIL — cannot find module

- [ ] **Step 3: Implement src/metrics/tags.ts**

```ts
export const TAG_DIMENSIONS = [
  "user_id", "user_name",
  "role_id", "role_name",
  "project_id", "project_name",
  "agent_id", "agent_name",
  "team_id", "team_name",
  "routine_id", "routine_name",
  "context_id", "context_name",
] as const;

export type Dimension = (typeof TAG_DIMENSIONS)[number];

// Longest first, so "user_name_x" never matches a shorter overlapping prefix.
const ORDERED: Dimension[] = [...TAG_DIMENSIONS].sort((a, b) => b.length - a.length);

export function parseTag(tag: string): { dimension: Dimension; value: string } | null {
  for (const dimension of ORDERED) {
    const prefix = `${dimension}_`;
    if (tag.startsWith(prefix)) {
      const value = tag.slice(prefix.length);
      return value.length > 0 ? { dimension, value } : null;
    }
  }
  return null;
}

export function valuesForDimension(tags: string[], dim: Dimension): string[] {
  const out: string[] = [];
  for (const tag of tags) {
    const parsed = parseTag(tag);
    if (parsed && parsed.dimension === dim) out.push(parsed.value);
  }
  return out;
}

/**
 * LiteLLM auto-tags every request with the caller's User-Agent. These do NOT follow the
 * `dimension_value` convention — the format is `User-Agent: claude-cli`, with a colon and
 * space — so parseTag() correctly returns null for them and they need their own parser.
 *
 * Two granularities are emitted: a coarse tag with no "/" ("User-Agent: claude-cli",
 * 14 variants in production) and a version-specific one ("User-Agent: claude-cli/2.1.170
 * (external, cli)", 130 variants). Only the coarse tag is a useful reporting dimension.
 */
const UA_PREFIX = "User-Agent: ";

export function parseClientTool(tag: string): string | null {
  if (!tag.startsWith(UA_PREFIX)) return null;
  const value = tag.slice(UA_PREFIX.length).trim();
  if (value.length === 0) return null;
  return value.includes("/") ? null : value;   // drop the versioned variant
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run tests/metrics/tags.test.ts`
Expected: 10 passed

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: tag parsing with longest-prefix dimension matching"
```

---

### Task 5: Data contracts and a fake source

Every metric function takes a `LiteLLMSource`. Real SQL arrives in Task 6; this task
defines the contract and a fixture implementation so Tasks 7–10 are pure and fast.

**Files:**
- Create: `src/litellm/types.ts`, `src/litellm/source-fake.ts`, `src/metrics/types.ts`
- Test: `tests/litellm/source-fake.test.ts`

**Interfaces:**
- Produces: `LiteLLMSource`, `DailyTagRow`, `UserMonthRow`, `UserDayRow`,
  `ModelSpendRow`, `MonthTotals`, `UserTeamRow`, `ClientToolRow`, `AgentLastSeenRow`;
  `Snapshot` and its four panel types; `makeFakeSource(rows)` 
- Consumes: `Dimension` from Task 4

- [ ] **Step 1: Write src/litellm/types.ts**

```ts
/** Totals for a period, taken from SpendLogs only. Never from tag tables (G1). */
export type MonthTotals = {
  spendUsd: number;
  apiRequests: number;
  successfulRequests: number;
  failedRequests: number;
};

/** One row per (day, tag). Valid within a single dimension only (G1). */
export type DailyTagRow = {
  day: string;   // YYYY-MM-DD
  tag: string;
  spendUsd: number;
  requests: number;
};

/** Distinct (user, day) activity, human-initiated only. */
export type UserDayRow = { userId: string; day: string };

/** Distinct (user, month) activity for retention cohorts. */
export type UserMonthRow = { userId: string; month: string };  // month = YYYY-MM

export type ModelSpendRow = { model: string; spendUsd: number };

/**
 * A user's team, recovered from tag CO-OCCURRENCE on the same request — a row carrying
 * both `user_id_42` and `team_name_engineering`. Phase 0 found LiteLLM_UserTable holds 7
 * rows against 52 users in tags, and LiteLLM_TeamTable is empty, so the identity tables
 * cannot supply this. Co-occurrence is only visible in SpendLogs, not in DailyTagSpend.
 */
export type UserTeamRow = { userId: string; teamLabel: string };

/** Client tool from LiteLLM's auto-added `User-Agent: ` tag (coarse form only). */
export type ClientToolRow = {
  tool: string;
  spendUsd: number;
  requests: number;
  activeUsers: number;
};

export type AgentLastSeenRow = {
  agentId: string;
  agentName: string | null;
  lastSeenDay: string | null;
  historicalSpendUsd: number;
};

export interface LiteLLMSource {
  /** Ground-truth totals from SpendLogs. */
  monthTotals(fromIso: string, toIso: string): Promise<MonthTotals>;
  /** Per-(day, tag) spend and request counts, one dimension at a time. */
  dailyByTagPrefix(fromIso: string, toIso: string, prefix: string): Promise<DailyTagRow[]>;
  /** Spend carrying at least one tag of the given prefix — for coverage. */
  spendWithTagPrefix(fromIso: string, toIso: string, prefix: string): Promise<number>;
  /** Human-initiated (user, day) pairs: excludes requests tagged routine_id_*. */
  humanUserDays(fromIso: string, toIso: string): Promise<UserDayRow[]>;
  /** Human-initiated (user, month) pairs across a range, for retention. */
  humanUserMonths(fromIso: string, toIso: string): Promise<UserMonthRow[]>;
  /** Requests and spend that carry a routine_id_* tag. */
  automationTotals(fromIso: string, toIso: string): Promise<{ requests: number; spendUsd: number }>;
  modelSpend(fromIso: string, toIso: string): Promise<ModelSpendRow[]>;
  /** (user, team) pairs from tag co-occurrence. Replaces the empty identity tables. */
  userTeams(fromIso: string, toIso: string): Promise<UserTeamRow[]>;
  /** Client tools from LiteLLM's auto-added User-Agent tags. */
  clientTools(fromIso: string, toIso: string): Promise<ClientToolRow[]>;
  /** Agents with any historical traffic, and when they were last seen. */
  agentsLastSeen(asOfIso: string): Promise<AgentLastSeenRow[]>;
}
```

- [ ] **Step 2: Write src/metrics/types.ts**

```ts
export type SensitivityPoint = { minutesPerPerson: number; returnMultiple: number };

export type BarPanel = {
  spendUsd: number;
  spendReporting: number;
  activePeople: number;
  costInHours: number;
  breakEvenMinutesPerPerson: number;
  attributionCoveragePct: number;
  unattributedSpendReporting: number;
  sensitivity: SensitivityPoint[];
};

export type RetentionCohort = {
  cohortMonth: string;
  cohortSize: number;
  points: { monthOffset: number; retained: number; pct: number }[];
};

export type TeamAdoption = {
  teamLabel: string;      // alias, or "Other" for sub-min-N roll-up
  activePeople: number;
  spendReporting: number;
  medianActiveDays: number;
};

export type ClientToolAdoption = {
  tool: string;
  spendReporting: number;
  activePeople: number;
  shareOfSpendPct: number;
};

export type AdoptionPanel = {
  activePeople: number;
  medianActiveDays: number;
  retention: RetentionCohort[];
  concentrationTop10PctOfSpendPct: number;
  concentrationTop10PctOfRequestsPct: number;
  teams: TeamAdoption[];
  clientTools: ClientToolAdoption[];
};

export type ReliabilityPanel = {
  apiRequests: number;
  successfulRequests: number;
  failedRequests: number;
  failureRatePct: number;
  automationRequests: number;
  automationSpendReporting: number;
  automationSharePct: number;
};

export type AbandonedAgent = {
  agentLabel: string;
  lastSeenDay: string | null;
  historicalSpendReporting: number;
};

/**
 * No seat roster exists in LiteLLM (UserTable: 7 rows vs 52 users in tags; TeamTable
 * empty), so there is no honest "dormant ÷ provisioned" percentage — dividing by 7 would
 * have reported a confidently wrong figure. Lapse is expressed against observed history
 * instead, which needs no roster.
 */
export type WastePanel = {
  activeThisMonth: number;
  activeInPriorWindow: number;   // distinct users active in the 3 months before this one
  lapsedUsers: number;           // active in the prior window, absent this month
  returningUsers: number;        // active this month, absent from the prior window
  abandonedAgents: AbandonedAgent[];
  modelMix: { model: string; spendReporting: number; sharePct: number }[];
};

export type Snapshot = {
  month: string;                  // YYYY-MM
  generatedAt: string;            // ISO
  reportingCurrency: string;
  fxRateUsdToReporting: number;
  fxRateSetOn: string;
  hourlyRate: number;
  minN: number;
  bar: BarPanel;
  adoption: AdoptionPanel;
  reliability: ReliabilityPanel;
  waste: WastePanel;
};
```

No per-person field exists anywhere in `Snapshot` — G4 is enforced by the type, not by
discipline in the renderer.

- [ ] **Step 3: Write the fake source and its test**

Create `src/litellm/source-fake.ts`:

```ts
import type {
  AgentLastSeenRow, ClientToolRow, DailyTagRow, LiteLLMSource, ModelSpendRow,
  MonthTotals, UserDayRow, UserMonthRow, UserTeamRow,
} from "./types";

export type FakeData = {
  monthTotals?: MonthTotals;
  dailyByTagPrefix?: Record<string, DailyTagRow[]>;
  spendWithTagPrefix?: Record<string, number>;
  humanUserDays?: UserDayRow[];
  humanUserMonths?: UserMonthRow[];
  automationTotals?: { requests: number; spendUsd: number };
  modelSpend?: ModelSpendRow[];
  userTeams?: UserTeamRow[];
  clientTools?: ClientToolRow[];
  agentsLastSeen?: AgentLastSeenRow[];
};

export function makeFakeSource(data: FakeData): LiteLLMSource {
  return {
    async monthTotals() {
      return data.monthTotals ?? {
        spendUsd: 0, apiRequests: 0, successfulRequests: 0, failedRequests: 0,
      };
    },
    async dailyByTagPrefix(_f, _t, prefix) { return data.dailyByTagPrefix?.[prefix] ?? []; },
    async spendWithTagPrefix(_f, _t, prefix) { return data.spendWithTagPrefix?.[prefix] ?? 0; },
    async humanUserDays() { return data.humanUserDays ?? []; },
    async humanUserMonths() { return data.humanUserMonths ?? []; },
    async automationTotals() { return data.automationTotals ?? { requests: 0, spendUsd: 0 }; },
    async modelSpend() { return data.modelSpend ?? []; },
    async userTeams() { return data.userTeams ?? []; },
    async clientTools() { return data.clientTools ?? []; },
    async agentsLastSeen() { return data.agentsLastSeen ?? []; },
  };
}
```

Create `tests/litellm/source-fake.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { makeFakeSource } from "../../src/litellm/source-fake";

describe("makeFakeSource", () => {
  it("returns configured rows for a prefix and empty for others", async () => {
    const src = makeFakeSource({
      dailyByTagPrefix: {
        "user_id_": [{ day: "2026-08-01", tag: "user_id_1", spendUsd: 1, requests: 2 }],
      },
    });
    expect(await src.dailyByTagPrefix("", "", "user_id_")).toHaveLength(1);
    expect(await src.dailyByTagPrefix("", "", "team_id_")).toEqual([]);
  });

  it("defaults totals to zero rather than undefined", async () => {
    const src = makeFakeSource({});
    expect((await src.monthTotals("", "")).spendUsd).toBe(0);
  });
});
```

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run tests/litellm/source-fake.test.ts`
Expected: 2 passed

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: litellm source contract, snapshot types, fake source"
```

---

### Task 6: SQL implementation of LiteLLMSource

**Files:**
- Create: `src/db/litellm.ts`, `src/litellm/source-sql.ts`
- Create: `tests/fixtures/seed-litellm.sql`
- Test: `tests/litellm/source-sql.integration.test.ts`

**Interfaces:**
- Consumes: `LiteLLMSource` from Task 5
- Produces: `createLiteLLMSource(connectionString: string): { source: LiteLLMSource; pool: pg.Pool }`

Reads `LiteLLM_SpendLogs` directly and expands `request_tags` with
`jsonb_array_elements_text`. This sidesteps the `DailyTagSpend` grain question entirely
and guarantees G1 correctness: totals come from row-level sums, tag breakdowns from
expansion within one dimension.

- [ ] **Step 1: Write the seed fixture**

Create `tests/fixtures/seed-litellm.sql` — a minimal subset of the real schema:

```sql
DROP TABLE IF EXISTS "LiteLLM_SpendLogs";
CREATE TABLE "LiteLLM_SpendLogs" (
  request_id     TEXT PRIMARY KEY,
  "startTime"    TIMESTAMPTZ NOT NULL,
  spend          DOUBLE PRECISION NOT NULL DEFAULT 0,
  model          TEXT,
  status         TEXT,
  request_tags   JSONB DEFAULT '[]'::jsonb
);

DROP TABLE IF EXISTS "LiteLLM_UserTable";
CREATE TABLE "LiteLLM_UserTable" (user_id TEXT PRIMARY KEY, team_id TEXT);

DROP TABLE IF EXISTS "LiteLLM_TeamTable";
CREATE TABLE "LiteLLM_TeamTable" (team_id TEXT PRIMARY KEY, team_alias TEXT);

-- Two users, one of them also driving an automated routine.
-- Tag shapes match production: LiteLLM auto-adds a coarse and a versioned
-- User-Agent tag to every request.
INSERT INTO "LiteLLM_SpendLogs" VALUES
 ('r1','2026-08-01T09:00:00Z', 1.00,'gpt-x','success',
    '["user_id_1","team_id_t1","team_name_eng","agent_id_a1",
      "User-Agent: claude-cli","User-Agent: claude-cli/2.1.170 (external, cli)"]'),
 ('r2','2026-08-01T10:00:00Z', 2.00,'gpt-x','success',
    '["user_id_1","team_id_t1","team_name_eng","agent_id_a1",
      "User-Agent: claude-cli","User-Agent: claude-cli/2.1.170 (external, cli)"]'),
 ('r3','2026-08-02T09:00:00Z', 4.00,'gpt-y','failure',
    '["user_id_2","team_id_t1","team_name_eng","User-Agent: ai-sdk"]'),
 ('r4','2026-08-03T09:00:00Z', 8.00,'gpt-y','success',
    '["user_id_1","routine_id_rt1","User-Agent: ai-sdk"]'),
 ('r5','2026-08-04T09:00:00Z',16.00,'gpt-y','success', '[]');

INSERT INTO "LiteLLM_UserTable" VALUES ('1','t1'), ('2','t1'), ('3','t1');
INSERT INTO "LiteLLM_TeamTable" VALUES ('t1','Engineering');
```

Total spend is 31.00. Spend carrying a `team_id_` tag is 7.00, so coverage is
7/31 ≈ 22.6% — a deliberately awkward number that will catch rounding errors.

- [ ] **Step 2: Write the failing integration test**

Create `tests/litellm/source-sql.integration.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { createLiteLLMSource } from "../../src/litellm/source-sql";

const URL = process.env.TEST_DATABASE_URL ?? "postgres://test:test@localhost:55432/test";
const FROM = "2026-08-01T00:00:00Z";
const TO = "2026-09-01T00:00:00Z";

let created: ReturnType<typeof createLiteLLMSource>;

beforeAll(async () => {
  const admin = new pg.Pool({ connectionString: URL });
  await admin.query(readFileSync("tests/fixtures/seed-litellm.sql", "utf8"));
  await admin.end();
  created = createLiteLLMSource(URL);
});

afterAll(async () => { await created.pool.end(); });

describe("source-sql", () => {
  it("takes totals from SpendLogs rows, not from tag expansion", async () => {
    const t = await created.source.monthTotals(FROM, TO);
    expect(t.spendUsd).toBeCloseTo(31.0, 6);
    expect(t.apiRequests).toBe(5);
    expect(t.successfulRequests).toBe(4);
    expect(t.failedRequests).toBe(1);
  });

  it("expands tags within one dimension without double counting", async () => {
    const rows = await created.source.dailyByTagPrefix(FROM, TO, "user_id_");
    const u1 = rows.filter((r) => r.tag === "user_id_1");
    expect(u1.reduce((s, r) => s + r.spendUsd, 0)).toBeCloseTo(11.0, 6);
  });

  it("computes spend carrying a given tag prefix for coverage", async () => {
    expect(await created.source.spendWithTagPrefix(FROM, TO, "team_id_")).toBeCloseTo(7.0, 6);
  });

  it("excludes routine-tagged requests from human user days", async () => {
    const days = await created.source.humanUserDays(FROM, TO);
    // r4 is user_id_1 on 08-03 but routine-tagged, so it must not appear.
    expect(days).toEqual(
      expect.arrayContaining([{ userId: "1", day: "2026-08-01" }, { userId: "2", day: "2026-08-02" }]),
    );
    expect(days).not.toContainEqual({ userId: "1", day: "2026-08-03" });
    expect(days).toHaveLength(2);
  });

  it("reports automation totals separately", async () => {
    const a = await created.source.automationTotals(FROM, TO);
    expect(a.requests).toBe(1);
    expect(a.spendUsd).toBeCloseTo(8.0, 6);
  });

  it("recovers user->team pairs from tag co-occurrence", async () => {
    const pairs = await created.source.userTeams(FROM, TO);
    expect(pairs).toEqual(
      expect.arrayContaining([
        { userId: "1", teamLabel: "eng" },
        { userId: "2", teamLabel: "eng" },
      ]),
    );
    expect(pairs).toHaveLength(2);   // deduplicated across r1/r2
  });

  it("counts client tools once, ignoring the versioned User-Agent variant", async () => {
    const tools = await created.source.clientTools(FROM, TO);
    const claude = tools.find((t) => t.tool === "claude-cli")!;
    // r1 + r2 only. If the versioned tag were also counted this would be 6.00.
    expect(claude.spendUsd).toBeCloseTo(3.0, 6);
    expect(claude.requests).toBe(2);
    expect(claude.activeUsers).toBe(1);
    expect(tools.some((t) => t.tool.includes("/"))).toBe(false);
  });
});
```

The routine-exclusion test is the one that matters most: counting a scheduled routine as
user retention would make the report's central adoption claim false.

- [ ] **Step 3: Start Postgres and run the test to confirm it fails**

```bash
docker compose -f docker-compose.test.yml up -d
pnpm vitest run tests/litellm/source-sql.integration.test.ts
```
Expected: FAIL — cannot find module `source-sql`

- [ ] **Step 4: Implement src/db/litellm.ts**

```ts
import pg from "pg";

/** Read-only pool (G2). Every connection is pinned read-only at checkout. */
export function createLiteLLMPool(connectionString: string): pg.Pool {
  return new pg.Pool({
    connectionString,
    max: 4,
    statement_timeout: 120_000,
    // pg-pool awaits onConnect before handing the client out. The `connect`
    // EVENT works too — measured, the pin does take effect — but it fires while
    // pg-pool is mid-dispatch, so the query emits a pg@8 DeprecationWarning and
    // the behaviour is removed in pg@9. Warnings also break the "pristine test
    // output" rule.
    onConnect: async (client) => {
      await client.query("SET default_transaction_read_only = on");
    },
  });
}
```

- [ ] **Step 5: Implement src/litellm/source-sql.ts**

```ts
import type pg from "pg";
import { createLiteLLMPool } from "../db/litellm";
import type {
  AgentLastSeenRow, DailyTagRow, LiteLLMSource, ModelSpendRow,
  ClientToolRow, MonthTotals, UserDayRow, UserMonthRow, UserTeamRow,
} from "./types";

const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));

export function createLiteLLMSource(connectionString: string): {
  source: LiteLLMSource; pool: pg.Pool;
} {
  const pool = createLiteLLMPool(connectionString);

  const source: LiteLLMSource = {
    async monthTotals(from, to) {
      const { rows } = await pool.query(
        `SELECT COALESCE(SUM(spend),0) AS spend,
                COUNT(*) AS requests,
                COUNT(*) FILTER (WHERE status = 'success') AS ok,
                COUNT(*) FILTER (WHERE status IS DISTINCT FROM 'success') AS bad
         FROM "LiteLLM_SpendLogs"
         WHERE "startTime" >= $1 AND "startTime" < $2`,
        [from, to],
      );
      const r = rows[0];
      return {
        spendUsd: num(r.spend), apiRequests: num(r.requests),
        successfulRequests: num(r.ok), failedRequests: num(r.bad),
      } satisfies MonthTotals;
    },

    async dailyByTagPrefix(from, to, prefix) {
      const { rows } = await pool.query(
        `SELECT to_char(s."startTime" AT TIME ZONE 'UTC','YYYY-MM-DD') AS day,
                t AS tag,
                COALESCE(SUM(s.spend),0) AS spend,
                COUNT(*) AS requests
         FROM "LiteLLM_SpendLogs" s,
              LATERAL jsonb_array_elements_text(s.request_tags::jsonb) AS t
         WHERE s."startTime" >= $1 AND s."startTime" < $2
           AND t LIKE $3 || '%'
         GROUP BY 1, 2`,
        [from, to, prefix],
      );
      return rows.map((r) => ({
        day: r.day, tag: r.tag, spendUsd: num(r.spend), requests: num(r.requests),
      })) satisfies DailyTagRow[];
    },

    async spendWithTagPrefix(from, to, prefix) {
      // Per-row EXISTS, so a request is counted once regardless of tag count (G1).
      const { rows } = await pool.query(
        `SELECT COALESCE(SUM(s.spend),0) AS spend
         FROM "LiteLLM_SpendLogs" s
         WHERE s."startTime" >= $1 AND s."startTime" < $2
           AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(s.request_tags::jsonb) t
                       WHERE t LIKE $3 || '%')`,
        [from, to, prefix],
      );
      return num(rows[0].spend);
    },

    async humanUserDays(from, to) {
      const { rows } = await pool.query(
        `SELECT DISTINCT
                substring(u from 9) AS user_id,
                to_char(s."startTime" AT TIME ZONE 'UTC','YYYY-MM-DD') AS day
         FROM "LiteLLM_SpendLogs" s,
              LATERAL jsonb_array_elements_text(s.request_tags::jsonb) AS u
         WHERE s."startTime" >= $1 AND s."startTime" < $2
           AND u LIKE 'user\\_id\\_%'
           AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(s.request_tags::jsonb) r
                           WHERE r LIKE 'routine\\_id\\_%')`,
        [from, to],
      );
      return rows.map((r) => ({ userId: r.user_id, day: r.day })) satisfies UserDayRow[];
    },

    async humanUserMonths(from, to) {
      const { rows } = await pool.query(
        `SELECT DISTINCT
                substring(u from 9) AS user_id,
                to_char(s."startTime" AT TIME ZONE 'UTC','YYYY-MM') AS month
         FROM "LiteLLM_SpendLogs" s,
              LATERAL jsonb_array_elements_text(s.request_tags::jsonb) AS u
         WHERE s."startTime" >= $1 AND s."startTime" < $2
           AND u LIKE 'user\\_id\\_%'
           AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(s.request_tags::jsonb) r
                           WHERE r LIKE 'routine\\_id\\_%')`,
        [from, to],
      );
      return rows.map((r) => ({ userId: r.user_id, month: r.month })) satisfies UserMonthRow[];
    },

    async automationTotals(from, to) {
      const { rows } = await pool.query(
        `SELECT COUNT(*) AS requests, COALESCE(SUM(spend),0) AS spend
         FROM "LiteLLM_SpendLogs" s
         WHERE s."startTime" >= $1 AND s."startTime" < $2
           AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(s.request_tags::jsonb) r
                       WHERE r LIKE 'routine\\_id\\_%')`,
        [from, to],
      );
      return { requests: num(rows[0].requests), spendUsd: num(rows[0].spend) };
    },

    async modelSpend(from, to) {
      const { rows } = await pool.query(
        `SELECT COALESCE(model,'unknown') AS model, COALESCE(SUM(spend),0) AS spend
         FROM "LiteLLM_SpendLogs"
         WHERE "startTime" >= $1 AND "startTime" < $2
         GROUP BY 1 ORDER BY 2 DESC`,
        [from, to],
      );
      return rows.map((r) => ({ model: r.model, spendUsd: num(r.spend) })) satisfies ModelSpendRow[];
    },

    async userTeams(from, to) {
      // Co-occurrence on the same row: the user tag and the team tag from one request.
      // LiteLLM_UserTable/TeamTable cannot serve this — Phase 0 found 7 rows and 0 rows
      // respectively against 52 users actually seen in tags.
      const { rows } = await pool.query(
        `SELECT DISTINCT substring(u from 9) AS user_id, substring(t from 11) AS team_label
         FROM "LiteLLM_SpendLogs" s,
              LATERAL jsonb_array_elements_text(s.request_tags::jsonb) AS u,
              LATERAL jsonb_array_elements_text(s.request_tags::jsonb) AS t
         WHERE s."startTime" >= $1 AND s."startTime" < $2
           AND u LIKE 'user\\_id\\_%' AND t LIKE 'team\\_name\\_%'`,
        [from, to],
      );
      return rows.map((r) => ({
        userId: r.user_id, teamLabel: r.team_label,
      })) satisfies UserTeamRow[];
    },

    async clientTools(from, to) {
      // One row per request: pull the coarse tool tag and the user tag, then group.
      // LiteLLM emits both "User-Agent: claude-cli" and a versioned variant containing
      // "/"; counting both would double every tool's spend, so the versioned form is
      // excluded here as well as in parseClientTool().
      // Verified against production: July claude-cli = 3777.33 / 46,602 req / 28 users.
      const { rows } = await pool.query(
        `SELECT tool,
                COALESCE(SUM(spend),0) AS spend,
                COUNT(*) AS requests,
                COUNT(DISTINCT user_id) AS users
         FROM (
           SELECT s.spend,
             (SELECT substring(x from 13) FROM jsonb_array_elements_text(s.request_tags::jsonb) x
              WHERE x LIKE 'User-Agent: %' AND x NOT LIKE '%/%' LIMIT 1) AS tool,
             (SELECT substring(x from 9) FROM jsonb_array_elements_text(s.request_tags::jsonb) x
              WHERE x LIKE 'user\\_id\\_%' LIMIT 1) AS user_id
           FROM "LiteLLM_SpendLogs" s
           WHERE s."startTime" >= $1 AND s."startTime" < $2
         ) z
         WHERE tool IS NOT NULL
         GROUP BY 1 ORDER BY 2 DESC`,
        [from, to],
      );
      return rows.map((r) => ({
        tool: r.tool, spendUsd: num(r.spend),
        requests: num(r.requests), activeUsers: num(r.users),
      })) satisfies ClientToolRow[];
    },

    async agentsLastSeen(asOf) {
      const { rows } = await pool.query(
        `SELECT substring(t from 10) AS agent_id,
                to_char(MAX(s."startTime") AT TIME ZONE 'UTC','YYYY-MM-DD') AS last_seen,
                COALESCE(SUM(s.spend),0) AS spend
         FROM "LiteLLM_SpendLogs" s,
              LATERAL jsonb_array_elements_text(s.request_tags::jsonb) AS t
         WHERE s."startTime" < $1 AND t LIKE 'agent\\_id\\_%'
         GROUP BY 1`,
        [asOf],
      );
      return rows.map((r) => ({
        agentId: r.agent_id, agentName: null,
        lastSeenDay: r.last_seen, historicalSpendUsd: num(r.spend),
      })) satisfies AgentLastSeenRow[];
    },
  };

  return { source, pool };
}
```

`substring(u from 9)` strips `user_id_` (8 chars); `substring(t from 10)` strips
`agent_id_` (9 chars); `substring(t from 11)` strips `team_name_` (10 chars);
`substring(x from 13)` strips `User-Agent: ` (12 chars). All covered by the Task 6 tests.

**Two things production taught us about these queries — do not "simplify" them away:**

1. **A user can carry more than one team tag.** In July, one of 45 users appears under two
   teams. Left unresolved, summing per-team `activePeople` yields 46 for 45 people and the
   team table silently stops adding up. Task 8 must collapse each user to exactly one team
   deterministically — see the rule there.
2. **`SpendLogs` and `DailyTagSpend` do not reconcile exactly.** July claude-cli is
   $3,777.33 from `SpendLogs` against $3,765.90 from `DailyTagSpend` — 0.3% apart, almost
   certainly a UTC day-boundary difference. Both are internally consistent; mixing them in
   one figure is not. **`SpendLogs` is the single source for every number in the report.**

- [ ] **Step 6: Run the integration test**

Run: `pnpm vitest run tests/litellm/source-sql.integration.test.ts`
Expected: 7 passed

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat: read-only sql source over litellm spendlogs"
```

---

### Task 7: Panel 1 — The Bar

**Files:**
- Create: `src/metrics/bar.ts`
- Test: `tests/metrics/bar.test.ts`

**Interfaces:**
- Consumes: `LiteLLMSource`, `BarPanel`
- Produces: `buildBar(src, opts): Promise<BarPanel>` where
  `opts = { fromIso, toIso, hourlyRate, fxRateUsdToReporting }`

- [ ] **Step 1: Write the failing test**

Create `tests/metrics/bar.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { makeFakeSource } from "../../src/litellm/source-fake";
import { buildBar } from "../../src/metrics/bar";

const OPTS = {
  fromIso: "2026-08-01T00:00:00Z", toIso: "2026-09-01T00:00:00Z",
  hourlyRate: 140, fxRateUsdToReporting: 1,
};

function src(overrides = {}) {
  return makeFakeSource({
    monthTotals: { spendUsd: 4847, apiRequests: 100, successfulRequests: 100, failedRequests: 0 },
    spendWithTagPrefix: { "team_id_": 4652.12 },
    humanUserDays: Array.from({ length: 41 }, (_, i) => ({
      userId: String(i + 1), day: "2026-08-01",
    })),
    ...overrides,
  });
}

describe("buildBar", () => {
  it("computes the headline figures from the spec's worked example", async () => {
    const bar = await buildBar(src(), OPTS);
    expect(bar.spendReporting).toBeCloseTo(4847, 2);
    expect(bar.activePeople).toBe(41);
    expect(bar.costInHours).toBeCloseTo(34.62, 2);
    expect(bar.breakEvenMinutesPerPerson).toBeCloseTo(50.7, 1);
  });

  it("applies the FX rate to reporting figures but leaves USD untouched", async () => {
    const bar = await buildBar(src(), { ...OPTS, fxRateUsdToReporting: 0.5 });
    expect(bar.spendUsd).toBeCloseTo(4847, 2);
    expect(bar.spendReporting).toBeCloseTo(2423.5, 2);
    // Halving the reporting spend halves the hours needed to break even.
    expect(bar.costInHours).toBeCloseTo(17.31, 2);
  });

  it("reports attribution coverage and the unattributed remainder", async () => {
    const bar = await buildBar(src(), OPTS);
    expect(bar.attributionCoveragePct).toBeCloseTo(95.98, 2);
    expect(bar.unattributedSpendReporting).toBeCloseTo(194.88, 2);
  });

  it("builds the sensitivity strip at 30/60/120 minutes", async () => {
    const bar = await buildBar(src(), OPTS);
    expect(bar.sensitivity.map((s) => s.minutesPerPerson)).toEqual([30, 60, 120]);
    // 41 people x 1h x 140 = 5740 against 4847 spend
    expect(bar.sensitivity[1]!.returnMultiple).toBeCloseTo(1.18, 2);
  });

  it("does not divide by zero when nobody was active", async () => {
    const bar = await buildBar(src({ humanUserDays: [] }), OPTS);
    expect(bar.activePeople).toBe(0);
    expect(bar.breakEvenMinutesPerPerson).toBe(0);
    expect(bar.sensitivity.every((s) => s.returnMultiple === 0)).toBe(true);
  });

  it("reports 100% coverage when there is no spend at all", async () => {
    const bar = await buildBar(
      src({
        monthTotals: { spendUsd: 0, apiRequests: 0, successfulRequests: 0, failedRequests: 0 },
        spendWithTagPrefix: { "team_id_": 0 },
      }),
      OPTS,
    );
    expect(bar.attributionCoveragePct).toBe(100);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `pnpm vitest run tests/metrics/bar.test.ts`
Expected: FAIL — cannot find module `../../src/metrics/bar`

- [ ] **Step 3: Implement src/metrics/bar.ts**

```ts
import type { LiteLLMSource } from "../litellm/types";
import type { BarPanel, SensitivityPoint } from "./types";

export type BarOptions = {
  fromIso: string;
  toIso: string;
  hourlyRate: number;
  fxRateUsdToReporting: number;
};

const SENSITIVITY_MINUTES = [30, 60, 120];

export async function buildBar(src: LiteLLMSource, opts: BarOptions): Promise<BarPanel> {
  const totals = await src.monthTotals(opts.fromIso, opts.toIso);
  const attributed = await src.spendWithTagPrefix(opts.fromIso, opts.toIso, "team_id_");
  const days = await src.humanUserDays(opts.fromIso, opts.toIso);

  const activePeople = new Set(days.map((d) => d.userId)).size;
  const spendReporting = totals.spendUsd * opts.fxRateUsdToReporting;
  const costInHours = spendReporting / opts.hourlyRate;

  const breakEvenMinutesPerPerson =
    activePeople > 0 ? (costInHours / activePeople) * 60 : 0;

  const sensitivity: SensitivityPoint[] = SENSITIVITY_MINUTES.map((minutesPerPerson) => {
    const valueSaved = activePeople * (minutesPerPerson / 60) * opts.hourlyRate;
    return {
      minutesPerPerson,
      returnMultiple: spendReporting > 0 ? valueSaved / spendReporting : 0,
    };
  });

  // No spend means nothing is unattributed, so coverage is trivially complete.
  const attributionCoveragePct =
    totals.spendUsd > 0 ? (attributed / totals.spendUsd) * 100 : 100;

  return {
    spendUsd: totals.spendUsd,
    spendReporting,
    activePeople,
    costInHours,
    breakEvenMinutesPerPerson,
    attributionCoveragePct,
    unattributedSpendReporting:
      (totals.spendUsd - attributed) * opts.fxRateUsdToReporting,
    sensitivity,
  };
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run tests/metrics/bar.test.ts`
Expected: 6 passed

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: panel 1 break-even bar with coverage and sensitivity"
```

---

### Task 8: Panel 2 — Adoption

**Files:**
- Create: `src/metrics/min-n.ts`, `src/metrics/adoption.ts`
- Test: `tests/metrics/min-n.test.ts`, `tests/metrics/adoption.test.ts`

**Interfaces:**
- Consumes: `LiteLLMSource`, `AdoptionPanel`, `TeamAdoption`, `RetentionCohort`
- Produces: `median(xs: number[]): number`,
  `rollUpBelowMinN(teams: TeamAdoption[], minN: number): TeamAdoption[]`,
  `buildAdoption(src, opts): Promise<AdoptionPanel>` where
  `opts = { fromIso, toIso, month, retentionMonths, fxRateUsdToReporting, minN }`

- [ ] **Step 1: Write the failing min-N test**

Create `tests/metrics/min-n.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { median, rollUpBelowMinN } from "../../src/metrics/min-n";

const team = (teamLabel: string, activePeople: number, spendReporting: number) => ({
  teamLabel, activePeople, spendReporting, medianActiveDays: 1,
});

describe("median", () => {
  it("returns the middle value for odd counts", () => {
    expect(median([3, 1, 2])).toBe(2);
  });
  it("averages the two middle values for even counts", () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });
  it("returns 0 for an empty list", () => {
    expect(median([])).toBe(0);
  });
});

describe("rollUpBelowMinN", () => {
  it("keeps teams at or above the threshold", () => {
    const out = rollUpBelowMinN([team("Eng", 5, 100)], 5);
    expect(out).toEqual([team("Eng", 5, 100)]);
  });

  it("merges sub-threshold teams into Other", () => {
    const out = rollUpBelowMinN([team("Eng", 9, 100), team("Ops", 2, 30), team("HR", 1, 10)], 5);
    expect(out).toHaveLength(2);
    const other = out.find((t) => t.teamLabel === "Other")!;
    expect(other.activePeople).toBe(3);
    expect(other.spendReporting).toBe(40);
  });

  it("does not emit an Other row when nothing falls below", () => {
    const out = rollUpBelowMinN([team("Eng", 9, 100)], 5);
    expect(out.some((t) => t.teamLabel === "Other")).toBe(false);
  });

  it("still merges when the combined Other group is itself small", () => {
    // One 1-person team must never be published under its own name.
    const out = rollUpBelowMinN([team("Eng", 9, 100), team("Solo", 1, 5)], 5);
    expect(out.map((t) => t.teamLabel).sort()).toEqual(["Eng", "Other"]);
  });
});
```

That last case is the privacy trap: a one-person team is a named individual (G4).

- [ ] **Step 2: Run it to confirm it fails**

Run: `pnpm vitest run tests/metrics/min-n.test.ts`
Expected: FAIL — cannot find module

- [ ] **Step 3: Implement src/metrics/min-n.ts**

```ts
import type { TeamAdoption } from "./types";

export function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/**
 * Teams with fewer than `minN` active people are merged into "Other" (G4).
 * The merged row is published even if it is itself below the threshold —
 * it names no individual, which is the property that matters.
 */
export function rollUpBelowMinN(teams: TeamAdoption[], minN: number): TeamAdoption[] {
  const kept = teams.filter((t) => t.activePeople >= minN);
  const merged = teams.filter((t) => t.activePeople < minN);
  if (merged.length === 0) return kept;

  return [
    ...kept,
    {
      teamLabel: "Other",
      activePeople: merged.reduce((s, t) => s + t.activePeople, 0),
      spendReporting: merged.reduce((s, t) => s + t.spendReporting, 0),
      medianActiveDays: median(merged.map((t) => t.medianActiveDays)),
    },
  ];
}
```

- [ ] **Step 4: Write the failing adoption test**

Create `tests/metrics/adoption.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { makeFakeSource } from "../../src/litellm/source-fake";
import { buildAdoption } from "../../src/metrics/adoption";

const OPTS = {
  fromIso: "2026-08-01T00:00:00Z", toIso: "2026-09-01T00:00:00Z",
  retentionFromIso: "2025-08-01T00:00:00Z",
  month: "2026-08", retentionMonths: 3, fxRateUsdToReporting: 1, minN: 2,
};

describe("buildAdoption", () => {
  it("counts active people and median active days", async () => {
    const src = makeFakeSource({
      humanUserDays: [
        { userId: "1", day: "2026-08-01" },
        { userId: "1", day: "2026-08-02" },
        { userId: "1", day: "2026-08-03" },
        { userId: "2", day: "2026-08-01" },
      ],
    });
    const a = await buildAdoption(src, OPTS);
    expect(a.activePeople).toBe(2);
    expect(a.medianActiveDays).toBe(2); // median of [3, 1]
  });

  it("builds retention cohorts from first-seen month", async () => {
    const src = makeFakeSource({
      humanUserMonths: [
        { userId: "1", month: "2026-06" },
        { userId: "1", month: "2026-07" },
        { userId: "1", month: "2026-08" },
        { userId: "2", month: "2026-06" },
        // user 2 churns after its first month
      ],
    });
    const a = await buildAdoption(src, OPTS);
    const june = a.retention.find((c) => c.cohortMonth === "2026-06")!;
    expect(june.cohortSize).toBe(2);
    expect(june.points.find((p) => p.monthOffset === 1)!.retained).toBe(1);
    expect(june.points.find((p) => p.monthOffset === 1)!.pct).toBe(50);
    expect(june.points.find((p) => p.monthOffset === 2)!.retained).toBe(1);
  });

  it("computes top-10% spend concentration", async () => {
    // 10 users; the top 10% is 1 user holding 50 of 100 total spend.
    const rows = Array.from({ length: 10 }, (_, i) => ({
      day: "2026-08-01",
      tag: `user_id_${i + 1}`,
      spendUsd: i === 0 ? 50 : 50 / 9,
      requests: 1,
    }));
    const src = makeFakeSource({ dailyByTagPrefix: { "user_id_": rows } });
    const a = await buildAdoption(src, OPTS);
    expect(a.concentrationTop10PctOfSpendPct).toBeCloseTo(50, 4);
  });

  it("applies min-N to team rows", async () => {
    const src = makeFakeSource({
      humanUserDays: [
        { userId: "1", day: "2026-08-01" },
        { userId: "2", day: "2026-08-01" },
        { userId: "3", day: "2026-08-01" },
      ],
      userTeams: [
        { userId: "1", teamLabel: "Eng" },
        { userId: "2", teamLabel: "Eng" },
        { userId: "3", teamLabel: "Solo" },
      ],
    });
    const a = await buildAdoption(src, OPTS);
    expect(a.teams.map((t) => t.teamLabel).sort()).toEqual(["Eng", "Other"]);
  });

  it("collapses a user carrying two team tags to exactly one team", async () => {
    // Production has one such user. Without collapsing, per-team activePeople sums to
    // more than the actual headcount and the team table stops adding up.
    const src = makeFakeSource({
      humanUserDays: [
        { userId: "1", day: "2026-08-01" },
        { userId: "2", day: "2026-08-01" },
      ],
      userTeams: [
        { userId: "1", teamLabel: "Beta" },
        { userId: "1", teamLabel: "Alpha" },
        { userId: "2", teamLabel: "Alpha" },
      ],
    });
    const a = await buildAdoption(src, { ...OPTS, minN: 1 });
    expect(a.teams.reduce((s, t) => s + t.activePeople, 0)).toBe(2);
    expect(a.teams.find((t) => t.teamLabel === "Alpha")!.activePeople).toBe(2);
    expect(a.teams.some((t) => t.teamLabel === "Beta")).toBe(false);
  });

  it("reports client tools with spend shares", async () => {
    const src = makeFakeSource({
      clientTools: [
        { tool: "claude-cli", spendUsd: 75, requests: 100, activeUsers: 8 },
        { tool: "ai-sdk", spendUsd: 25, requests: 40, activeUsers: 3 },
      ],
    });
    const a = await buildAdoption(src, OPTS);
    expect(a.clientTools[0]).toEqual({
      tool: "claude-cli", spendReporting: 75, activePeople: 8, shareOfSpendPct: 75,
    });
  });
});
```

- [ ] **Step 5: Run it to confirm it fails**

Run: `pnpm vitest run tests/metrics/adoption.test.ts`
Expected: FAIL — cannot find module

- [ ] **Step 6: Implement src/metrics/adoption.ts**

```ts
import type { LiteLLMSource } from "../litellm/types";
import { parseTag } from "./tags";
import { median, rollUpBelowMinN } from "./min-n";
import type { AdoptionPanel, RetentionCohort, TeamAdoption } from "./types";

export type AdoptionOptions = {
  /** The reporting month — used for activity, spend and concentration. */
  fromIso: string;
  toIso: string;
  /** Start of the cohort history window — used ONLY for retention. */
  retentionFromIso: string;
  month: string;            // YYYY-MM
  retentionMonths: number;  // how many offsets to report
  fxRateUsdToReporting: number;
  minN: number;
};

function addMonths(month: string, n: number): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function topDecileSharePct(values: number[]): number {
  if (values.length === 0) return 0;
  const total = values.reduce((s, v) => s + v, 0);
  if (total === 0) return 0;
  const sorted = [...values].sort((a, b) => b - a);
  const k = Math.max(1, Math.ceil(sorted.length * 0.1));
  const top = sorted.slice(0, k).reduce((s, v) => s + v, 0);
  return (top / total) * 100;
}

export async function buildAdoption(
  src: LiteLLMSource, opts: AdoptionOptions,
): Promise<AdoptionPanel> {
  // Activity and spend are month-scoped; only cohorts look back further.
  const days = await src.humanUserDays(opts.fromIso, opts.toIso);
  const months = await src.humanUserMonths(opts.retentionFromIso, opts.toIso);
  const userRows = await src.dailyByTagPrefix(opts.fromIso, opts.toIso, "user_id_");
  const userTeamRows = await src.userTeams(opts.fromIso, opts.toIso);
  const toolRows = await src.clientTools(opts.fromIso, opts.toIso);

  // Active days per user
  const daysByUser = new Map<string, Set<string>>();
  for (const d of days) {
    if (!daysByUser.has(d.userId)) daysByUser.set(d.userId, new Set());
    daysByUser.get(d.userId)!.add(d.day);
  }

  // Spend and requests per user, from the user_id_ dimension only (G1)
  const spendByUser = new Map<string, number>();
  const requestsByUser = new Map<string, number>();
  for (const row of userRows) {
    const parsed = parseTag(row.tag);
    if (!parsed || parsed.dimension !== "user_id") continue;
    spendByUser.set(parsed.value, (spendByUser.get(parsed.value) ?? 0) + row.spendUsd);
    requestsByUser.set(parsed.value, (requestsByUser.get(parsed.value) ?? 0) + row.requests);
  }

  // Retention: cohort by first month seen
  const monthsByUser = new Map<string, Set<string>>();
  for (const m of months) {
    if (!monthsByUser.has(m.userId)) monthsByUser.set(m.userId, new Set());
    monthsByUser.get(m.userId)!.add(m.month);
  }
  const cohortMembers = new Map<string, string[]>();
  for (const [userId, set] of monthsByUser) {
    const first = [...set].sort()[0]!;
    if (!cohortMembers.has(first)) cohortMembers.set(first, []);
    cohortMembers.get(first)!.push(userId);
  }
  const retention: RetentionCohort[] = [...cohortMembers.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([cohortMonth, members]) => ({
      cohortMonth,
      cohortSize: members.length,
      // Only emit points whose target month has actually elapsed. A July report
      // covering a July cohort cannot know its M+1 yet; emitting 0% there would
      // read as total churn rather than "not observable", on the very panel the
      // report's argument rests on. Verified against production: the June cohort
      // showed M+2 0% purely because the window stopped at the reporting month.
      points: Array.from({ length: opts.retentionMonths }, (_, i) => i + 1)
        .filter((offset) => addMonths(cohortMonth, offset) <= opts.month)
        .map((offset) => {
          const target = addMonths(cohortMonth, offset);
          const retained = members.filter((u) => monthsByUser.get(u)?.has(target)).length;
          return {
            monthOffset: offset,
            retained,
            pct: members.length > 0 ? (retained / members.length) * 100 : 0,
          };
        }),
    }));

  // Teams. A user may carry more than one team tag (one of 45 did in production), so
  // collapse to exactly one team per user — otherwise per-team activePeople sums to more
  // than the headcount and the table stops adding up. Deterministic rule: the
  // alphabetically first label, so the same input always yields the same report.
  const teamOf = new Map<string, string>();
  for (const { userId, teamLabel } of userTeamRows) {
    const current = teamOf.get(userId);
    if (current === undefined || teamLabel < current) teamOf.set(userId, teamLabel);
  }

  const byTeam = new Map<string, { users: Set<string>; spend: number; days: number[] }>();
  for (const [userId, daySet] of daysByUser) {
    const label = teamOf.get(userId) ?? "Unassigned";
    if (!byTeam.has(label)) byTeam.set(label, { users: new Set(), spend: 0, days: [] });
    const entry = byTeam.get(label)!;
    entry.users.add(userId);
    entry.spend += spendByUser.get(userId) ?? 0;
    entry.days.push(daySet.size);
  }
  const teams: TeamAdoption[] = [...byTeam.entries()].map(([teamLabel, e]) => ({
    teamLabel,
    activePeople: e.users.size,
    spendReporting: e.spend * opts.fxRateUsdToReporting,
    medianActiveDays: median(e.days),
  }));

  const toolSpendTotal = toolRows.reduce((s, t) => s + t.spendUsd, 0);
  const clientTools = toolRows.map((t) => ({
    tool: t.tool,
    spendReporting: t.spendUsd * opts.fxRateUsdToReporting,
    activePeople: t.activeUsers,
    shareOfSpendPct: toolSpendTotal > 0 ? (t.spendUsd / toolSpendTotal) * 100 : 0,
  }));

  return {
    activePeople: daysByUser.size,
    medianActiveDays: median([...daysByUser.values()].map((s) => s.size)),
    retention,
    concentrationTop10PctOfSpendPct: topDecileSharePct([...spendByUser.values()]),
    concentrationTop10PctOfRequestsPct: topDecileSharePct([...requestsByUser.values()]),
    teams: rollUpBelowMinN(teams, opts.minN),
    clientTools,
  };
}
```

- [ ] **Step 7: Run the tests**

Run: `pnpm vitest run tests/metrics/min-n.test.ts tests/metrics/adoption.test.ts`
Expected: 11 passed

- [ ] **Step 8: Commit**

```bash
git add -A && git commit -m "feat: panel 2 adoption with retention cohorts and min-n rollup"
```

---

### Task 9: Panels 3 and 4 — Reliability and Waste

**Files:**
- Create: `src/metrics/reliability.ts`, `src/metrics/waste.ts`
- Test: `tests/metrics/reliability.test.ts`, `tests/metrics/waste.test.ts`

**Interfaces:**
- Produces: `buildReliability(src, opts): Promise<ReliabilityPanel>` with
  `opts = { fromIso, toIso, fxRateUsdToReporting }`;
  `buildWaste(src, opts): Promise<WastePanel>` with
  `opts = { fromIso, toIso, priorWindowFromIso, abandonedBeforeDay, fxRateUsdToReporting }`

Spend cannot be attributed to failed requests — the daily tables carry success and
failure counts but not spend split by outcome, and `SpendLogs.spend` is per row without a
per-outcome breakdown available in aggregate. The panel therefore reports failure *rate*
only. This omission is listed in the report appendix rather than papered over.

- [ ] **Step 1: Write the failing tests**

Create `tests/metrics/reliability.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { makeFakeSource } from "../../src/litellm/source-fake";
import { buildReliability } from "../../src/metrics/reliability";

const OPTS = { fromIso: "a", toIso: "b", fxRateUsdToReporting: 2 };

describe("buildReliability", () => {
  it("computes failure rate and automation share", async () => {
    const src = makeFakeSource({
      monthTotals: { spendUsd: 100, apiRequests: 200, successfulRequests: 190, failedRequests: 10 },
      automationTotals: { requests: 50, spendUsd: 30 },
    });
    const r = await buildReliability(src, OPTS);
    expect(r.failureRatePct).toBeCloseTo(5, 6);
    expect(r.automationSharePct).toBeCloseTo(25, 6);
    expect(r.automationSpendReporting).toBeCloseTo(60, 6);
  });

  it("returns zero rates rather than NaN when there is no traffic", async () => {
    const r = await buildReliability(makeFakeSource({}), OPTS);
    expect(r.failureRatePct).toBe(0);
    expect(r.automationSharePct).toBe(0);
  });
});
```

Create `tests/metrics/waste.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { makeFakeSource } from "../../src/litellm/source-fake";
import { buildWaste } from "../../src/metrics/waste";

const OPTS = {
  fromIso: "2026-08-01T00:00:00Z", toIso: "2026-09-01T00:00:00Z",
  priorWindowFromIso: "2026-05-01T00:00:00Z",
  abandonedBeforeDay: "2026-08-01",
  fxRateUsdToReporting: 1,
};

describe("buildWaste", () => {
  it("counts lapsed and returning users against observed history, not a roster", async () => {
    // The fake returns the same rows for any window, so drive the two windows apart
    // by stubbing humanUserDays per call.
    const thisMonth = [{ userId: "1", day: "2026-08-05" }, { userId: "9", day: "2026-08-06" }];
    const priorWin = [{ userId: "1", day: "2026-06-05" }, { userId: "2", day: "2026-06-06" },
                      { userId: "3", day: "2026-07-07" }];
    let call = 0;
    const src = {
      ...makeFakeSource({}),
      async humanUserDays() { return call++ === 0 ? thisMonth : priorWin; },
    };
    const w = await buildWaste(src, OPTS);
    expect(w.activeThisMonth).toBe(2);       // users 1, 9
    expect(w.activeInPriorWindow).toBe(3);   // users 1, 2, 3
    expect(w.lapsedUsers).toBe(2);           // 2 and 3 stopped
    expect(w.returningUsers).toBe(1);        // 9 is new
  });

  it("exposes no provisioned-seat denominator", async () => {
    // LiteLLM has no roster (7 UserTable rows vs 52 real users), so any percentage
    // against a provisioned count would be confidently wrong.
    const w = await buildWaste(makeFakeSource({}), OPTS);
    expect(w).not.toHaveProperty("provisionedUserCount");
    expect(w).not.toHaveProperty("dormantUserPct");
  });

  it("flags agents last seen before the cutoff as abandoned", async () => {
    const src = makeFakeSource({
      agentsLastSeen: [
        { agentId: "a1", agentName: null, lastSeenDay: "2026-08-20", historicalSpendUsd: 5 },
        { agentId: "a2", agentName: null, lastSeenDay: "2026-05-01", historicalSpendUsd: 90 },
        { agentId: "a3", agentName: null, lastSeenDay: null, historicalSpendUsd: 1 },
      ],
    });
    const w = await buildWaste(src, OPTS);
    expect(w.abandonedAgents.map((a) => a.agentLabel)).toEqual(["a2", "a3"]);
    // Sorted by wasted spend, largest first, so the actionable one leads.
    expect(w.abandonedAgents[0]!.historicalSpendReporting).toBe(90);
  });

  it("computes model mix shares", async () => {
    const src = makeFakeSource({
      modelSpend: [{ model: "gpt-x", spendUsd: 75 }, { model: "gpt-y", spendUsd: 25 }],
    });
    const w = await buildWaste(src, OPTS);
    expect(w.modelMix[0]).toEqual({ model: "gpt-x", spendReporting: 75, sharePct: 75 });
  });

  it("names agents but never people", async () => {
    const src = makeFakeSource({
      humanUserDays: [{ userId: "secret-person", day: "2026-08-01" }],
    });
    const w = await buildWaste(src, OPTS);
    expect(JSON.stringify(w)).not.toContain("secret-person");
  });
});
```

- [ ] **Step 2: Run them to confirm they fail**

Run: `pnpm vitest run tests/metrics/reliability.test.ts tests/metrics/waste.test.ts`
Expected: FAIL — cannot find modules

- [ ] **Step 3: Implement src/metrics/reliability.ts**

```ts
import type { LiteLLMSource } from "../litellm/types";
import type { ReliabilityPanel } from "./types";

export type ReliabilityOptions = {
  fromIso: string; toIso: string; fxRateUsdToReporting: number;
};

export async function buildReliability(
  src: LiteLLMSource, opts: ReliabilityOptions,
): Promise<ReliabilityPanel> {
  const totals = await src.monthTotals(opts.fromIso, opts.toIso);
  const automation = await src.automationTotals(opts.fromIso, opts.toIso);
  const pct = (n: number) => (totals.apiRequests > 0 ? (n / totals.apiRequests) * 100 : 0);

  return {
    apiRequests: totals.apiRequests,
    successfulRequests: totals.successfulRequests,
    failedRequests: totals.failedRequests,
    failureRatePct: pct(totals.failedRequests),
    automationRequests: automation.requests,
    automationSpendReporting: automation.spendUsd * opts.fxRateUsdToReporting,
    automationSharePct: pct(automation.requests),
  };
}
```

- [ ] **Step 4: Implement src/metrics/waste.ts**

```ts
import type { LiteLLMSource } from "../litellm/types";
import type { AbandonedAgent, WastePanel } from "./types";

export type WasteOptions = {
  fromIso: string;
  toIso: string;
  /** Start of the prior window used for lapse detection (3 months before this month). */
  priorWindowFromIso: string;
  /** Agents last seen strictly before this day are abandoned (YYYY-MM-DD). */
  abandonedBeforeDay: string;
  fxRateUsdToReporting: number;
};

export async function buildWaste(
  src: LiteLLMSource, opts: WasteOptions,
): Promise<WastePanel> {
  const thisMonth = await src.humanUserDays(opts.fromIso, opts.toIso);
  const prior = await src.humanUserDays(opts.priorWindowFromIso, opts.fromIso);
  const agents = await src.agentsLastSeen(opts.toIso);
  const models = await src.modelSpend(opts.fromIso, opts.toIso);

  // No seat roster exists in LiteLLM, so lapse is measured against observed history
  // rather than a provisioned denominator. See WastePanel's note.
  const nowSet = new Set(thisMonth.map((d) => d.userId));
  const priorSet = new Set(prior.map((d) => d.userId));
  const lapsedUsers = [...priorSet].filter((u) => !nowSet.has(u)).length;
  const returningUsers = [...nowSet].filter((u) => !priorSet.has(u)).length;

  const abandonedAgents: AbandonedAgent[] = agents
    .filter((a) => a.lastSeenDay === null || a.lastSeenDay < opts.abandonedBeforeDay)
    .map((a) => ({
      agentLabel: a.agentName ?? a.agentId,
      lastSeenDay: a.lastSeenDay,
      historicalSpendReporting: a.historicalSpendUsd * opts.fxRateUsdToReporting,
    }))
    .sort((x, y) => y.historicalSpendReporting - x.historicalSpendReporting);

  const totalModelSpend = models.reduce((s, m) => s + m.spendUsd, 0);

  return {
    activeThisMonth: nowSet.size,
    activeInPriorWindow: priorSet.size,
    lapsedUsers,
    returningUsers,
    abandonedAgents,
    modelMix: models.map((m) => ({
      model: m.model,
      spendReporting: m.spendUsd * opts.fxRateUsdToReporting,
      sharePct: totalModelSpend > 0 ? (m.spendUsd / totalModelSpend) * 100 : 0,
    })),
  };
}
```

- [ ] **Step 5: Run the tests**

Run: `pnpm vitest run tests/metrics/reliability.test.ts tests/metrics/waste.test.ts`
Expected: 6 passed

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat: panels 3 and 4 reliability and waste ledger"
```

---

### Task 10: Snapshot build, completeness guard, and freeze

**Files:**
- Create: `src/snapshot/guard.ts`, `src/snapshot/build.ts`, `src/snapshot/freeze.ts`
- Test: `tests/snapshot/guard.test.ts`, `tests/snapshot/build.test.ts`

**Interfaces:**
- Consumes: all four panel builders, `AppConfig`, own db client
- Produces: `monthWindow(month): { fromIso; toIso; priorWindowFromIso; abandonedBeforeDay }`,
  `assertMonthComplete(src, month, now): Promise<void>` (throws),
  `buildSnapshot(src, cfg, month, now): Promise<Snapshot>`,
  `freezeSnapshot(db, snapshot): Promise<{ frozen: boolean }>`

- [ ] **Step 1: Write the failing guard test**

Create `tests/snapshot/guard.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { makeFakeSource } from "../../src/litellm/source-fake";
import { assertMonthComplete, monthWindow } from "../../src/snapshot/guard";

const totals = (spendUsd: number, apiRequests: number) => ({
  spendUsd, apiRequests, successfulRequests: apiRequests, failedRequests: 0,
});

describe("monthWindow", () => {
  it("spans the whole month exclusive of the next", () => {
    const w = monthWindow("2026-08");
    expect(w.fromIso).toBe("2026-08-01T00:00:00.000Z");
    expect(w.toIso).toBe("2026-09-01T00:00:00.000Z");
    expect(w.abandonedBeforeDay).toBe("2026-08-02");
  });
});

describe("assertMonthComplete", () => {
  const src = makeFakeSource({
    monthTotals: totals(100, 10),
    dailyByTagPrefix: {
      "user_id_": [{ day: "2026-08-01", tag: "user_id_1", spendUsd: 90, requests: 10 }],
    },
  });

  it("passes for an elapsed month with traffic", async () => {
    await expect(
      assertMonthComplete(src, "2026-08", new Date("2026-09-02T00:00:00Z")),
    ).resolves.toBeUndefined();
  });

  it("refuses a month that has not finished", async () => {
    await expect(
      assertMonthComplete(src, "2026-08", new Date("2026-08-20T00:00:00Z")),
    ).rejects.toThrow(/not complete/i);
  });

  it("refuses a month with no traffic at all", async () => {
    const empty = makeFakeSource({ monthTotals: totals(0, 0) });
    await expect(
      assertMonthComplete(empty, "2026-08", new Date("2026-09-02T00:00:00Z")),
    ).rejects.toThrow(/no requests/i);
  });

  it("refuses when tag-dimension spend exceeds total spend", async () => {
    // Symptom of duplicated tags within one dimension — would inflate every
    // per-user figure in the report (G1).
    const broken = makeFakeSource({
      monthTotals: totals(100, 10),
      dailyByTagPrefix: {
        "user_id_": [{ day: "2026-08-01", tag: "user_id_1", spendUsd: 250, requests: 10 }],
      },
    });
    await expect(
      assertMonthComplete(broken, "2026-08", new Date("2026-09-02T00:00:00Z")),
    ).rejects.toThrow(/exceeds total/i);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `pnpm vitest run tests/snapshot/guard.test.ts`
Expected: FAIL — cannot find module

- [ ] **Step 3: Implement src/snapshot/guard.ts**

```ts
import type { LiteLLMSource } from "../litellm/types";

export type MonthWindow = {
  fromIso: string;
  toIso: string;
  priorWindowFromIso: string;
  abandonedBeforeDay: string;
};

const PRIOR_WINDOW_MONTHS = 3;
const ABANDONED_DAYS = 30;

export function monthWindow(month: string): MonthWindow {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const from = new Date(Date.UTC(y, m - 1, 1));
  const to = new Date(Date.UTC(y, m, 1));
  const priorWindowFrom = new Date(Date.UTC(y, m - 1 - PRIOR_WINDOW_MONTHS, 1));
  const abandonedBefore = new Date(to.getTime() - ABANDONED_DAYS * 86_400_000);
  return {
    fromIso: from.toISOString(),
    toIso: to.toISOString(),
    priorWindowFromIso: priorWindowFrom.toISOString(),
    abandonedBeforeDay: abandonedBefore.toISOString().slice(0, 10),
  };
}

/** Throws rather than allowing a partial report to be produced (G6). */
export async function assertMonthComplete(
  src: LiteLLMSource, month: string, now: Date,
): Promise<void> {
  const w = monthWindow(month);

  if (now.getTime() < new Date(w.toIso).getTime()) {
    throw new Error(`Month ${month} is not complete — refusing to report on partial data.`);
  }

  const totals = await src.monthTotals(w.fromIso, w.toIso);
  if (totals.apiRequests === 0) {
    throw new Error(`Month ${month} has no requests — refusing to send an empty report.`);
  }

  const userRows = await src.dailyByTagPrefix(w.fromIso, w.toIso, "user_id_");
  const userSpend = userRows.reduce((s, r) => s + r.spendUsd, 0);
  // Within one dimension each request contributes once, so this can never
  // legitimately exceed the row-level total. A tolerance covers float drift.
  if (userSpend > totals.spendUsd * 1.001 + 0.01) {
    throw new Error(
      `Tag-dimension spend (${userSpend.toFixed(2)}) exceeds total spend ` +
      `(${totals.spendUsd.toFixed(2)}) for ${month} — tags look duplicated.`,
    );
  }
}
```

- [ ] **Step 4: Write the failing build test**

Create `tests/snapshot/build.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { makeFakeSource } from "../../src/litellm/source-fake";
import { buildSnapshot } from "../../src/snapshot/build";
import type { AppConfig } from "../../src/config";

const CFG = {
  hourlyRate: 140, reportingCurrency: "EUR",
  fxRateUsdToReporting: 0.92, fxRateSetOn: "2026-08-01", minN: 5,
} as unknown as AppConfig;

describe("buildSnapshot", () => {
  it("freezes the fx rate and config into the snapshot", async () => {
    const src = makeFakeSource({
      monthTotals: { spendUsd: 1000, apiRequests: 10, successfulRequests: 10, failedRequests: 0 },
      humanUserDays: [{ userId: "1", day: "2026-08-01" }],
    });
    const snap = await buildSnapshot(src, CFG, "2026-08", new Date("2026-09-01T12:00:00Z"));
    expect(snap.month).toBe("2026-08");
    expect(snap.fxRateUsdToReporting).toBe(0.92);
    expect(snap.fxRateSetOn).toBe("2026-08-01");
    expect(snap.hourlyRate).toBe(140);
    expect(snap.bar.spendReporting).toBeCloseTo(920, 6);
  });

  it("contains no per-person identifiers anywhere", async () => {
    const src = makeFakeSource({
      monthTotals: { spendUsd: 10, apiRequests: 1, successfulRequests: 1, failedRequests: 0 },
      humanUserDays: [{ userId: "person-42", day: "2026-08-01" }],
      userTeams: [{ userId: "person-42", teamLabel: "Eng" }],
    });
    const snap = await buildSnapshot(src, CFG, "2026-08", new Date("2026-09-01T12:00:00Z"));
    expect(JSON.stringify(snap)).not.toContain("person-42");
  });
});
```

- [ ] **Step 5: Implement src/snapshot/build.ts**

```ts
import type { AppConfig } from "../config";
import type { LiteLLMSource } from "../litellm/types";
import { buildAdoption } from "../metrics/adoption";
import { buildBar } from "../metrics/bar";
import { buildReliability } from "../metrics/reliability";
import { buildWaste } from "../metrics/waste";
import type { Snapshot } from "../metrics/types";
import { monthWindow } from "./guard";

const RETENTION_MONTHS = 3;
const RETENTION_LOOKBACK_MONTHS = 12;

export async function buildSnapshot(
  src: LiteLLMSource, cfg: AppConfig, month: string, now: Date,
): Promise<Snapshot> {
  const w = monthWindow(month);
  const fx = cfg.fxRateUsdToReporting;

  // Retention needs history well before the reporting month.
  const [y, m] = month.split("-").map(Number) as [number, number];
  const retentionFrom = new Date(Date.UTC(y, m - 1 - RETENTION_LOOKBACK_MONTHS, 1)).toISOString();

  const [bar, adoption, reliability, waste] = await Promise.all([
    buildBar(src, {
      fromIso: w.fromIso, toIso: w.toIso,
      hourlyRate: cfg.hourlyRate, fxRateUsdToReporting: fx,
    }),
    buildAdoption(src, {
      fromIso: w.fromIso, toIso: w.toIso, retentionFromIso: retentionFrom, month,
      retentionMonths: RETENTION_MONTHS, fxRateUsdToReporting: fx, minN: cfg.minN,
    }),
    buildReliability(src, { fromIso: w.fromIso, toIso: w.toIso, fxRateUsdToReporting: fx }),
    buildWaste(src, {
      fromIso: w.fromIso, toIso: w.toIso,
      priorWindowFromIso: w.priorWindowFromIso,
      abandonedBeforeDay: w.abandonedBeforeDay,
      fxRateUsdToReporting: fx,
    }),
  ]);

  return {
    month,
    generatedAt: now.toISOString(),
    reportingCurrency: cfg.reportingCurrency,
    fxRateUsdToReporting: fx,
    fxRateSetOn: cfg.fxRateSetOn,
    hourlyRate: cfg.hourlyRate,
    minN: cfg.minN,
    bar, adoption, reliability, waste,
  };
}
```

Note the two windows. `buildAdoption` gets the **month** for activity, spend and
concentration, and `retentionFromIso` only for cohort history. Passing the wide window as
`fromIso` would report a 13-month median active-day count as if it were monthly — the
figure would look impressively high and be wrong.

- [ ] **Step 6: Implement src/snapshot/freeze.ts**

```ts
import { eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { valueMonthSnapshot } from "../db/schema";
import type { Snapshot } from "../metrics/types";

/**
 * Write-once (G3). Returns frozen:false when the month already exists, so the
 * caller can log and exit without recomputing or overwriting.
 */
export async function freezeSnapshot(
  db: NodePgDatabase<Record<string, unknown>>, snapshot: Snapshot,
): Promise<{ frozen: boolean }> {
  const inserted = await db
    .insert(valueMonthSnapshot)
    .values({ month: snapshot.month, payload: snapshot })
    .onConflictDoNothing({ target: valueMonthSnapshot.month })
    .returning({ month: valueMonthSnapshot.month });
  return { frozen: inserted.length > 0 };
}

export async function readSnapshot(
  db: NodePgDatabase<Record<string, unknown>>, month: string,
): Promise<Snapshot | null> {
  const rows = await db
    .select().from(valueMonthSnapshot).where(eq(valueMonthSnapshot.month, month)).limit(1);
  return rows.length > 0 ? (rows[0]!.payload as Snapshot) : null;
}
```

- [ ] **Step 7: Run the tests**

Run: `pnpm vitest run tests/snapshot`
Expected: 6 passed

- [ ] **Step 8: Commit**

```bash
git add -A && git commit -m "feat: snapshot build, completeness guard, write-once freeze"
```

---

### Task 11: Number registry and Evidence-Lock

Rather than reverse-parsing prose to guess which numbers are legitimate, every number is
formatted through a registry that records what it emitted. The lock then asserts that
every numeric token in the rendered output was registered. A hand-typed or hallucinated
figure fails the build (G5).

**Files:**
- Create: `src/report/registry.ts`, `src/report/evidence-lock.ts`
- Test: `tests/report/evidence-lock.test.ts`

**Interfaces:**
- Produces: `class NumberRegistry` with `currency(n)`, `int(n)`, `pct(n, dp?)`,
  `hours(n)`, `minutes(n)`, `multiple(n)`, `raw(s)` and `emitted: ReadonlySet<string>`;
  `STATIC_ALLOWLIST: string[]`; `assertEvidenceLock(html, registry): void`

- [ ] **Step 1: Write the failing test**

Create `tests/report/evidence-lock.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { NumberRegistry } from "../../src/report/registry";
import { assertEvidenceLock } from "../../src/report/evidence-lock";

describe("NumberRegistry", () => {
  it("formats and records currency with thousands separators", () => {
    const r = new NumberRegistry("EUR");
    expect(r.currency(4847)).toBe("4,847.00");
    expect(r.emitted.has("4,847.00")).toBe(true);
  });

  it("formats percentages and hours to one decimal", () => {
    const r = new NumberRegistry("EUR");
    expect(r.pct(95.9834)).toBe("96.0");
    expect(r.hours(34.6214)).toBe("34.6");
  });

  it("rounds minutes to a whole number", () => {
    const r = new NumberRegistry("EUR");
    expect(r.minutes(50.7)).toBe("51");
  });
});

describe("assertEvidenceLock", () => {
  it("passes when every number came from the registry", () => {
    const r = new NumberRegistry("EUR");
    const html = `<p>Spend was ${r.currency(4847)} over ${r.int(41)} people.</p>`;
    expect(() => assertEvidenceLock(html, r)).not.toThrow();
  });

  it("throws when a number was hand-written into the prose", () => {
    const r = new NumberRegistry("EUR");
    const html = `<p>Spend was ${r.currency(4847)}, saving 200 hours.</p>`;
    expect(() => assertEvidenceLock(html, r)).toThrow(/200/);
  });

  it("ignores numbers inside style and script blocks", () => {
    const r = new NumberRegistry("EUR");
    const html =
      `<style>.x{width:640px;margin:0 8px}</style>` +
      `<script>var a=99;</script>` +
      `<p>${r.int(7)} agents</p>`;
    expect(() => assertEvidenceLock(html, r)).not.toThrow();
  });

  it("ignores numbers inside tag attributes", () => {
    const r = new NumberRegistry("EUR");
    const html = `<td style="padding:12px" colspan="3">${r.int(7)}</td>`;
    expect(() => assertEvidenceLock(html, r)).not.toThrow();
  });

  it("allows the static allowlist such as the report year", () => {
    const r = new NumberRegistry("EUR");
    expect(() => assertEvidenceLock(`<h1>August 2026</h1>`, r)).not.toThrow();
  });

  it("approves digits inside data-derived strings passed through raw()", () => {
    const r = new NumberRegistry("EUR");
    const html = `<td>${r.raw("gemini-2.5-flash")}</td><td>${r.raw("2026-08-01")}</td>`;
    expect(() => assertEvidenceLock(html, r)).not.toThrow();
  });

  it("still catches a stray number next to an approved string", () => {
    const r = new NumberRegistry("EUR");
    const html = `<td>${r.raw("gemini-2.5-flash")}</td><td>saved 200 hours</td>`;
    expect(() => assertEvidenceLock(html, r)).toThrow(/200/);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `pnpm vitest run tests/report/evidence-lock.test.ts`
Expected: FAIL — cannot find modules

- [ ] **Step 3: Implement src/report/registry.ts**

```ts
/**
 * Every number rendered into the report must pass through here. The registry
 * keeps the exact emitted strings so Evidence-Lock can verify the output (G5).
 */
export class NumberRegistry {
  private readonly seen = new Set<string>();

  constructor(private readonly currencyCode: string) {}

  get emitted(): ReadonlySet<string> {
    return this.seen;
  }

  get currencyLabel(): string {
    return this.currencyCode;
  }

  private record(s: string): string {
    this.seen.add(s);
    return s;
  }

  private fixed(n: number, dp: number, group: boolean): string {
    return new Intl.NumberFormat("en-US", {
      minimumFractionDigits: dp,
      maximumFractionDigits: dp,
      useGrouping: group,
    }).format(n);
  }

  currency(n: number): string { return this.record(this.fixed(n, 2, true)); }
  int(n: number): string { return this.record(this.fixed(Math.round(n), 0, true)); }
  pct(n: number, dp = 1): string { return this.record(this.fixed(n, dp, false)); }
  hours(n: number): string { return this.record(this.fixed(n, 1, true)); }
  minutes(n: number): string { return this.record(this.fixed(Math.round(n), 0, false)); }
  multiple(n: number): string { return this.record(this.fixed(n, 2, false)); }

  /**
   * Approves a data-derived string such as a date, model name, team label or
   * agent id. Records every numeric token inside it, because Evidence-Lock
   * tokenises on digit runs: "2026-08-01" is three tokens, and
   * "gemini-2.5-flash" contains one.
   */
  raw(s: string): string {
    for (const token of s.match(/-?\d[\d,]*(?:\.\d+)?/g) ?? []) this.seen.add(token);
    return s;
  }
}
```

**Rule for renderers:** every interpolated value that came from data — not just numbers —
goes through the registry. Strings are approved with `raw()`. A model called
`gemini-2.5-flash`, a team called `Team 4`, or a UUID agent id all carry digits, and
Evidence-Lock cannot tell them from a hallucinated figure.

- [ ] **Step 4: Implement src/report/evidence-lock.ts**

```ts
import type { NumberRegistry } from "./registry";

/** Numbers that may legitimately appear without coming from the snapshot. */
export const STATIC_ALLOWLIST: string[] = [
  // Calendar years the report may name in headings and the appendix.
  ...Array.from({ length: 20 }, (_, i) => String(2020 + i)),
];

export function visibleText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]*>/g, " ");
}

export function extractNumericTokens(text: string): string[] {
  // A token is a run of digits with optional , and . separators, and an optional
  // leading minus. The sign matters: without it, pct(-5) registers "-5.0" while the
  // tokeniser sees "5.0", so the lock throws on its own legitimate output — and worse,
  // a smuggled "-5.0" passes whenever "5.0" happens to be registered. Both were
  // reproduced before this was fixed. raw() MUST use the identical regex, or the
  // registered and checked token sets stop matching for hyphenated strings.
  return text.match(/-?\d[\d,]*(?:\.\d+)?/g) ?? [];
}

export class EvidenceLockError extends Error {}

export function assertEvidenceLock(html: string, registry: NumberRegistry): void {
  const allowed = new Set<string>([...registry.emitted, ...STATIC_ALLOWLIST]);
  const offenders = [...new Set(extractNumericTokens(visibleText(html)))]
    .filter((token) => !allowed.has(token));

  if (offenders.length > 0) {
    throw new EvidenceLockError(
      `Evidence-Lock failed. These numbers appear in the report but were not ` +
      `emitted from the snapshot: ${offenders.join(", ")}`,
    );
  }
}
```

- [ ] **Step 5: Run the tests**

Run: `pnpm vitest run tests/report/evidence-lock.test.ts`
Expected: 10 passed

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat: number registry and evidence-lock verification"
```

---

### Task 12: HTML and CSV renderers

**Files:**
- Create: `src/report/html.ts`, `src/report/csv.ts`
- Test: `tests/report/html.test.ts`, `tests/report/csv.test.ts`
- Create: `tests/fixtures/snapshot.ts`

**Interfaces:**
- Consumes: `Snapshot`, `NumberRegistry`, `assertEvidenceLock`
- Produces: `renderHtml(snapshot): string` (throws on Evidence-Lock failure),
  `renderCsv(snapshot): string`, `makeSnapshotFixture(overrides?): Snapshot`

- [ ] **Step 1: Write the snapshot fixture**

Create `tests/fixtures/snapshot.ts`:

```ts
import type { Snapshot } from "../../src/metrics/types";

export function makeSnapshotFixture(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    month: "2026-08",
    generatedAt: "2026-09-01T06:00:00.000Z",
    reportingCurrency: "EUR",
    fxRateUsdToReporting: 1,
    fxRateSetOn: "2026-08-01",
    hourlyRate: 140,
    minN: 5,
    bar: {
      spendUsd: 4847, spendReporting: 4847, activePeople: 41,
      costInHours: 34.6214, breakEvenMinutesPerPerson: 50.66,
      attributionCoveragePct: 95.98, unattributedSpendReporting: 194.88,
      sensitivity: [
        { minutesPerPerson: 30, returnMultiple: 0.59 },
        { minutesPerPerson: 60, returnMultiple: 1.18 },
        { minutesPerPerson: 120, returnMultiple: 2.37 },
      ],
    },
    adoption: {
      activePeople: 41, medianActiveDays: 9,
      retention: [{
        cohortMonth: "2026-06", cohortSize: 20,
        points: [
          { monthOffset: 1, retained: 15, pct: 75 },
          { monthOffset: 2, retained: 14, pct: 70 },
          { monthOffset: 3, retained: 14, pct: 70 },
        ],
      }],
      concentrationTop10PctOfSpendPct: 48.2,
      concentrationTop10PctOfRequestsPct: 41.7,
      teams: [
        { teamLabel: "Engineering", activePeople: 28, spendReporting: 3600, medianActiveDays: 12 },
        { teamLabel: "Other", activePeople: 13, spendReporting: 1247, medianActiveDays: 4 },
      ],
      clientTools: [
        { tool: "claude-cli", spendReporting: 3777.33, activePeople: 28, shareOfSpendPct: 89.4 },
        { tool: "ai-sdk", spendReporting: 42.4, activePeople: 16, shareOfSpendPct: 1.0 },
      ],
    },
    reliability: {
      apiRequests: 51234, successfulRequests: 50890, failedRequests: 344,
      failureRatePct: 0.67, automationRequests: 4120,
      automationSpendReporting: 610.5, automationSharePct: 8.04,
    },
    waste: {
      activeThisMonth: 41, activeInPriorWindow: 46, lapsedUsers: 11, returningUsers: 6,
      abandonedAgents: [
        { agentLabel: "legacy-summariser", lastSeenDay: "2026-05-14", historicalSpendReporting: 312.4 },
      ],
      modelMix: [
        { model: "gemini-2.5-flash", spendReporting: 2900, sharePct: 59.83 },
        { model: "claude-opus-4-8", spendReporting: 1947, sharePct: 40.17 },
      ],
    },
    ...overrides,
  };
}
```

- [ ] **Step 2: Write the failing renderer tests**

Create `tests/report/html.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { makeSnapshotFixture } from "../fixtures/snapshot";
import { renderHtml } from "../../src/report/html";
import { visibleText } from "../../src/report/evidence-lock";

describe("renderHtml", () => {
  it("leads with spend, people, hours and the break-even minutes", () => {
    const text = visibleText(renderHtml(makeSnapshotFixture()));
    expect(text).toContain("4,847.00");
    expect(text).toContain("41");
    expect(text).toContain("34.6");
    expect(text).toContain("51");
  });

  it("states attribution coverage on the first page", () => {
    expect(visibleText(renderHtml(makeSnapshotFixture()))).toContain("96.0");
  });

  it("passes its own Evidence-Lock", () => {
    expect(() => renderHtml(makeSnapshotFixture())).not.toThrow();
  });

  it("names no individuals", () => {
    const html = renderHtml(makeSnapshotFixture());
    expect(html).not.toMatch(/user_id_/);
  });

  it("includes the frozen fx rate and its date in the appendix", () => {
    const text = visibleText(renderHtml(makeSnapshotFixture({ fxRateUsdToReporting: 0.92 })));
    expect(text).toContain("0.92");
    expect(text).toContain("2026-08-01");
  });

  it("declares what the report cannot see", () => {
    const text = visibleText(renderHtml(makeSnapshotFixture())).toLowerCase();
    expect(text).toContain("cannot");
  });
});
```

Create `tests/report/csv.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { makeSnapshotFixture } from "../fixtures/snapshot";
import { renderCsv } from "../../src/report/csv";

describe("renderCsv", () => {
  it("emits a header and one row per metric", () => {
    const lines = renderCsv(makeSnapshotFixture()).trim().split("\n");
    expect(lines[0]).toBe("section,metric,dimension,value");
    expect(lines.some((l) => l.startsWith("bar,spend_reporting,,4847"))).toBe(true);
  });

  it("includes a per-team breakdown for the billing split", () => {
    const csv = renderCsv(makeSnapshotFixture());
    expect(csv).toContain("adoption,team_spend_reporting,Engineering,3600");
  });

  it("quotes dimension values containing commas", () => {
    const snap = makeSnapshotFixture();
    snap.adoption.teams[0]!.teamLabel = "Eng, Core";
    expect(renderCsv(snap)).toContain('"Eng, Core"');
  });
});
```

- [ ] **Step 3: Run them to confirm they fail**

Run: `pnpm vitest run tests/report`
Expected: FAIL — cannot find modules `html` / `csv`

- [ ] **Step 4: Implement src/report/csv.ts**

```ts
import type { Snapshot } from "../metrics/types";

type Row = [section: string, metric: string, dimension: string, value: number | string];

function esc(v: string | number): string {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function renderCsv(s: Snapshot): string {
  const rows: Row[] = [
    ["bar", "spend_usd", "", s.bar.spendUsd],
    ["bar", "spend_reporting", "", s.bar.spendReporting],
    ["bar", "active_people", "", s.bar.activePeople],
    ["bar", "cost_in_hours", "", s.bar.costInHours],
    ["bar", "break_even_minutes_per_person", "", s.bar.breakEvenMinutesPerPerson],
    ["bar", "attribution_coverage_pct", "", s.bar.attributionCoveragePct],
    ["bar", "unattributed_spend_reporting", "", s.bar.unattributedSpendReporting],
    ["adoption", "median_active_days", "", s.adoption.medianActiveDays],
    ["adoption", "concentration_top10pct_spend_pct", "", s.adoption.concentrationTop10PctOfSpendPct],
    ["reliability", "api_requests", "", s.reliability.apiRequests],
    ["reliability", "failure_rate_pct", "", s.reliability.failureRatePct],
    ["reliability", "automation_share_pct", "", s.reliability.automationSharePct],
    ["waste", "active_this_month", "", s.waste.activeThisMonth],
    ["waste", "active_in_prior_window", "", s.waste.activeInPriorWindow],
    ["waste", "lapsed_users", "", s.waste.lapsedUsers],
    ["waste", "returning_users", "", s.waste.returningUsers],
  ];

  for (const t of s.adoption.teams) {
    rows.push(["adoption", "team_spend_reporting", t.teamLabel, t.spendReporting]);
    rows.push(["adoption", "team_active_people", t.teamLabel, t.activePeople]);
  }
  for (const t of s.adoption.clientTools) {
    rows.push(["adoption", "client_tool_spend_reporting", t.tool, t.spendReporting]);
    rows.push(["adoption", "client_tool_active_people", t.tool, t.activePeople]);
  }
  for (const m of s.waste.modelMix) {
    rows.push(["waste", "model_spend_reporting", m.model, m.spendReporting]);
  }
  for (const c of s.adoption.retention) {
    for (const p of c.points) {
      rows.push(["adoption", `retention_m${p.monthOffset}_pct`, c.cohortMonth, p.pct]);
    }
  }

  return ["section,metric,dimension,value", ...rows.map((r) => r.map(esc).join(","))]
    .join("\n") + "\n";
}
```

- [ ] **Step 5: Implement src/report/html.ts**

```ts
import type { Snapshot } from "../metrics/types";
import { NumberRegistry } from "./registry";
import { assertEvidenceLock } from "./evidence-lock";

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function monthLabel(month: string): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return `${MONTHS[m - 1]} ${y}`;
}

export function renderHtml(s: Snapshot): string {
  const n = new NumberRegistry(s.reportingCurrency);
  const cur = s.reportingCurrency;

  const sensitivity = s.bar.sensitivity
    .map((p) => `${n.minutes(p.minutesPerPerson)} min → ${n.multiple(p.returnMultiple)}×`)
    .join(" · ");

  // Every data-derived string goes through raw(): team names, model names and
  // agent ids all routinely contain digits.
  const teams = s.adoption.teams
    .map((t) => `<tr><td>${n.raw(t.teamLabel)}</td><td>${n.int(t.activePeople)}</td>` +
      `<td>${cur} ${n.currency(t.spendReporting)}</td>` +
      `<td>${n.int(t.medianActiveDays)}</td></tr>`)
    .join("");

  const retention = s.adoption.retention
    .map((c) => `<tr><td>${n.raw(c.cohortMonth)}</td><td>${n.int(c.cohortSize)}</td>` +
      c.points.map((p) => `<td>${n.pct(p.pct)}%</td>`).join("") + `</tr>`)
    .join("");

  const agents = s.waste.abandonedAgents.length === 0
    ? `<p>No abandoned agents.</p>`
    : `<ul>` + s.waste.abandonedAgents
        .map((a) => `<li>${n.raw(a.agentLabel)} — last used ` +
          `${n.raw(a.lastSeenDay ?? "never")}, ` +
          `${cur} ${n.currency(a.historicalSpendReporting)} spent historically</li>`)
        .join("") + `</ul>`;

  const tools = s.adoption.clientTools
    .map((t) => `<tr><td>${n.raw(t.tool)}</td><td>${n.int(t.activePeople)}</td>` +
      `<td>${cur} ${n.currency(t.spendReporting)}</td>` +
      `<td>${n.pct(t.shareOfSpendPct)}%</td></tr>`)
    .join("");

  const models = s.waste.modelMix
    .map((m) => `<tr><td>${n.raw(m.model)}</td>` +
      `<td>${cur} ${n.currency(m.spendReporting)}</td>` +
      `<td>${n.pct(m.sharePct)}%</td></tr>`)
    .join("");

  const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>Value Ledger — ${monthLabel(s.month)}</title>
<style>
 body{font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#111;max-width:720px;margin:0 auto;padding:24px}
 .bar{background:#0f3b3f;color:#fff;padding:24px;border-radius:8px}
 .bar h1{margin:0 0 8px;font-size:20px}
 .headline{font-size:28px;font-weight:700;margin:8px 0}
 table{border-collapse:collapse;width:100%;margin:12px 0}
 th,td{text-align:left;border-bottom:1px solid #e3e3e3;padding:6px 8px;font-size:14px}
 .muted{color:#666;font-size:13px}
 h2{margin-top:32px;font-size:16px;border-bottom:2px solid #0f3b3f;padding-bottom:4px}
</style></head><body>

<div class="bar">
  <h1>Value Ledger — ${monthLabel(s.month)}</h1>
  <div class="headline">${cur} ${n.currency(s.bar.spendReporting)} ·
    ${n.int(s.bar.activePeople)} people · ${n.hours(s.bar.costInHours)} hours</div>
  <p>This month's platform cost equals ${n.hours(s.bar.costInHours)} hours of billable time
     at your ${cur} ${n.currency(s.hourlyRate)} rate.</p>
  <p><strong>Break-even: ${n.minutes(s.bar.breakEvenMinutesPerPerson)} minutes saved per
     active person.</strong></p>
  <p class="muted">Scenarios: ${sensitivity}</p>
  <p class="muted">Coverage: ${n.pct(s.bar.attributionCoveragePct)}% of spend attributable
     to a named team. ${cur} ${n.currency(s.bar.unattributedSpendReporting)} unattributed.</p>
</div>

<h2>Adoption</h2>
<p>Median ${n.int(s.adoption.medianActiveDays)} active days per person.
   The busiest 10% of people account for
   ${n.pct(s.adoption.concentrationTop10PctOfSpendPct)}% of spend.</p>
<table><tr><th>Cohort</th><th>Size</th><th>M+1</th><th>M+2</th><th>M+3</th></tr>
${retention}</table>
<table><tr><th>Team</th><th>Active</th><th>Spend</th><th>Median days</th></tr>
${teams}</table>
<table><tr><th>Client tool</th><th>People</th><th>Spend</th><th>Share</th></tr>
${tools}</table>

<h2>Reliability and automation</h2>
<p>${n.int(s.reliability.apiRequests)} requests,
   ${n.pct(s.reliability.failureRatePct, 2)}% failed.
   Automation ran ${n.int(s.reliability.automationRequests)} requests
   (${n.pct(s.reliability.automationSharePct)}% of all traffic,
   ${cur} ${n.currency(s.reliability.automationSpendReporting)}) with no one waiting on it.</p>

<h2>Waste</h2>
<p>${n.int(s.waste.lapsedUsers)} people who used the platform in the previous three
   months did not use it this month; ${n.int(s.waste.returningUsers)} used it for the first
   time. LiteLLM holds no seat roster, so this compares observed activity rather than
   issued licences.</p>
${agents}
<table><tr><th>Model</th><th>Spend</th><th>Share</th></tr>${models}</table>

<h2>Appendix</h2>
<p class="muted">Spend is taken from LiteLLM request logs and converted at a fixed rate of
   ${n.multiple(s.fxRateUsdToReporting)} USD→${cur}, set on ${n.raw(s.fxRateSetOn)}.
   Figures are frozen and will not change if this report is regenerated.
   Teams with fewer than ${n.int(s.minN)} active people are grouped as "Other".</p>
<p class="muted"><strong>What this report cannot see:</strong> it makes no claim about
   value created, time saved, or business outcomes. It cannot attribute spend to individual
   failed requests, cannot observe work that did not pass through LiteLLM, and does not
   measure individual performance.</p>
</body></html>`;

  assertEvidenceLock(html, n);
  return html;
}
```

- [ ] **Step 6: Run the tests**

Run: `pnpm vitest run tests/report`
Expected: 17 passed

If Evidence-Lock trips on a number you believe is legitimate, the fix is to emit it
through the registry — never to widen `STATIC_ALLOWLIST` for a data value.

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat: html and csv report renderers under evidence-lock"
```

---

### Task 13: SMTP delivery

**Files:**
- Create: `src/report/send.ts`
- Test: `tests/report/send.test.ts`

**Interfaces:**
- Consumes: `AppConfig`, `Snapshot`
- Produces: `type Mailer = { sendMail(opts: MailOptions): Promise<unknown> }`,
  `createMailer(cfg): Mailer`, `sendReport(mailer, cfg, snapshot, html, csv): Promise<void>`

- [ ] **Step 1: Write the failing test**

Create `tests/report/send.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { makeSnapshotFixture } from "../fixtures/snapshot";
import { sendReport } from "../../src/report/send";
import type { AppConfig } from "../../src/config";

const CFG = {
  smtp: { host: "h", port: 587, user: "u", pass: "p", from: "ledger@example.com" },
  reportRecipients: ["boss@example.com", "cfo@example.com"],
} as unknown as AppConfig;

describe("sendReport", () => {
  it("sends one mail to all recipients with the csv attached", async () => {
    const sendMail = vi.fn().mockResolvedValue({});
    await sendReport({ sendMail }, CFG, makeSnapshotFixture(), "<p>hi</p>", "a,b\n");

    expect(sendMail).toHaveBeenCalledTimes(1);
    const opts = sendMail.mock.calls[0]![0];
    expect(opts.to).toBe("boss@example.com, cfo@example.com");
    expect(opts.from).toBe("ledger@example.com");
    expect(opts.subject).toContain("August 2026");
    expect(opts.attachments[0].filename).toBe("value-ledger-2026-08.csv");
  });

  it("propagates transport failure so the job records it", async () => {
    const sendMail = vi.fn().mockRejectedValue(new Error("smtp down"));
    await expect(
      sendReport({ sendMail }, CFG, makeSnapshotFixture(), "<p>hi</p>", ""),
    ).rejects.toThrow("smtp down");
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `pnpm vitest run tests/report/send.test.ts`
Expected: FAIL — cannot find module

- [ ] **Step 3: Implement src/report/send.ts**

```ts
import nodemailer from "nodemailer";
import type { AppConfig } from "../config";
import type { Snapshot } from "../metrics/types";

export type MailOptions = {
  from: string; to: string; subject: string; html: string;
  attachments: { filename: string; content: string; contentType: string }[];
};

export type Mailer = { sendMail(opts: MailOptions): Promise<unknown> };

export function createMailer(cfg: AppConfig): Mailer {
  return nodemailer.createTransport({
    host: cfg.smtp.host,
    port: cfg.smtp.port,
    secure: cfg.smtp.port === 465,
    auth: { user: cfg.smtp.user, pass: cfg.smtp.pass },
  });
}

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

export async function sendReport(
  mailer: Mailer, cfg: AppConfig, snapshot: Snapshot, html: string, csv: string,
): Promise<void> {
  const [y, m] = snapshot.month.split("-").map(Number) as [number, number];
  await mailer.sendMail({
    from: cfg.smtp.from,
    to: cfg.reportRecipients.join(", "),
    subject: `Value Ledger — ${MONTHS[m - 1]} ${y}`,
    html,
    attachments: [{
      filename: `value-ledger-${snapshot.month}.csv`,
      content: csv,
      contentType: "text/csv",
    }],
  });
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run tests/report/send.test.ts`
Expected: 2 passed

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: smtp delivery of the monthly report"
```

---

### Task 14: Monthly job and trigger route

**Files:**
- Create: `src/jobs/monthly.ts`, `src/app/api/jobs/monthly/route.ts`
- Test: `tests/jobs/monthly.test.ts`

**Interfaces:**
- Consumes: everything above
- Produces: `previousMonth(now: Date): string`,
  `runMonthlyJob(deps, month, now): Promise<JobOutcome>` where
  `JobOutcome = { status: "sent" | "already_frozen"; month: string }` and
  `deps = { src, db, cfg, mailer }`

- [ ] **Step 1: Write the failing test**

Create `tests/jobs/monthly.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { makeFakeSource } from "../../src/litellm/source-fake";
import { previousMonth, runMonthlyJob } from "../../src/jobs/monthly";
import type { AppConfig } from "../../src/config";

const CFG = {
  hourlyRate: 140, reportingCurrency: "EUR", fxRateUsdToReporting: 1,
  fxRateSetOn: "2026-08-01", minN: 5,
  smtp: { host: "h", port: 587, user: "u", pass: "p", from: "f@x.com" },
  reportRecipients: ["boss@x.com"],
} as unknown as AppConfig;

const src = () => makeFakeSource({
  monthTotals: { spendUsd: 4847, apiRequests: 500, successfulRequests: 500, failedRequests: 0 },
  spendWithTagPrefix: { "team_id_": 4652.12 },
  humanUserDays: Array.from({ length: 41 }, (_, i) => ({ userId: String(i), day: "2026-08-05" })),
});

function fakeDb(existing: string[] = []) {
  const frozen = new Set(existing);
  return {
    frozen,
    insert: () => ({
      values: (v: { month: string }) => ({
        onConflictDoNothing: () => ({
          returning: async () => {
            if (frozen.has(v.month)) return [];
            frozen.add(v.month);
            return [{ month: v.month }];
          },
        }),
      }),
    }),
    insertJobRun: vi.fn(),
  };
}

describe("previousMonth", () => {
  it("returns the month before the given date", () => {
    expect(previousMonth(new Date("2026-09-01T06:00:00Z"))).toBe("2026-08");
  });
  it("rolls back across a year boundary", () => {
    expect(previousMonth(new Date("2026-01-03T06:00:00Z"))).toBe("2025-12");
  });
});

describe("runMonthlyJob", () => {
  const now = new Date("2026-09-01T06:00:00Z");

  it("builds, freezes and sends", async () => {
    const sendMail = vi.fn().mockResolvedValue({});
    const db = fakeDb();
    const out = await runMonthlyJob(
      { src: src(), db: db as never, cfg: CFG, mailer: { sendMail } }, "2026-08", now,
    );
    expect(out.status).toBe("sent");
    expect(sendMail).toHaveBeenCalledTimes(1);
  });

  it("does not resend or recompute a month already frozen", async () => {
    const sendMail = vi.fn().mockResolvedValue({});
    const db = fakeDb(["2026-08"]);
    const out = await runMonthlyJob(
      { src: src(), db: db as never, cfg: CFG, mailer: { sendMail } }, "2026-08", now,
    );
    expect(out.status).toBe("already_frozen");
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("sends nothing when the completeness guard fails", async () => {
    const sendMail = vi.fn().mockResolvedValue({});
    const empty = makeFakeSource({
      monthTotals: { spendUsd: 0, apiRequests: 0, successfulRequests: 0, failedRequests: 0 },
    });
    await expect(
      runMonthlyJob({ src: empty, db: fakeDb() as never, cfg: CFG, mailer: { sendMail } },
        "2026-08", now),
    ).rejects.toThrow(/no requests/i);
    expect(sendMail).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `pnpm vitest run tests/jobs/monthly.test.ts`
Expected: FAIL — cannot find module

- [ ] **Step 3: Implement src/jobs/monthly.ts**

```ts
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { AppConfig } from "../config";
import type { LiteLLMSource } from "../litellm/types";
import { assertMonthComplete } from "../snapshot/guard";
import { buildSnapshot } from "../snapshot/build";
import { freezeSnapshot } from "../snapshot/freeze";
import { renderHtml } from "../report/html";
import { renderCsv } from "../report/csv";
import { sendReport, type Mailer } from "../report/send";

export type JobDeps = {
  src: LiteLLMSource;
  db: NodePgDatabase<Record<string, unknown>>;
  cfg: AppConfig;
  mailer: Mailer;
};

export type JobOutcome = { status: "sent" | "already_frozen"; month: string };

export function previousMonth(now: Date): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * Order matters. The guard runs before anything is built or frozen, so a month
 * that fails completeness leaves no snapshot behind and sends nothing (G6).
 * Freezing precedes sending, so a transport failure cannot cause a second
 * snapshot to be computed on retry (G3).
 */
export async function runMonthlyJob(
  deps: JobDeps, month: string, now: Date,
): Promise<JobOutcome> {
  await assertMonthComplete(deps.src, month, now);

  const snapshot = await buildSnapshot(deps.src, deps.cfg, month, now);
  const { frozen } = await freezeSnapshot(deps.db, snapshot);
  if (!frozen) return { status: "already_frozen", month };

  const html = renderHtml(snapshot);
  const csv = renderCsv(snapshot);
  await sendReport(deps.mailer, deps.cfg, snapshot, html, csv);

  return { status: "sent", month };
}
```

- [ ] **Step 4: Implement the trigger route**

Create `src/app/api/jobs/monthly/route.ts`:

```ts
import { NextResponse } from "next/server";
import { loadConfig } from "../../../../config";
import { createOwnDb } from "../../../../db/client";
import { createLiteLLMSource } from "../../../../litellm/source-sql";
import { createMailer } from "../../../../report/send";
import { jobRun } from "../../../../db/schema";
import { previousMonth, runMonthlyJob } from "../../../../jobs/monthly";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<NextResponse> {
  const cfg = loadConfig();

  if (request.headers.get("authorization") !== `Bearer ${cfg.jobToken}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const now = new Date();
  const url = new URL(request.url);
  const month = url.searchParams.get("month") ?? previousMonth(now);

  const { db, pool: ownPool } = createOwnDb(cfg.ownDatabaseUrl);
  const { source, pool: llPool } = createLiteLLMSource(cfg.litellmDatabaseUrl);
  const startedAt = new Date();

  try {
    const outcome = await runMonthlyJob(
      { src: source, db, cfg, mailer: createMailer(cfg) }, month, now,
    );
    await db.insert(jobRun).values({
      job: "monthly", month, status: outcome.status,
      startedAt, finishedAt: new Date(),
    });
    return NextResponse.json(outcome);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db.insert(jobRun).values({
      job: "monthly", month, status: "error", message,
      startedAt, finishedAt: new Date(),
    });
    return NextResponse.json({ error: message, month }, { status: 500 });
  } finally {
    await Promise.all([ownPool.end(), llPool.end()]);
  }
}
```

Returning 500 on failure is deliberate: the host's cron sees a non-2xx and alerts, which
is how a missing report becomes visible rather than silent.

- [ ] **Step 5: Run the whole suite**

Run: `pnpm vitest run`
Expected: all tests pass

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat: monthly job orchestration and authenticated trigger route"
```

---

### Task 15: Deployment documentation

**Files:**
- Create: `README.md`
- Modify: `.env.example`

- [ ] **Step 1: Write README.md**

````markdown
# Adoption and Value Tracker

Reads **only** the LiteLLM database and emails a monthly report that makes LLM spend
defensible and adoption legible.

Design: `exulu/backend/docs/superpowers/specs/2026-08-11-litellm-value-ledger-design.md`

## What it will not do

It never claims a euro of value created. It states the break-even threshold — the time
each active person would have had to save for the month to pay for itself — and leaves the
judgement to the reader. It reports no per-person figures.

## Database access

Create a read-only role in LiteLLM's Postgres:

```sql
CREATE ROLE value_ledger LOGIN PASSWORD '...';
GRANT CONNECT ON DATABASE litellm TO value_ledger;
GRANT USAGE ON SCHEMA public TO value_ledger;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO value_ledger;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO value_ledger;
```

The app also pins every connection read-only at checkout, but the grant is the real
boundary.

## Running the monthly job

The app does not schedule itself. Point the host's scheduler at the route on the 1st:

```
0 6 1 * *  curl -fsS -X POST https://<host>/api/jobs/monthly \
             -H "Authorization: Bearer $JOB_TOKEN"
```

`-f` makes curl exit non-zero on 5xx so a failed run surfaces in cron mail rather than
disappearing. Re-running for a month that is already frozen is safe and sends nothing.

To backfill a specific month: `?month=2026-07`.

## The FX rate is deliberately manual

`FX_RATE_USD_TO_REPORTING` is set by hand and frozen into each snapshot. Live rates would
mean last month's report changed every time you opened it, which breaks the immutability
the whole report's credibility rests on. Update it when you choose, and the change applies
to future months only.

## Tests

```bash
docker compose -f docker-compose.test.yml up -d
pnpm vitest run
```
````

- [ ] **Step 2: Verify the full suite and typecheck pass**

Run: `pnpm vitest run && pnpm tsc --noEmit`
Expected: all tests pass, no type errors

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "docs: readme with read-only grant, scheduling and fx policy"
```

---

## Self-review notes

**Spec coverage.** Panel 1 → Task 7. Panel 2 → Task 8. Panel 3 → Task 9. Panel 4 → Task 9.
Snapshot immutability → Task 10 (`freezeSnapshot`, PK on `month`). Evidence-Lock → Task 11.
HTML + CSV → Task 12. SMTP → Task 13. No-partial-reports → Task 10 guard, wired in Task 14.
Min-N → Task 8. FX handling → Tasks 2, 7, 12. Attribution coverage → Task 7. Phase 0 → Task 1.

**Deliberately deferred to a later plan:** Panel 5 (use-case classification) and the
dashboard, per the spec's phasing. `AgentLastSeenRow.agentName` is always `null` in
Task 6 — agent *names* live in `agent_name_*` tags and joining them adds no value while
IDs remain stable and unique; the renderer falls back to the ID. If the names matter for
readability, that is a small follow-up in the same adapter.

**Known gap surfaced by the design, carried into the report rather than hidden:** spend
cannot be attributed to failed requests, so Panel 3 reports failure rate only.

