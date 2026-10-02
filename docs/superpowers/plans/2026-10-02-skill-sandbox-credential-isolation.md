# Skill Sandbox Credential Isolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop every platform secret and every tool credential from reaching every skill's bash environment, and make what a skill *did* receive auditable.

**Architecture:** One `buildSkillEnv()` composes the skill environment from a declared secret inventory (denylist, fail-open so third-party runtime variables survive), plus only those `variables` rows an admin has marked `allow_skill_access`. A `skill.sandbox.created` audit event records granted and withheld names. Backend and frontend ship together.

**Tech Stack:** TypeScript, Node, knex/Postgres, jest (backend), Next.js + vitest (frontend), existing `src/exulu/audit` S3 NDJSON layer.

**Spec:** `docs/superpowers/specs/2026-10-02-skill-sandbox-credential-isolation-design.md`

## Global Constraints

- Backend tests run with `npx jest`; frontend tests run with `npx vitest run`. Do not introduce a second runner.
- Backend repo is `exulu-backend`, branch `develop`. Frontend repo is `exulu-frontend`, branch `main` (no develop). Verify repo and branch in the same command as any commit.
- Never log or record a credential **value**. Names only, everywhere.
- The audit layer is off by default and must stay off by default.
- `allow_skill_access` defaults to `false`; existing rows take the default. The grant filter is `= true`, so `null` also reads as not granted.
- Declaring a field in `core-schema.ts` *is* the migration — `addMissingFields` (`src/postgres/init-exulu-db.ts:46`) adds the column on next boot. Do not write a bespoke migration function.
- Backend and frontend must be merged together; there is no safe state where the filter is live without the toggle UI.

## Review Focus

- **A granted variable with a name bash cannot export** (`MY-VAR`, `2FA_KEY`): must be skipped and logged, not injected — covered by a test in Task 2.
- **A variable whose decryption fails**: already `continue`s today; must be reported as *withheld*, not silently absent — Task 7.
- **A granted variable named exactly like an inventoried secret** (admin creates `NEXTAUTH_SECRET`): the admin's value is injected and the platform's is not; assert the platform value never leaks — Task 2.
- **Audit disabled (the default)**: `buildSkillEnv` and sandbox creation must behave identically and must not throw on the noop logger — Task 7.
- **Degraded sandbox mode** (`EXULU_REQUIRE_SANDBOX` unset, no bwrap): the constructed env must still be applied on both exec paths — Task 3.

---

### Task 1: Secret inventory and completeness guard

**Files:**
- Create: `src/exulu/skill-env/inventory.ts`
- Test: `src/exulu/skill-env/inventory.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `ENV_CLASSIFICATION: Record<string, "secret" | "runtime">`, `isSecretEnvName(name: string): boolean`, `findUnclassifiedSecretShaped(env: NodeJS.ProcessEnv): string[]`.

- [ ] **Step 1: Write the failing completeness test**

```ts
// src/exulu/skill-env/inventory.test.ts
import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { ENV_CLASSIFICATION, isSecretEnvName, findUnclassifiedSecretShaped } from "./inventory";

const walk = (dir: string, out: string[] = []): string[] => {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.ts$/.test(p) && !/\.test\.ts$/.test(p)) out.push(p);
  }
  return out;
};

test("every process.env name the backend reads is classified", () => {
  const names = new Set<string>();
  for (const root of ["src", "ee"]) {
    for (const file of walk(root)) {
      const src = readFileSync(file, "utf8");
      for (const m of src.matchAll(/process\.env\.([A-Z0-9_]+)/g)) names.add(m[1]);
    }
  }
  const missing = [...names].filter((n) => !(n in ENV_CLASSIFICATION)).sort();
  expect(missing).toEqual([]);
});

test("known platform secrets are classified secret", () => {
  for (const n of ["NEXTAUTH_SECRET", "POSTGRES_DB_PASSWORD", "LITELLM_MASTER_KEY"]) {
    expect(isSecretEnvName(n)).toBe(true);
  }
});

test("runtime settings are not treated as secrets", () => {
  for (const n of ["PATH", "HOME", "LANG", "NODE_ENV"]) {
    expect(isSecretEnvName(n)).toBe(false);
  }
});

test("secret-shaped but unclassified names are reported, not stripped", () => {
  expect(findUnclassifiedSecretShaped({ ACME_API_KEY: "x", PATH: "/bin" })).toEqual(["ACME_API_KEY"]);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx jest src/exulu/skill-env/inventory.test.ts`
Expected: FAIL — `Cannot find module './inventory'`.

- [ ] **Step 3: Generate the raw name list**

Run this and keep the output; it is the input to the classification:

```bash
rg -oh --no-messages -g '!node_modules' -g '!dist' -g '!*.test.ts' \
  'process\.env\.[A-Z0-9_]+' src ee | sed 's/process\.env\.//' | sort -u
```

- [ ] **Step 4: Write the inventory**

Classify every name from Step 3. The rule: **secret** if knowing the value grants access to something — credentials, tokens, connection strings containing credentials, signing secrets, private key paths. **runtime** if it only changes behaviour — paths, locales, feature flags, hostnames, ports, log levels.

```ts
// src/exulu/skill-env/inventory.ts

/**
 * Every environment variable this backend reads, classified. A name marked
 * `secret` is removed from the environment handed to skills (see skill-env.ts).
 *
 * The companion test in inventory.test.ts fails CI if a new `process.env.X`
 * appears in src/ or ee/ without a line here. Variables this codebase never
 * reads — PYMUPDF_MESSAGE, HF_HUB_*, LANG and other third-party runtime
 * settings — are deliberately absent and pass through untouched.
 */
export const ENV_CLASSIFICATION: Record<string, "secret" | "runtime"> = {
  // --- secrets: seed set, extend with everything from Step 3 that grants access
  NEXTAUTH_SECRET: "secret",
  POSTGRES_DB_PASSWORD: "secret",
  LITELLM_MASTER_KEY: "secret",
  LITELLM_DATABASE_URL: "secret",
  COMPANION_S3_SECRET: "secret",
  COMPANION_S3_KEY: "secret",
  ANTHROPIC_API_KEY: "secret",
  GEMINI_API_KEY: "secret",
  PERPLEXITY_API_KEY: "secret",
  RECALL_API_KEY: "secret",
  JIRA_CLIENT_SECRET: "secret",
  GOOGLE_CLIENT_SECRET: "secret",
  REDIS_PASSWORD: "secret",
  NPM_TOKEN: "secret",
  // --- runtime: seed set, extend likewise
  PATH: "runtime",
  HOME: "runtime",
  LANG: "runtime",
  TZ: "runtime",
  TMPDIR: "runtime",
  NODE_ENV: "runtime",
  PORT: "runtime",
  DEBUG: "runtime",
  BACKEND: "runtime",
  FRONTEND: "runtime",
};

export const isSecretEnvName = (name: string): boolean =>
  ENV_CLASSIFICATION[name] === "secret";

const SECRET_SHAPED = /(SECRET|PASSWORD|TOKEN|_KEY|CREDENTIAL|PRIVATE)/i;

/**
 * Names present in the running environment that look like credentials but are
 * not in the inventory — i.e. set by the deployment, never read by us. Reported
 * at startup as a warning; never stripped, because stripping unknown names is
 * what breaks the document toolchain.
 */
export const findUnclassifiedSecretShaped = (env: NodeJS.ProcessEnv): string[] =>
  Object.keys(env).filter((n) => SECRET_SHAPED.test(n) && !(n in ENV_CLASSIFICATION)).sort();
```

- [ ] **Step 5: Run the tests until green**

Run: `npx jest src/exulu/skill-env/inventory.test.ts`
Expected: PASS. If the completeness test fails, it prints the unclassified names — add each one.

- [ ] **Step 6: Commit**

```bash
git add src/exulu/skill-env/inventory.ts src/exulu/skill-env/inventory.test.ts
git commit -m "feat(skills): declared inventory of platform env secrets with a CI completeness guard"
```

---

### Task 2: buildSkillEnv

**Files:**
- Create: `ee/invoke-skills/skill-env.ts`
- Test: `ee/invoke-skills/skill-env.test.ts`

**Interfaces:**
- Consumes: `isSecretEnvName` from `src/exulu/skill-env/inventory.ts`.
- Produces: `buildSkillEnv(args: BuildSkillEnvArgs): BuildSkillEnvResult` where
  `BuildSkillEnvArgs = { processEnv: NodeJS.ProcessEnv; grantedVariables: Record<string, string>; overrides?: NodeJS.ProcessEnv }`
  and `BuildSkillEnvResult = { env: NodeJS.ProcessEnv; strippedSecretNames: string[]; grantedNames: string[]; skippedNames: string[] }`.

- [ ] **Step 1: Write the failing tests**

```ts
// ee/invoke-skills/skill-env.test.ts
import { buildSkillEnv } from "./skill-env";

const base = { PATH: "/usr/bin", HOME: "/root", LANG: "de_DE.UTF-8" };

test("strips inventoried platform secrets", () => {
  const { env, strippedSecretNames } = buildSkillEnv({
    processEnv: { ...base, NEXTAUTH_SECRET: "s3cret", LITELLM_MASTER_KEY: "sk-0" },
    grantedVariables: {},
  });
  expect(env.NEXTAUTH_SECRET).toBeUndefined();
  expect(env.LITELLM_MASTER_KEY).toBeUndefined();
  expect(strippedSecretNames).toEqual(["LITELLM_MASTER_KEY", "NEXTAUTH_SECRET"]);
});

test("a canary secret never reaches a skill", () => {
  const { env } = buildSkillEnv({
    processEnv: { ...base, NEXTAUTH_SECRET: "EXULU_CANARY_VALUE" },
    grantedVariables: {},
  });
  expect(JSON.stringify(env)).not.toContain("EXULU_CANARY_VALUE");
});

test("third-party runtime settings pass through untouched", () => {
  const { env } = buildSkillEnv({
    processEnv: { ...base, PYMUPDF_MESSAGE: "fd:2", HF_HUB_ENABLE_HF_TRANSFER: "1" },
    grantedVariables: {},
  });
  expect(env.PYMUPDF_MESSAGE).toBe("fd:2");
  expect(env.HF_HUB_ENABLE_HF_TRANSFER).toBe("1");
  expect(env.LANG).toBe("de_DE.UTF-8");
});

test("only granted variables are injected", () => {
  const { env, grantedNames } = buildSkillEnv({
    processEnv: base,
    grantedVariables: { JIRA_CLIENT_ID: "abc" },
  });
  expect(env.JIRA_CLIENT_ID).toBe("abc");
  expect(grantedNames).toEqual(["JIRA_CLIENT_ID"]);
});

test("a granted variable colliding with a base runtime key is skipped", () => {
  const { env, skippedNames } = buildSkillEnv({
    processEnv: base,
    grantedVariables: { PATH: "/evil" },
  });
  expect(env.PATH).toBe("/usr/bin");
  expect(skippedNames).toEqual(["PATH"]);
});

test("a granted variable named like a platform secret carries the admin value, never the platform one", () => {
  const { env } = buildSkillEnv({
    processEnv: { ...base, NEXTAUTH_SECRET: "platform-value" },
    grantedVariables: { NEXTAUTH_SECRET: "admin-value" },
  });
  expect(env.NEXTAUTH_SECRET).toBe("admin-value");
});

test("names bash cannot export are skipped", () => {
  const { env, skippedNames } = buildSkillEnv({
    processEnv: base,
    grantedVariables: { "MY-VAR": "x", "2FA_KEY": "y", OK_VAR: "z" },
  });
  expect(env["MY-VAR"]).toBeUndefined();
  expect(env["2FA_KEY"]).toBeUndefined();
  expect(env.OK_VAR).toBe("z");
  expect(skippedNames).toEqual(["2FA_KEY", "MY-VAR"]);
});

test("computed overrides always win", () => {
  const { env } = buildSkillEnv({
    processEnv: base,
    grantedVariables: { NODE_PATH: "/tmp/evil" },
    overrides: { NODE_PATH: "/usr/lib/node_modules" },
  });
  expect(env.NODE_PATH).toBe("/usr/lib/node_modules");
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx jest ee/invoke-skills/skill-env.test.ts`
Expected: FAIL — `Cannot find module './skill-env'`.

- [ ] **Step 3: Implement**

```ts
// ee/invoke-skills/skill-env.ts
import { isSecretEnvName } from "@SRC/exulu/skill-env/inventory";

export type BuildSkillEnvArgs = {
  processEnv: NodeJS.ProcessEnv;
  grantedVariables: Record<string, string>;
  overrides?: NodeJS.ProcessEnv;
};

export type BuildSkillEnvResult = {
  env: NodeJS.ProcessEnv;
  strippedSecretNames: string[];
  grantedNames: string[];
  skippedNames: string[];
};

const POSIX_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The only way a skill's bash environment is constructed.
 *
 * Order: base runtime env (process.env minus declared secrets), then granted
 * variables, then computed overrides. Unknown names pass through by design —
 * stripping what we cannot enumerate is what breaks the document toolchain.
 */
export const buildSkillEnv = ({
  processEnv,
  grantedVariables,
  overrides = {},
}: BuildSkillEnvArgs): BuildSkillEnvResult => {
  const env: NodeJS.ProcessEnv = {};
  const strippedSecretNames: string[] = [];

  for (const [name, value] of Object.entries(processEnv)) {
    if (isSecretEnvName(name)) {
      strippedSecretNames.push(name);
      continue;
    }
    env[name] = value;
  }

  const baseKeys = new Set(Object.keys(env));
  const grantedNames: string[] = [];
  const skippedNames: string[] = [];

  for (const [name, value] of Object.entries(grantedVariables)) {
    if (!POSIX_NAME.test(name) || baseKeys.has(name)) {
      skippedNames.push(name);
      continue;
    }
    env[name] = value;
    grantedNames.push(name);
  }

  Object.assign(env, overrides);

  return {
    env,
    strippedSecretNames: strippedSecretNames.sort(),
    grantedNames: grantedNames.sort(),
    skippedNames: skippedNames.sort(),
  };
};
```

Note the collision test: a granted `NEXTAUTH_SECRET` is **not** a collision, because the platform's copy was already stripped and is therefore not in `baseKeys`.

- [ ] **Step 4: Run until green**

Run: `npx jest ee/invoke-skills/skill-env.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add ee/invoke-skills/skill-env.ts ee/invoke-skills/skill-env.test.ts
git commit -m "feat(skills): buildSkillEnv composes the sandbox env from an explicit policy"
```

---

### Task 3: Wire buildSkillEnv into the sandbox and close the spawn leak

**Files:**
- Modify: `ee/invoke-skills/create-sandbox.ts` (env construction ~line 598-611; `spawn` ~line 755)
- Test: `ee/invoke-skills/create-sandbox.env.test.ts`

**Interfaces:**
- Consumes: `buildSkillEnv` from Task 2.
- Produces: `createSandbox` continues to export its current shape; no signature change.

- [ ] **Step 1: Write the failing regression test**

```ts
// ee/invoke-skills/create-sandbox.env.test.ts
test("the writeFile spawn is given an explicit env, never the inherited one", () => {
  // Guard against regression of the leak-by-omission at create-sandbox.ts:755.
  const src = require("fs").readFileSync(
    require("path").join(__dirname, "create-sandbox.ts"),
    "utf8",
  );
  const spawnCalls = [...src.matchAll(/spawn\(\s*['"]\/bin\/bash['"][\s\S]{0,200}?\)/g)];
  expect(spawnCalls.length).toBeGreaterThan(0);
  for (const call of spawnCalls) {
    expect(call[0]).toContain("env:");
  }
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx jest ee/invoke-skills/create-sandbox.env.test.ts`
Expected: FAIL — the `spawn` call has no `env:`.

- [ ] **Step 3: Replace the env construction**

Delete the `sandboxedExecEnv` literal at ~line 605 and use the builder:

```ts
const { env: sandboxedExecEnv, strippedSecretNames, grantedNames, skippedNames } =
    buildSkillEnv({
        processEnv: process.env,
        grantedVariables: configuredVariables,
        overrides: {
            ...(npmGlobalRoot ? { NODE_PATH: npmGlobalRoot } : {}),
            ...(pythonVenvPath
                ? { PATH: `${join(pythonVenvPath, 'bin')}:${process.env.PATH ?? ''}`, VIRTUAL_ENV: pythonVenvPath }
                : {}),
        },
    })

if (skippedNames.length) {
    console.warn(
        `[SKILLS] Skipped ${skippedNames.length} variable(s) for session ${sessionId}: ${skippedNames.join(", ")} (invalid env name or collides with a runtime key).`,
    )
}
```

Add the import at the top of the file:

```ts
import { buildSkillEnv } from './skill-env'
```

- [ ] **Step 4: Pass the env to the spawn**

At ~line 755, change:

```ts
const child = spawn('/bin/bash', ['-c', wrapped])
```

to:

```ts
const child = spawn('/bin/bash', ['-c', wrapped], { env: sandboxedExecEnv })
```

- [ ] **Step 5: Run the tests**

Run: `npx jest ee/invoke-skills/`
Expected: PASS. Then `npx tsc --noEmit 2>&1 | grep -c "error TS"` must not increase over the pre-change count.

- [ ] **Step 6: Commit**

```bash
git add ee/invoke-skills/create-sandbox.ts ee/invoke-skills/create-sandbox.env.test.ts
git commit -m "fix(skills): construct the sandbox env instead of inheriting it, on both exec paths"
```

---

### Task 4: allow_skill_access column and grant filter

**Files:**
- Modify: `src/postgres/core-schema.ts` (`variablesSchema`, ~line 154-176)
- Modify: `types/models/variable.ts`
- Create: `ee/invoke-skills/variable-grants.ts`
- Modify: `ee/invoke-skills/create-sandbox.ts` (`getAllExuluVariables`, line 33)
- Test: `ee/invoke-skills/variable-grants.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `Variable.allow_skill_access: boolean`; `getAllExuluVariables()` returns only granted rows.

- [ ] **Step 1: Write the failing test**

```ts
// ee/invoke-skills/variable-grants.test.ts
import { selectGrantedVariables } from "./variable-grants";

test("only variables with allow_skill_access are returned", () => {
  const rows = [
    { id: "1", name: "JIRA_CLIENT_ID", value: "a", encrypted: false, allow_skill_access: true },
    { id: "2", name: "ANTHROPIC_API_KEY", value: "b", encrypted: false, allow_skill_access: false },
    { id: "3", name: "LEGACY", value: "c", encrypted: false, allow_skill_access: null as any },
  ];
  expect(selectGrantedVariables(rows as any)).toEqual({ JIRA_CLIENT_ID: "a" });
});

test("underscore-prefixed and '=' names stay excluded", () => {
  const rows = [
    { id: "1", name: "_HIDDEN", value: "a", encrypted: false, allow_skill_access: true },
    { id: "2", name: "BAD=NAME", value: "b", encrypted: false, allow_skill_access: true },
  ];
  expect(selectGrantedVariables(rows as any)).toEqual({});
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx jest ee/invoke-skills/variable-grants.test.ts`
Expected: FAIL — `selectGrantedVariables is not a function`.

- [ ] **Step 3: Declare the field**

In `src/postgres/core-schema.ts`, add to `variablesSchema.fields`:

```ts
    {
      name: "allow_skill_access",
      type: "boolean",
      default: false,
    },
```

In `types/models/variable.ts`:

```ts
export interface Variable {
    id: string;
    name: string;
    value: string;
    encrypted: boolean;
    allow_skill_access: boolean;
    createdAt: string;
    updatedAt: string;
}
```

- [ ] **Step 4: Extract and filter in the loader**

Put the pure selection step in its own module so the unit test does not pull in `create-sandbox.ts`'s import graph (S3, postgres, sandbox-runtime). Create `ee/invoke-skills/variable-grants.ts`, and have `getAllExuluVariables` import and use it:

```ts
// ee/invoke-skills/variable-grants.ts
import type { Variable } from "@EXULU_TYPES/models/variable";

export const selectGrantedVariables = (rows: Variable[]): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const row of rows) {
        if (!row?.name) continue;
        if (row.allow_skill_access !== true) continue;
        if (row.name.startsWith("_")) continue;
        if (row.name.includes("=")) continue;
        if (typeof row.value !== "string") continue;
        out[row.name] = row.value;
    }
    return out;
};
```

Keep decryption where it is — `selectGrantedVariables` receives rows whose values are already decrypted by `getAllExuluVariables`.

- [ ] **Step 5: Run until green**

Run: `npx jest ee/invoke-skills/`
Expected: PASS.

- [ ] **Step 6: Verify the column appears**

Run the backend once against a dev database and confirm the log line `[EXULU] Adding missing field 'allow_skill_access' to variables table.` Then:

```sql
select column_name, column_default from information_schema.columns
where table_name = 'variables' and column_name = 'allow_skill_access';
```

Expected: one row, default `false`.

- [ ] **Step 7: Commit**

```bash
git add src/postgres/core-schema.ts types/models/variable.ts ee/invoke-skills/create-sandbox.ts ee/invoke-skills/variable-grants.test.ts
git commit -m "feat(variables): allow_skill_access grant, default off, filters the skill sandbox"
```

---

### Task 5: Audit event for sandbox creation

**Files:**
- Modify: `src/exulu/audit/event.ts`
- Modify: `src/exulu/audit/config.ts`
- Create: `src/exulu/audit/emitters/skill-sandbox.ts`
- Test: `src/exulu/audit/emitters/skill-sandbox.test.ts`

**Interfaces:**
- Consumes: `AuditEvent`, `AUDIT_EVENT_TYPES` from `event.ts`; `sanitizeData` from `redact.ts`.
- Produces: `AUDIT_EVENT_TYPES.SKILL_SANDBOX_CREATED = "skill.sandbox.created"`, type `AuditSkillSandboxInput`, and `buildSkillSandboxEvent(ctx: AuditSkillSandboxInput): AuditEvent`.

- [ ] **Step 1: Write the failing test**

```ts
// src/exulu/audit/emitters/skill-sandbox.test.ts
import { buildSkillSandboxEvent } from "./skill-sandbox";

const ctx = {
  sessionID: "sess-1",
  agent: { id: "ag-1", name: "Wartung" },
  user: { id: 7, email: "a@open.de", role: { id: "r1" } },
  skills: [{ id: "sk-1", name: "Wartungs Report PDF", version: 3 }],
  grantedNames: ["JIRA_CLIENT_ID"],
  withheldNames: ["ANTHROPIC_API_KEY"],
  strippedSecretCount: 12,
  skippedNames: [],
  degradedSandbox: false,
};

test("records names and counts, never values", () => {
  const e = buildSkillSandboxEvent(ctx as any);
  expect(e.type).toBe("skill.sandbox.created");
  expect(e.status).toBe("ok");
  expect(e.context?.sessionId).toBe("sess-1");
  expect(e.data?.grantedVariableNames).toEqual(["JIRA_CLIENT_ID"]);
  expect(e.data?.withheldVariableNames).toEqual(["ANTHROPIC_API_KEY"]);
  expect(e.data?.strippedSecretCount).toBe(12);
  expect(e.data?.degradedSandbox).toBe(false);
});

test("the serialized event contains no credential value", () => {
  const e = buildSkillSandboxEvent({ ...ctx, grantedNames: ["JIRA_CLIENT_ID"] } as any);
  expect(JSON.stringify(e)).not.toContain("sk-ant");
  expect(JSON.stringify(e)).not.toMatch(/value/i);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx jest src/exulu/audit/emitters/skill-sandbox.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Add the event type**

In `src/exulu/audit/event.ts`:

```ts
export const AUDIT_EVENT_TYPES = {
  TOOL_CALL: "tool.call",
  SKILL_SANDBOX_CREATED: "skill.sandbox.created",
} as const;

export type AuditSkillSandboxInput = {
  sessionID?: string;
  agent?: { id?: string; name?: string };
  user?: { id?: unknown; email?: string; role?: { id?: unknown } };
  projectId?: string;
  skills: Array<{ id: string; name: string; version?: number }>;
  grantedNames: string[];
  withheldNames: string[];
  skippedNames: string[];
  strippedSecretCount: number;
  degradedSandbox: boolean;
  client?: AuditClient;
};
```

- [ ] **Step 4: Write the emitter**

```ts
// src/exulu/audit/emitters/skill-sandbox.ts
import { AUDIT_EVENT_TYPES } from "../event";
import type { AuditEvent, AuditSkillSandboxInput } from "../event";

const str = (v: unknown): string | undefined =>
  v === undefined || v === null ? undefined : String(v);

/**
 * One event per sandbox creation. The grant set is fixed when the sandbox is
 * built, so per-command events would be noise. Names and counts only — no
 * credential value is ever read into this event.
 */
export const buildSkillSandboxEvent = (
  ctx: AuditSkillSandboxInput,
  opts: { nowIso?: () => string } = {},
): AuditEvent => {
  const nowIso = opts.nowIso ?? (() => new Date().toISOString());
  return {
    v: 1,
    ts: nowIso(),
    type: AUDIT_EVENT_TYPES.SKILL_SANDBOX_CREATED,
    actor: {
      kind: "agent",
      userId: str(ctx.user?.id),
      email: ctx.user?.email,
      roleId: str(ctx.user?.role?.id),
      projectId: ctx.projectId,
    },
    context: {
      sessionId: ctx.sessionID,
      agentId: ctx.agent?.id,
      agentName: ctx.agent?.name,
    },
    target: { kind: "skill_sandbox", id: ctx.sessionID },
    status: "ok",
    data: {
      skills: ctx.skills.map((s) => ({ id: s.id, name: s.name, version: s.version })),
      grantedVariableNames: ctx.grantedNames,
      withheldVariableNames: ctx.withheldNames,
      skippedVariableNames: ctx.skippedNames,
      strippedSecretCount: ctx.strippedSecretCount,
      degradedSandbox: ctx.degradedSandbox,
    },
    client: ctx.client,
  };
};
```

- [ ] **Step 5: Add the config source toggle**

In `src/exulu/audit/config.ts`, extend `AuditConfig.sources` and `ResolvedAuditConfig`:

```ts
  sources?: {
    toolCalls?: { enabled?: boolean; include?: string[]; exclude?: string[] };
    skillSandbox?: { enabled?: boolean };
  };
```

```ts
  skillSandbox: { enabled: boolean };
```

Resolve it alongside `toolCalls`, defaulting `enabled` to `false`.

- [ ] **Step 6: Run until green**

Run: `npx jest src/exulu/audit/`
Expected: PASS, including the existing audit tests.

- [ ] **Step 7: Commit**

```bash
git add src/exulu/audit/
git commit -m "feat(audit): skill.sandbox.created event recording granted and withheld variable names"
```

---

### Task 6: Emit the event from the sandbox

**Files:**
- Modify: `ee/invoke-skills/create-sandbox.ts`
- Modify: `src/exulu/audit/logger.ts` (add `shouldAuditSkillSandbox`)
- Test: `ee/invoke-skills/create-sandbox.audit.test.ts`

**Interfaces:**
- Consumes: `buildSkillSandboxEvent` (Task 5), `getAuditLogger`, `AuditLogger.record` from `logger.ts`, `buildSkillEnv` result fields (Task 2).
- Produces: nothing new for later tasks.

- [ ] **Step 1: Write the failing test**

```ts
// ee/invoke-skills/create-sandbox.audit.test.ts
import { buildSkillSandboxEvent } from "@SRC/exulu/audit/emitters/skill-sandbox";

test("a disabled audit logger is a no-op and never throws", () => {
  const noop = { enabled: false, record: jest.fn(), shouldAuditSkillSandbox: () => false } as any;
  const emit = () => {
    if (!noop.shouldAuditSkillSandbox()) return;
    noop.record(buildSkillSandboxEvent({} as any));
  };
  expect(emit).not.toThrow();
  expect(noop.record).not.toHaveBeenCalled();
});

test("withheld names are the ungranted variable names, not their values", () => {
  const all = ["JIRA_CLIENT_ID", "ANTHROPIC_API_KEY", "PERPLEXITY_API_KEY"];
  const granted = ["JIRA_CLIENT_ID"];
  const withheld = all.filter((n) => !granted.includes(n));
  const e = buildSkillSandboxEvent({
    skills: [], grantedNames: granted, withheldNames: withheld,
    skippedNames: [], strippedSecretCount: 0, degradedSandbox: false,
  } as any);
  expect(e.data?.withheldVariableNames).toEqual(["ANTHROPIC_API_KEY", "PERPLEXITY_API_KEY"]);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx jest ee/invoke-skills/create-sandbox.audit.test.ts`
Expected: FAIL — `shouldAuditSkillSandbox` missing from the logger interface.

- [ ] **Step 3: Add the logger gate**

In `src/exulu/audit/logger.ts`, add to `AuditLogger`, to `noop` (returning `false`), and to `RealAuditLogger` (returning `this.resolved.skillSandbox.enabled`):

```ts
  shouldAuditSkillSandbox: () => boolean;
```

- [ ] **Step 4: Have getAllExuluVariables report withheld names**

Change `getAllExuluVariables` to return both maps so the emitter can name what was withheld:

```ts
const getAllExuluVariables = async (): Promise<{
    granted: Record<string, string>;
    withheldNames: string[];
}> => {
    // ...existing fetch + decrypt loop, unchanged, producing `decrypted: Variable[]`
    const granted = selectGrantedVariables(decrypted);
    const withheldNames = decrypted
        .filter((row) => row?.name && !(row.name in granted))
        .map((row) => row.name)
        .sort();
    return { granted, withheldNames };
};
```

A row whose decryption failed is already skipped by the existing `continue`, so it lands in `withheldNames` — which is the behaviour the Review Focus calls for.

Update the call site at ~line 588 in the same step, or Task 3's wiring breaks:

```ts
let configuredVariables: Record<string, string> = {}
let withheldNames: string[] = []
try {
    const loaded = await getAllExuluVariables()
    configuredVariables = loaded.granted
    withheldNames = loaded.withheldNames
} catch (err) {
    console.error(
        `[SKILLS] Failed to load configured variables for session ${sessionId}; bash env will not include them.`,
        err,
    )
}
```

- [ ] **Step 5: Emit after the env is built**

```ts
const auditLogger = getAuditLogger(exuluConfig ?? {})
if (auditLogger.shouldAuditSkillSandbox()) {
    auditLogger.record(
        buildSkillSandboxEvent({
            sessionID: sessionId,
            agent: { id: agent?.id, name: agent?.name },
            user,
            skills: skills.map((s) => ({ id: s.id, name: s.name, version: s.current_version })),
            grantedNames,
            withheldNames,
            skippedNames,
            strippedSecretCount: strippedSecretNames.length,
            degradedSandbox: useDirectExec,
        }),
    )
}

if (withheldNames.length) {
    console.log(
        `[SKILLS] Session ${sessionId}: ${withheldNames.length} variable(s) not shared with skills: ${withheldNames.join(", ")}.`,
    )
}
```

- [ ] **Step 6: Run the suites**

Run: `npx jest ee/invoke-skills/ src/exulu/audit/`
Expected: PASS. Then `npx tsc --noEmit 2>&1 | grep -c "error TS"` unchanged.

- [ ] **Step 7: Commit**

```bash
git add ee/invoke-skills/create-sandbox.ts ee/invoke-skills/create-sandbox.audit.test.ts src/exulu/audit/logger.ts
git commit -m "feat(skills): emit skill.sandbox.created and log withheld variable names"
```

---

### Task 7: Frontend toggle and badge

**Files (repo: `exulu-frontend`, branch `main`):**
- Modify: the variables admin form component under `app/(application)/variables/`
- Modify: the variables list/table component in the same directory
- Modify: the i18n message files (`messages/en.json`, `messages/de.json`)
- Test: a vitest spec beside the form component

**Interfaces:**
- Consumes: the `allow_skill_access` field exposed by the backend GraphQL schema (Task 4).
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Locate the components**

```bash
cd ../frontend && git branch --show-current   # expect: main
rg -l "variables" "app/(application)" --glob '*.tsx' | head
```

- [ ] **Step 2: Write the failing test**

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { VariableForm } from "./variable-form";

describe("VariableForm", () => {
  test("renders the skill-access toggle with its explanation", () => {
    render(<VariableForm value={{ name: "X", value: "y", encrypted: true, allow_skill_access: false }} onChange={() => {}} />);
    expect(screen.getByLabelText(/allow agent access when using skills/i)).toBeDefined();
    expect(screen.getByText(/never shared with skills/i)).toBeDefined();
  });

  test("the toggle defaults to off for a new variable", () => {
    render(<VariableForm value={{ name: "", value: "", encrypted: true }} onChange={() => {}} />);
    expect((screen.getByLabelText(/allow agent access when using skills/i) as HTMLInputElement).checked).toBe(false);
  });
});
```

- [ ] **Step 3: Run it and watch it fail**

Run: `npx vitest run app/\(application\)/variables`
Expected: FAIL — no such label.

- [ ] **Step 4: Add the toggle**

Add a `Switch` bound to `allow_skill_access`, defaulting to `false`, with this copy (add both keys to `messages/en.json` and `messages/de.json`):

> **Allow agent access when using skills**
> When enabled, this variable's value is available to skills running in the agent sandbox, so a skill can call the service it belongs to. Leave it off for credentials no skill needs — skills execute code, and anything they can read they can send on. Platform secrets such as database, storage and proxy credentials are never shared with skills, regardless of this setting.

- [ ] **Step 5: Add the list badge**

In the variables table, render a "Shared with skills" badge on rows where `allow_skill_access` is true, so the full exposure is legible on one screen.

- [ ] **Step 6: Run the checks**

Run: `npx vitest run && npx tsc --noEmit 2>&1 | grep -c "error TS" && npx next build 2>&1 | tail -5`
Expected: tests pass, tsc error count unchanged, build succeeds.

- [ ] **Step 7: Commit**

```bash
git add -A app messages
git commit -m "feat(variables): allow agent access when using skills toggle and list badge"
```

---

### Task 8: Startup warning, docs, and release note

**Files:**
- Modify: the backend startup path that already runs init (same place `initAudit` is called)
- Modify: `mintlify-docs/administration/variables.mdx`
- Create: a release note entry for the breaking default

**Interfaces:**
- Consumes: `findUnclassifiedSecretShaped` (Task 1).
- Produces: nothing.

- [ ] **Step 1: Write the failing test**

```ts
// src/exulu/skill-env/startup-warning.test.ts
import { skillEnvStartupWarning } from "./startup-warning";

test("warns about secret-shaped names the inventory does not know", () => {
  expect(skillEnvStartupWarning({ ACME_API_KEY: "x", PATH: "/bin" }))
    .toContain("ACME_API_KEY");
});

test("says nothing when every secret-shaped name is classified", () => {
  expect(skillEnvStartupWarning({ PATH: "/bin", NEXTAUTH_SECRET: "x" })).toBeNull();
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx jest src/exulu/skill-env/startup-warning.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement and call it at startup**

```ts
// src/exulu/skill-env/startup-warning.ts
import { findUnclassifiedSecretShaped } from "./inventory";

export const skillEnvStartupWarning = (env: NodeJS.ProcessEnv): string | null => {
  const unknown = findUnclassifiedSecretShaped(env);
  if (!unknown.length) return null;
  return `[SKILLS] ${unknown.length} credential-shaped environment variable(s) are not in the secret inventory and will be visible to skills: ${unknown.join(", ")}. Classify them in src/exulu/skill-env/inventory.ts.`;
};
```

Call it once at boot beside `initAudit`, logging with `console.warn` when it returns a string.

- [ ] **Step 4: Update the docs**

In `mintlify-docs/administration/variables.mdx`, document the toggle, state that it defaults to off, and state that platform secrets are never shared with skills regardless of the setting.

- [ ] **Step 5: Write the release note**

State plainly: *after this release, no variable is shared with skills until an administrator enables it on each variable. Skills that depend on a variable will fail until the toggle is set.*

- [ ] **Step 6: Run the full suites**

Run (backend): `npx jest 2>&1 | tail -5` — no new failures.
Run (frontend): `npx vitest run 2>&1 | tail -3`.

- [ ] **Step 7: Commit**

```bash
git add src/exulu/skill-env/startup-warning.ts src/exulu/skill-env/startup-warning.test.ts mintlify-docs/administration/variables.mdx
git commit -m "feat(skills): startup warning for unclassified credential-shaped env vars; document the grant toggle"
```

---

## Manual verification before merge

1. On a test instance, attach the Wartungs-Report skill to an agent and run it with its variable toggled **off** — confirm it fails and that the log names the withheld variable.
2. Toggle the variable **on**, re-run — confirm it succeeds.
3. Confirm a document-producing skill still renders correctly (fonts, umlauts, PDF output) — this is the regression the denylist design exists to prevent.
4. With audit enabled, confirm one `skill.sandbox.created` record per sandbox, containing names and no values.
5. Merge backend and frontend together.
