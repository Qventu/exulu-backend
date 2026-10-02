# Skill Sandbox Credential Isolation — Design

**Date:** 2026-10-02
**Status:** Approved for planning

## Problem

`ee/invoke-skills/create-sandbox.ts` builds the environment for every skill's
bash invocation as:

```ts
const sandboxedExecEnv = {
    ...configuredVariables,   // every row of `variables`, decrypted
    ...process.env,           // the deployment's entire environment
    ...computedOverrides,
}
```

Two consequences:

1. **Every platform secret reaches every skill.** `POSTGRES_DB_PASSWORD`,
   `NEXTAUTH_SECRET`, `LITELLM_MASTER_KEY`, the S3 credentials and the Vertex
   credential paths are all in the environment of any bash a skill runs.
2. **Every tool credential reaches every skill.** All `variables` rows are
   decrypted and injected regardless of which skill is running — a document
   generator sees the Jira client secret.

There is also a leak by omission: the `spawn('/bin/bash', ['-c', wrapped])` at
line 755 passes no `env` at all, so it inherits the full parent environment.
A fix that only removed the spread would leave that path intact.

This was found while investigating unexplained Anthropic API spend on
2026-10-01. The sandbox was **not** the cause of that spend, but the exposure
is real and independent of it.

## Goals

Two claims must be defensible in a client security review:

- **No ambient platform secrets** — a skill never sees the platform's own
  credentials.
- **Auditable credential access** — we can show which credentials were
  available to which skill run, and when.

## Non-goals

- **Per-skill least privilege.** Grants are per *variable*, not per skill. A
  granted variable is available to every skill.
- **Egress control.** A skill that holds a credential can still reach the
  network. Deliberately out of scope.
- **Changing how tool credentials are resolved elsewhere.** Only the skill
  sandbox is affected.

## Design

### 1. One env builder, two boundaries

A single `buildSkillEnv()` — new module `ee/invoke-skills/skill-env.ts`, so it
is unit-testable without constructing a sandbox — becomes the only way a skill
environment is constructed, composed in order:

1. **Base runtime env** — `process.env` minus every name classified `secret`
   in the inventory (§2). Keeps `PYMUPDF_MESSAGE`, `HF_HUB_*`, `LANG`,
   fontconfig and CA-bundle variables intact.
2. **Granted variables** — rows from `variables` where
   `allow_skill_access = true`, decrypted as today.
3. **Computed overrides** — `NODE_PATH`, `VIRTUAL_ENV`, venv `PATH`. Applied
   last so they always win.

**Collision rule.** Today `process.env` is spread after variables, so the
deployment env wins. With secrets stripped, that collision no longer matters —
but a granted variable named `PATH` or `HOME` could now shadow the runtime.
A granted variable whose name collides with a base runtime key is **skipped
and logged**, never applied.

Both exec sites use the builder: `execAsync` (line 628) as today, and the
`spawn` (line 755) gains an explicit `env`.

### 2. The secret inventory

A declared inventory lists every `process.env` name the backend consumes, each
classified `secret` or `runtime` with a one-line reason. 124 distinct names
read across `src`/`ee` as of this date.

Two tests give it teeth:

- **Completeness** — every `process.env.X` read in `src`/`ee` appears in the
  inventory. CI fails when a variable is introduced without classification.
  Variables our code never reads (third-party runtime settings) are out of
  scope for this test by design — see §5.
- **Exclusion** — for each `secret` name, `buildSkillEnv()` output omits it.
  Plus a canary: `EXULU_CANARY_SECRET` injected in test must be absent.

The inventory is also a compliance artifact: it answers "which secrets does
the platform hold" in a reviewable file.

### 3. The variables toggle

`variables` is declared in `src/postgres/core-schema.ts:155`, model in
`types/models/variable.ts`.

- **Column**: `allow_skill_access boolean not null default false`.
- **Migration**: none needed as a bespoke step. `addMissingFields`
  (`src/postgres/init-exulu-db.ts:46`) adds any field declared in the schema
  that has no column yet, via `knex.schema.alterTable` + `mapType` with the
  declared default. Declaring the field *is* the migration; existing rows take
  the default. The grant filter uses `= true`, so both `false` and a legacy
  `null` read as "not granted".
- **Filter**: `getAllExuluVariables()` (`create-sandbox.ts:33`) gains
  `where allow_skill_access = true`. It is module-local with one call site, so
  nothing outside the sandbox is affected.
- **UI**: a toggle on the variable form, and a "Shared with skills" badge on
  the variables list so the whole exposure is legible on one screen.

Microcopy:

> **Allow agent access when using skills**
> When enabled, this variable's value is available to skills running in the
> agent sandbox, so a skill can call the service it belongs to. Leave it off
> for credentials no skill needs — skills execute code, and anything they can
> read they can send on. Platform secrets such as database, storage and proxy
> credentials are never shared with skills, regardless of this setting.

### 4. Audit emitter

A new type `skill_sandbox_created` in `AUDIT_EVENT_TYPES`
(`src/exulu/audit/event.ts`), emitted **once per sandbox creation** — the grant set is fixed at build time, so per-command
events would be noise.

Payload: skills in the session (id, name, version), session and agent id, the
acting user via `client-info.ts` / `describeCredentialIdentity`, the granted
variable **names**, the withheld variable names, counts of secrets stripped and
collisions skipped, and whether the sandbox ran in degraded (non-bwrap) mode
(`EXULU_REQUIRE_SANDBOX`, line 488).

Names only, never values, through the existing `sanitizeData` + `redactKeys`
path in `redact.ts`. Off by default via `audit/config.ts`, like the rest of the
layer. `emitters/tool-call.ts` is the template.

### 5. Rollout and diagnosability

**Unknown variables pass through.** The completeness test covers names *our
code* reads. `PYMUPDF_MESSAGE`, `HF_HUB_*` and `LANG` are read by child
processes, never by us, so they will never be in the inventory. The runtime
rule is therefore **fail-open**: strip what is declared secret, pass everything
else. This is what protects the document toolchain, and it is why this is a
declared-denylist design rather than an allowlist.

For a deployment-set secret our code never reads, a **startup warning** (not a
strip) fires when an env name matches `/(SECRET|PASSWORD|TOKEN|_KEY|CREDENTIAL|PRIVATE)/i`
and is absent from the inventory. Detection without breakage.

**Breakage discovery.** Reads inside a skill cannot be detected, but at sandbox
creation the withheld variable names are logged and recorded in the audit
event, so a broken skill is diagnosable from one log line.

**Lockstep release.** There is no safe intermediate state where the filter is
live but the toggle UI is not — admins would have no way to re-enable. Backend
and frontend ship together, with a release note stating that no variable is
shared with skills until enabled.

**Existing failure behaviour is preserved**: a variable-load failure stays
non-fatal (empty map), but now surfaces in the audit event.

### 6. Tests

| Test | Asserts |
|---|---|
| Exclusion (table-driven over inventory) | every declared secret absent |
| Canary | `EXULU_CANARY_SECRET` never appears |
| Runtime passthrough | `PYMUPDF_MESSAGE`, `LANG`, `HF_HUB_*` survive |
| Grant filter | only `allow_skill_access = true` variables appear |
| Collision | variable named `PATH` skipped and warned; overrides win |
| CI completeness guard | every `process.env.X` in `src`/`ee` classified |
| Migration | idempotent, column present, defaults false |
| Line 755 regression | `spawn` receives the constructed env |
| Audit | event shape, names-only, off by default |

Manual E2E: run the Wartungs-Report skill on a test instance with its variable
toggled off, then on.

## Decisions taken

- **Default for existing variables: OFF.** Strictest default; skills relying on
  a variable break until an admin opts in. Accepted in exchange for the
  cleanest review answer.
- **Denylist, not allowlist**, for `process.env` — chosen to protect the
  document-generation toolchain, whose runtime variables cannot be enumerated
  from our code.
- **No passthrough escape hatch.** Unneeded: unknown names already pass
  through under the fail-open rule.
