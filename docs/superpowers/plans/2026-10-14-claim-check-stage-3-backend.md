# Claim Check — Stage 3, Backend Half (metadata + persistence) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the chat everything it needs to run a claim check and show it again after a reload: a metadata fragment on the turn's `finish` part telling the frontend the check is enabled and which sources to send, and a `claim_checks` table the endpoint writes and the chat reads back per session.

**Architecture:** Three additions, each mirroring an existing pattern. `claimCheckMetadata` follows `recalledMemoriesMetadata` exactly — a pure function merged into the `messageMetadata` callback's `finish` branch, emitting **ids only** so ~22k tokens of evidence do not travel twice. The table is an `ExuluTableDefinition` in `ee/schemas.ts` registered license-gated in `core-schema.ts`, like `feedbackSchema`. Persistence is a write inside the existing `POST /claims/check` handler plus one new `GET /claims/check/:session` so the chat can rehydrate without touching the shared message-load path.

**Tech Stack:** TypeScript (Node v22.18.0), express 5, knex, jest + ts-jest + supertest, zod 4.

**Spec:** `docs/superpowers/specs/2026-10-13-claim-check-design.md` — §5 (chat integration), §5.2 (persistence), §9 stage 3.

## Global Constraints

- Repo: `/Users/daniel.claessen/Desktop/Projects/exulu/backend-claim-ui`, branch `feature/claim-check-ui`, forked from `develop` at `184afa7`. `node_modules` is symlinked to the sibling primary checkout.
- Tests: `npx jest <path>`. Path aliases `@SRC/*` → `src/*`, `@EE/*` → `ee/*`, `@EXULU_TYPES/*` → `types/*`.
- Conventional commits, scope `claim-check`.
- `npm run type-check 2>&1 | grep -E "error TS" | sort | diff - /tmp/typecheck-baseline.txt` must print nothing. **Regenerate the baseline first** (Task B1 step 1) — this branch forks from `develop`, not from the Stage 1 branch, so the old file is stale. It takes over two minutes; run it once per task at the end.
- Lint: `npm run lint` covers only `src/` and reports 211 errors / 911 warnings at the fork point. The gate is **no new errors in non-test files**, not an unchanged total: eslint type-checks every `.ts` while `tsconfig.json` excludes `**/*.test.ts`, so each new test file adds exactly one `parserOptions.project` parse error (211→212 for one new test file, and so on). Prove it by comparing the *set of files with errors* before and after, not the count alone. For `ee/` files use `npx eslint <file>`. Test files cannot be linted (every test file hits a pre-existing `parserOptions.project` parse error).
- **The metadata fragment carries ids, never content.** The client already holds the tool output it renders source cards from; re-sending evidence through metadata would double a payload that averages ~89,000 characters.
- **Absent, not empty.** When the check is off, or the viewer is an external/guest user and `showToExternalUsers` is false, the fragment must be **absent** from the metadata — not present-and-false. The frontend's rule is "no fragment, no check ever runs".
- **Every new env var must be classified** in `src/exulu/skill-env/inventory.ts` or `src/exulu/skill-env/inventory.test.ts` fails. This plan adds none; do not add one.
- Test output must be pristine; spy on `console.warn`/`console.error` where a path logs deliberately.

## Review Focus

1. **A turn with no retrieval call** — the fragment must be absent, because a check with no sources would score every claim `unsupported` (Task B1).
2. **A guest viewer on a public link** — `showToExternalUsers: false` must win over `enabled: true`, and the fragment must be absent rather than empty (Task B1).
3. **A second check posted for a message that already has one** — the write must replace rather than accumulate, or the chat shows two panels for one answer (Task B3).
4. **A session id that is not a uuid, and a session belonging to another user** — the GET must not leak another tenant's claim checks, and must not 500 on a malformed id (Task B3).
5. **An agent whose `claim_check` blob is malformed JSON** — `parsePipelineConfig` already falls back to defaults with a warning, so the fragment must be absent (default `enabled: false`), never a throw inside the metadata callback that would break the whole turn's finish part (Task B1).

---

### Task B1: `claimCheckMetadata` on the turn's finish part

**Files:**
- Create: `src/exulu/claim-check/finish-metadata.ts`
- Create: `src/exulu/claim-check/finish-metadata.test.ts`
- Modify: `src/exulu/routes.ts` (import beside `recalledMemoriesMetadata` at line 66; call inside the `messageMetadata` callback's `part.type === "finish"` branch, beside `recalledMemoriesMetadata` at line 878)

**Interfaces:**
- Consumes: `pipelineConfigFor(agent)` from `@EE/claim-check/agent-config` (returns a fully-populated `PipelineConfig`, never throws); `isExternalOrAnonymousUser(user)` from `@SRC/exulu/resolve-max-steps`.
- Produces: `claimCheckMetadata(args: { agent: ExuluAgent; user?: User; toolResults: unknown }): { claimCheck: ClaimCheckTrigger } | Record<string, never>` and `type ClaimCheckTrigger = { enabled: true; sourceIds: string[]; toolCallIds: string[] }`.

- [ ] **Step 1: Regenerate the typecheck baseline for this branch**

```bash
cd /Users/daniel.claessen/Desktop/Projects/exulu/backend-claim-ui
git branch --show-current   # must print feature/claim-check-ui
npm run type-check 2>&1 | grep -E "error TS" | sort > /tmp/typecheck-baseline.txt
wc -l < /tmp/typecheck-baseline.txt   # expected 8
cat /tmp/typecheck-baseline.txt
```

Every later task diffs against this file.

- [ ] **Step 2: Write the failing test**

```typescript
// src/exulu/claim-check/finish-metadata.test.ts
import { claimCheckMetadata } from "./finish-metadata";

/** An assistant message's parts, as the SDK shapes them. */
const retrievalParts = [
  { type: "step-start" },
  {
    type: "tool-Context_Search",
    toolCallId: "call_1",
    output: {
      result: JSON.stringify({
        chunks: [
          { chunk_id: "k1", item_id: "i1", item_name: "handbuch.pdf", chunk_content: "..." },
          { chunk_id: "k2", item_id: "i2", item_name: "ticket.txt", chunk_content: "..." },
        ],
      }),
    },
  },
  { type: "text", text: "Die FST-2XT arbeitet mit 230 Volt." },
];

const agentWith = (claimCheck: string) =>
  ({
    id: "agent-1",
    tools: [
      { id: "agentic_context_search", config: [{ name: "claim_check", variable: claimCheck, type: "json" }] },
    ],
  }) as any;

const user = (over: Record<string, unknown> = {}) => ({ id: 7, type: "user", ...over }) as any;

describe("claimCheckMetadata", () => {
  it("emits ids only — never chunk content — when the check is enabled", () => {
    const meta = claimCheckMetadata({
      agent: agentWith('{"enabled":true}'),
      user: user(),
      toolResults: retrievalParts,
    });
    expect(meta).toEqual({
      claimCheck: { enabled: true, sourceIds: ["i1", "i2"], toolCallIds: ["call_1"] },
    });
    expect(JSON.stringify(meta)).not.toContain("chunk_content");
  });

  it("is ABSENT when the agent has the check disabled", () => {
    expect(claimCheckMetadata({ agent: agentWith('{"enabled":false}'), user: user(), toolResults: retrievalParts })).toEqual({});
  });

  it("is ABSENT when the agent has no claim_check config at all (default off)", () => {
    expect(claimCheckMetadata({ agent: { id: "a", tools: [] } as any, user: user(), toolResults: retrievalParts })).toEqual({});
  });

  // Review Focus 5
  it("is ABSENT, not a throw, when the claim_check blob is malformed JSON", () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(claimCheckMetadata({ agent: agentWith("{not json"), user: user(), toolResults: retrievalParts })).toEqual({});
    } finally {
      warn.mockRestore();
    }
  });

  // Review Focus 1
  it("is ABSENT when the turn made no retrieval call", () => {
    const noRetrieval = [{ type: "step-start" }, { type: "text", text: "Gern!" }];
    expect(claimCheckMetadata({ agent: agentWith('{"enabled":true}'), user: user(), toolResults: noRetrieval })).toEqual({});
  });

  it("is ABSENT when retrieval ran but returned no chunks", () => {
    const empty = [
      { type: "tool-Context_Search", toolCallId: "call_1", output: { result: JSON.stringify({ chunks: [] }) } },
    ];
    expect(claimCheckMetadata({ agent: agentWith('{"enabled":true}'), user: user(), toolResults: empty })).toEqual({});
  });

  // Review Focus 2
  it("is ABSENT for an external viewer when showToExternalUsers is false, even with the check enabled", () => {
    const meta = claimCheckMetadata({
      agent: agentWith('{"enabled":true,"showToExternalUsers":false}'),
      user: user({ role: { id: "r1", name: "external" } }),
      toolResults: retrievalParts,
    });
    expect(meta).toEqual({});
  });

  it("is emitted for an external viewer when showToExternalUsers is true", () => {
    const meta = claimCheckMetadata({
      agent: agentWith('{"enabled":true,"showToExternalUsers":true}'),
      user: user({ role: { id: "r1", name: "external" } }),
      toolResults: retrievalParts,
    });
    expect(meta).toEqual({
      claimCheck: { enabled: true, sourceIds: ["i1", "i2"], toolCallIds: ["call_1"] },
    });
  });

  it("deduplicates source ids across several retrieval calls and keeps first-seen order", () => {
    const twoCalls = [
      { type: "tool-Context_Search", toolCallId: "call_1", output: { result: JSON.stringify({ chunks: [{ item_id: "i2" }, { item_id: "i1" }] }) } },
      { type: "tool-Knowledge_context_search", toolCallId: "call_2", output: { result: JSON.stringify({ chunks: [{ item_id: "i1" }, { item_id: "i3" }] }) } },
    ];
    const meta = claimCheckMetadata({ agent: agentWith('{"enabled":true}'), user: user(), toolResults: twoCalls }) as any;
    expect(meta.claimCheck.sourceIds).toEqual(["i2", "i1", "i3"]);
    expect(meta.claimCheck.toolCallIds).toEqual(["call_1", "call_2"]);
  });

  it("survives a tool output that is not valid JSON without throwing", () => {
    const broken = [{ type: "tool-Context_Search", toolCallId: "call_1", output: { result: "<<not json>>" } }];
    expect(claimCheckMetadata({ agent: agentWith('{"enabled":true}'), user: user(), toolResults: broken })).toEqual({});
  });
});
```

- [ ] **Step 3: Run it and watch it fail**

Run: `npx jest src/exulu/claim-check/finish-metadata.test.ts`
Expected: FAIL — `Cannot find module './finish-metadata'`.

- [ ] **Step 4: Implement it**

```typescript
// src/exulu/claim-check/finish-metadata.ts
//
// The chat's trigger for a claim check, merged onto the SDK `finish` part the
// same way recalledMemoriesMetadata is (spec §5).
//
// Two rules the shape encodes:
//
//  - IDS ONLY. The client already holds the retrieval tool's output — it renders
//    source cards from it — so re-sending the evidence here would double a
//    payload that averages ~89,000 characters per turn. The frontend assembles
//    the `sources[]` array for POST /claims/check from what it already has.
//  - ABSENT, NOT EMPTY. When the check is off, or the viewer may not see it, the
//    fragment is missing entirely. The frontend's rule is "no fragment, no check
//    ever runs", so a present-but-false fragment would be a second state nobody
//    needs.
import type { ExuluAgent } from "@EXULU_TYPES/models/agent";
import type { User } from "@EXULU_TYPES/models/user";
import { pipelineConfigFor } from "@EE/claim-check/agent-config";
import { isExternalOrAnonymousUser } from "@SRC/exulu/resolve-max-steps";

/** What the chat needs to post a check: that it may, and what to send. */
export type ClaimCheckTrigger = {
  enabled: true;
  /** Item ids of the chunks this turn retrieved, first-seen order, deduplicated. */
  sourceIds: string[];
  /** The retrieval tool calls those chunks came from, so the client can find them. */
  toolCallIds: string[];
};

/** The retrieval tool is renamed per agent; these are the shapes it ships as. */
const RETRIEVAL_PART_TYPES = new Set(["tool-Context_Search", "tool-Knowledge_context_search"]);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** Item ids and tool-call ids from a turn's retrieval parts; never throws. */
function retrievedIdsOf(toolResults: unknown): { sourceIds: string[]; toolCallIds: string[] } {
  const sourceIds: string[] = [];
  const seen = new Set<string>();
  const toolCallIds: string[] = [];
  if (!Array.isArray(toolResults)) return { sourceIds, toolCallIds };

  for (const part of toolResults) {
    if (!isRecord(part) || typeof part.type !== "string") continue;
    // A renamed retrieval tool still starts with the same prefix shapes; match
    // the known names rather than any tool, so a web search or a memory write
    // never looks like evidence.
    if (!RETRIEVAL_PART_TYPES.has(part.type)) continue;
    const raw = isRecord(part.output) ? part.output.result : undefined;
    if (typeof raw !== "string") continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // A truncated or offloaded tool output is not a reason to break the
      // turn's finish part. Skip it; with no ids the fragment stays absent.
      continue;
    }
    if (!isRecord(parsed) || !Array.isArray(parsed.chunks)) continue;

    let contributed = false;
    for (const chunk of parsed.chunks) {
      if (!isRecord(chunk)) continue;
      const id = typeof chunk.item_id === "string" ? chunk.item_id : undefined;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      sourceIds.push(id);
      contributed = true;
    }
    if (contributed && typeof part.toolCallId === "string") toolCallIds.push(part.toolCallId);
  }

  return { sourceIds, toolCallIds };
}

/** Message metadata fragment merged on the SDK `finish` part (spec §5). */
export function claimCheckMetadata({ agent, user, toolResults }: {
  agent: ExuluAgent;
  user?: User;
  toolResults: unknown;
}): { claimCheck: ClaimCheckTrigger } | Record<string, never> {
  const cfg = pipelineConfigFor(agent).claimCheck;
  if (!cfg.enabled) return {};
  if (!cfg.showToExternalUsers && isExternalOrAnonymousUser(user)) return {};

  const { sourceIds, toolCallIds } = retrievedIdsOf(toolResults);
  // No retrieval, no evidence: a check here would mark every claim unsupported
  // for want of sources, which is a worse answer than no check at all.
  if (sourceIds.length === 0) return {};

  return { claimCheck: { enabled: true, sourceIds, toolCallIds } };
}
```

- [ ] **Step 5: Run the tests**

Run: `npx jest src/exulu/claim-check/finish-metadata.test.ts`
Expected: PASS, all ten.

- [ ] **Step 6: Wire it into the turn's finish metadata**

In `src/exulu/routes.ts`, beside the import at line 66:

```typescript
import { claimCheckMetadata } from "./claim-check/finish-metadata.ts";
```

Then inside the `messageMetadata` callback's `part.type === "finish"` branch, directly after the `recalledMemoriesMetadata(...)` spread:

```typescript
                // The chat posts the check itself once the stream ends; this
                // only tells it that it may, and which sources to send.
                ...claimCheckMetadata({
                  agent,
                  user,
                  toolResults: responseMessage?.parts,
                }),
```

Read the surrounding block first: `responseMessage` is the callback's own parameter in `onFinish`, **not** in `messageMetadata`. If `messageMetadata`'s `finish` branch has no access to the assistant message's parts, use the `originalMessages`/`messages` value that branch does have, or compute the ids in `onFinish` and stash them on a `let` declared beside `turnStartedAt` — whichever the actual code supports. Say in your report which you used and why.

- [ ] **Step 7: Verify the wiring compiles and the gates hold**

Run: `npx jest src/exulu/claim-check/ src/exulu/skill-env/`
Expected: PASS.
Run: `npx eslint src/exulu/claim-check/finish-metadata.ts` → 0 errors.
Run: `npm run lint 2>&1 | tail -5` → unchanged at 211 errors / 911 warnings.
Run: `npm run type-check 2>&1 | grep -E "error TS" | sort | diff - /tmp/typecheck-baseline.txt` → prints nothing.

- [ ] **Step 8: Commit**

```bash
git add src/exulu/claim-check/finish-metadata.ts src/exulu/claim-check/finish-metadata.test.ts src/exulu/routes.ts
git commit -m "feat(claim-check): tell the chat a check is available on the finish part"
```

---

### Task B2: the `claim_checks` table

**Files:**
- Modify: `ee/schemas.ts` (add `claimChecksSchema` beside `feedbackSchema`)
- Modify: `src/postgres/core-schema.ts` (import it; register it license-gated beside the `license["agent-feedback"]` block)
- Modify: `src/exulu/routes.ts` (add to the schema import list near line 184 and the invocation list near line 284)
- Modify: `src/postgres/init-exulu-db.ts` (add to the table list beside `feedbackSchema()`)
- Modify: `scripts/print-sdl.ts` (add `"claimChecksSchema"` to the name list near line 36)
- Test: `src/postgres/core-schema.test.ts`

**Interfaces:**
- Consumes: `ExuluTableDefinition` from `@EXULU_TYPES/exulu-table-definition`; `addCoreFields` and `checkLicense` as `core-schema.ts` already uses them.
- Produces: `claimChecksSchema: ExuluTableDefinition` with `type: "claim_checks"` and fields `session` (uuid), `message_id` (text), `payload` (json), `score_label` (enum), `user` (number).

- [ ] **Step 1: Write the failing test**

Append to `src/postgres/core-schema.test.ts`:

```typescript
describe("claim_checks table", () => {
  it("is registered only when the claim-check licence is present", () => {
    const withLicence = buildSchemas({ "claim-check": true } as any);
    expect(typeof withLicence.claimChecksSchema).toBe("function");

    const withoutLicence = buildSchemas({ "claim-check": false } as any);
    expect(withoutLicence.claimChecksSchema).toBeUndefined();
  });

  it("carries the fields the chat reads back", () => {
    const table = buildSchemas({ "claim-check": true } as any).claimChecksSchema!();
    const names = table.fields.map((f) => f.name);
    expect(names).toEqual(expect.arrayContaining(["session", "message_id", "payload", "score_label"]));
    expect(table.fields.find((f) => f.name === "payload")?.type).toBe("json");
    expect(table.fields.find((f) => f.name === "session")?.type).toBe("uuid");
  });
});
```

Read `core-schema.test.ts` first: if it has no `buildSchemas` helper, use whatever entry point its existing tests use to obtain the schema map for a given licence, and keep the two assertions above.

- [ ] **Step 2: Run it and watch it fail**

Run: `npx jest src/postgres/core-schema.test.ts`
Expected: FAIL — `claimChecksSchema` is undefined even with the licence.

- [ ] **Step 3: Define the table**

In `ee/schemas.ts`, beside `feedbackSchema`:

```typescript
/**
 * One stored claim check per assistant message (spec §5.2).
 *
 * `payload` holds the endpoint's whole response, so the chat can re-render a
 * panel after a reload without re-spending ~8 provider calls. `score_label` is
 * duplicated out of it only so a list view can colour a row without parsing
 * every payload.
 */
export const claimChecksSchema: ExuluTableDefinition = {
    type: "claim_checks",
    name: {
        plural: "claim checks",
        singular: "claim check",
    },
    fields: [
        {
            name: "session",
            type: "uuid",
        },
        {
            name: "message_id",
            type: "text",
        },
        {
            name: "payload",
            type: "json",
        },
        {
            name: "score_label",
            type: "enum",
            enumValues: ["ok", "warn", "alert", "n/a"],
        },
        {
            name: "user",
            type: "number",
        },
    ],
}
```

Match the file's own indentation (4 spaces) and quote style.

- [ ] **Step 4: Register it**

In `src/postgres/core-schema.ts`, add `claimChecksSchema` to the `@EE/schemas` import block, then beside the feedback block:

```typescript
    if (license["claim-check"]) {
      schemas.claimChecksSchema = (): ExuluTableDefinition => addCoreFields(claimChecksSchema)
    }
```

Then add it to the three lists that enumerate tables: the import and invocation lists in `src/exulu/routes.ts` (near lines 184 and 284), the table list in `src/postgres/init-exulu-db.ts` beside `feedbackSchema()`, and the name list in `scripts/print-sdl.ts`. **Read each list before editing** — a schema missing from one of them is a table the deployment never creates, and the GraphQL SDL is generated from a template literal that a stray backtick would silently break.

- [ ] **Step 5: Run the tests and the SDL check**

Run: `npx jest src/postgres/`
Expected: PASS.
Run: `npx tsx scripts/print-sdl.ts 2>&1 | grep -c "claim_check"` (or the script's documented invocation) — expected: a non-zero count, and no error output. If the script needs a database, say so in your report and skip it rather than inventing output.

- [ ] **Step 6: Commit**

```bash
git add ee/schemas.ts src/postgres/core-schema.ts src/postgres/core-schema.test.ts src/exulu/routes.ts src/postgres/init-exulu-db.ts scripts/print-sdl.ts
git commit -m "feat(claim-check): add the claim_checks table behind the entitlement"
```

---

### Task B3: persist a check and read a session's checks back

**Files:**
- Modify: `ee/claim-check/routes.ts` (write the row after a successful check; add `GET /claims/check/:session`)
- Modify: `ee/claim-check/routes.test.ts`
- Modify: `src/exulu/routes.ts` (pass the two new dependencies into `registerClaimCheckRoutes`)

**Interfaces:**
- Consumes: the existing `ClaimCheckRouteDeps` and `CLAIM_CHECK_PATH` in `ee/claim-check/routes.ts`; `requestValidators.authenticate`; the knex instance the other handlers obtain (read how `registerViewerIdentityRoutes` receives `getDb` and follow it).
- Produces: `CLAIM_CHECK_SESSION_PATH = "/claims/check/:session"`; two new deps `saveClaimCheck({ session, messageId, userId, result })` and `listClaimChecks({ session, userId })`; the GET's response shape `{ checks: Record<string, ClaimCheckResult> }` keyed by `message_id`.

- [ ] **Step 1: Write the failing tests**

Append to `ee/claim-check/routes.test.ts`:

```typescript
describe("persistence", () => {
  it("stores the result when the request names a session and a message", async () => {
    const saveClaimCheck = jest.fn().mockResolvedValue(undefined);
    const { app } = buildApp({ saveClaimCheck });
    const res = await request(app)
      .post(CLAIM_CHECK_PATH)
      .send({ ...BODY, session: "11111111-1111-4111-8111-111111111111", messageId: "msg_1" });
    expect(res.status).toBe(200);
    expect(saveClaimCheck).toHaveBeenCalledTimes(1);
    expect(saveClaimCheck.mock.calls[0][0]).toEqual(
      expect.objectContaining({ session: "11111111-1111-4111-8111-111111111111", messageId: "msg_1", userId: 7 }),
    );
  });

  it("does not store anything when the request names no session", async () => {
    const saveClaimCheck = jest.fn();
    const { app } = buildApp({ saveClaimCheck });
    expect((await request(app).post(CLAIM_CHECK_PATH).send(BODY)).status).toBe(200);
    expect(saveClaimCheck).not.toHaveBeenCalled();
  });

  it("still answers 200 when the write fails — a lost panel must not fail the check", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { app } = buildApp({ saveClaimCheck: jest.fn().mockRejectedValue(new Error("db down")) });
      const res = await request(app)
        .post(CLAIM_CHECK_PATH)
        .send({ ...BODY, session: "11111111-1111-4111-8111-111111111111", messageId: "msg_1" });
      expect(res.status).toBe(200);
      expect(res.body.score.label).toBe("ok");
    } finally {
      warn.mockRestore();
    }
  });

  // Review Focus 3
  it("replaces an existing row for the same message rather than accumulating", async () => {
    const saveClaimCheck = jest.fn().mockResolvedValue(undefined);
    const { app } = buildApp({ saveClaimCheck });
    const body = { ...BODY, session: "11111111-1111-4111-8111-111111111111", messageId: "msg_1" };
    await request(app).post(CLAIM_CHECK_PATH).send(body);
    await request(app).post(CLAIM_CHECK_PATH).send(body);
    expect(saveClaimCheck).toHaveBeenCalledTimes(2);
    // The dep contract is upsert-by-(session, message_id); both calls carry the
    // same key, and Task B3 step 4's implementation deletes before inserting.
    expect(saveClaimCheck.mock.calls[1][0].messageId).toBe("msg_1");
  });
});

describe(`GET ${CLAIM_CHECK_SESSION_PATH}`, () => {
  it("returns stored checks keyed by message id", async () => {
    const listClaimChecks = jest.fn().mockResolvedValue({ msg_1: RESULT });
    const { app } = buildApp({ listClaimChecks });
    const res = await request(app).get("/claims/check/11111111-1111-4111-8111-111111111111");
    expect(res.status).toBe(200);
    expect(res.body.checks.msg_1.score.label).toBe("ok");
    expect(listClaimChecks.mock.calls[0][0]).toEqual(
      expect.objectContaining({ session: "11111111-1111-4111-8111-111111111111", userId: 7 }),
    );
  });

  it("404s when the deployment is not licensed", async () => {
    const { app } = buildApp({ isLicensed: () => false });
    expect((await request(app).get("/claims/check/11111111-1111-4111-8111-111111111111")).status).toBe(404);
  });

  it("401s when authentication fails", async () => {
    const { app } = buildApp({ authenticate: async () => ({ error: true, code: 401, message: "no key" }) });
    expect((await request(app).get("/claims/check/11111111-1111-4111-8111-111111111111")).status).toBe(401);
  });

  // Review Focus 4
  it("400s on a session id that is not a uuid, without touching the database", async () => {
    const listClaimChecks = jest.fn();
    const { app } = buildApp({ listClaimChecks });
    expect((await request(app).get("/claims/check/not-a-uuid")).status).toBe(400);
    expect(listClaimChecks).not.toHaveBeenCalled();
  });

  // Review Focus 4
  it("scopes the lookup to the caller, so another tenant's checks cannot be read", async () => {
    const listClaimChecks = jest.fn().mockResolvedValue({});
    const { app } = buildApp({
      listClaimChecks,
      authenticate: async () => ({ user: { id: 99, type: "user" } as any }),
    });
    await request(app).get("/claims/check/11111111-1111-4111-8111-111111111111");
    expect(listClaimChecks.mock.calls[0][0].userId).toBe(99);
  });

  it("returns an empty object for a session with no checks", async () => {
    const { app } = buildApp({ listClaimChecks: jest.fn().mockResolvedValue({}) });
    const res = await request(app).get("/claims/check/11111111-1111-4111-8111-111111111111");
    expect(res.status).toBe(200);
    expect(res.body.checks).toEqual({});
  });
});
```

Add `saveClaimCheck` and `listClaimChecks` to the `buildApp` helper's default deps (a resolved `jest.fn()` each) so the existing tests keep working.

- [ ] **Step 2: Run them and watch them fail**

Run: `npx jest ee/claim-check/routes.test.ts`
Expected: FAIL — `CLAIM_CHECK_SESSION_PATH` is not exported and the GET route does not exist.

- [ ] **Step 3: Extend the deps type and the POST handler**

In `ee/claim-check/routes.ts`, add to `ClaimCheckRouteDeps`:

```typescript
  /** Upsert one stored check. Absent in tests that do not exercise persistence. */
  saveClaimCheck?: (args: {
    session: string;
    messageId: string;
    userId: number;
    result: ClaimCheckResult;
  }) => Promise<void>;
  /** Stored checks for a session, keyed by message id, scoped to the caller. */
  listClaimChecks?: (args: { session: string; userId: number }) => Promise<Record<string, ClaimCheckResult>>;
```

In the POST handler, after `res.status(200).json(result)` has been decided but before returning — write first, then answer, so a slow database cannot make the client wait? No: answer first. Put the write **after** the response is sent, and never let it change the status:

```typescript
      res.status(200).json(result);

      // Persistence is a convenience, not part of the verdict: a reload losing
      // the panel is worse than nothing, but a database hiccup must not turn a
      // completed check into an error the caller has already paid for.
      if (deps.saveClaimCheck && body.session && body.messageId) {
        try {
          await deps.saveClaimCheck({
            session: body.session,
            messageId: body.messageId,
            userId: Number(user.id),
            result,
          });
        } catch (err) {
          console.warn("[EXULU claim-check] could not store the check for this message.", err);
        }
      }
```

- [ ] **Step 4: Add the GET route**

```typescript
export const CLAIM_CHECK_SESSION_PATH = "/claims/check/:session";

/** Rejects anything that is not a v4-shaped uuid before the database sees it. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
```

and, inside `registerClaimCheckRoutes`, beside the POST:

```typescript
  app.get(CLAIM_CHECK_SESSION_PATH, async (req: Request, res: Response) => {
    if (!deps.isLicensed()) {
      res.status(404).json({ detail: "Not found." });
      return;
    }
    const session = req.params.session ?? "";
    if (!UUID_RE.test(session)) {
      res.status(400).json({ detail: "session must be a uuid." });
      return;
    }
    const auth = await deps.authenticate(req);
    if (!auth.user?.id) {
      res.status(auth.code || 401).json({ detail: auth.message ?? "Unauthorized." });
      return;
    }
    if (!deps.listClaimChecks) {
      res.status(200).json({ checks: {} });
      return;
    }
    try {
      const checks = await deps.listClaimChecks({ session, userId: Number(auth.user.id) });
      res.status(200).json({ checks });
    } catch (err) {
      console.error("[EXULU claim-check] could not read stored checks.", err);
      res.status(500).json({ detail: "Could not read stored checks." });
    }
  });
```

- [ ] **Step 5: Run the tests**

Run: `npx jest ee/claim-check/`
Expected: PASS — every pre-existing test plus the fourteen new ones.

- [ ] **Step 6: Wire the real database implementations**

In `src/exulu/routes.ts`, in the `registerClaimCheckRoutes(app, { ... })` call, add:

```typescript
    saveClaimCheck: async ({ session, messageId, userId, result }) => {
      const db = await getDb();
      // Upsert by (session, message_id): a reader who re-runs a check replaces
      // the row rather than stacking a second panel on the same answer.
      await db("claim_checks").where({ session, message_id: messageId }).del();
      await db("claim_checks").insert({
        session,
        message_id: messageId,
        payload: JSON.stringify(result),
        score_label: result.score.label,
        user: userId,
      });
    },
    listClaimChecks: async ({ session, userId }) => {
      const db = await getDb();
      const rows = await db("claim_checks").where({ session, user: userId }).select("message_id", "payload");
      const out: Record<string, unknown> = {};
      for (const row of rows) {
        out[row.message_id] =
          typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload;
      }
      return out as Record<string, ClaimCheckResult>;
    },
```

Read how the surrounding handlers obtain `db` in this file — if there is no `getDb` in scope at the registrar call site, use the same accessor the neighbouring `registerViewerIdentityRoutes({ getDb: ... })` passes, and say in your report which you used.

- [ ] **Step 7: Verify the gates**

Run: `npx jest ee/claim-check/ src/exulu/claim-check/ src/postgres/`
Expected: PASS.
Run: `npx eslint ee/claim-check/routes.ts` → 0 new errors.
Run: `npm run lint 2>&1 | tail -5` → unchanged.
Run: `npm run type-check 2>&1 | grep -E "error TS" | sort | diff - /tmp/typecheck-baseline.txt` → prints nothing.

- [ ] **Step 8: Document the new endpoint**

Add `GET /claims/check/:session` to `mintlify-docs/api-reference/rest/claim-check.mdx`: what it returns (stored checks keyed by message id), that it is scoped to the caller, that it 400s on a non-uuid session and 404s unlicensed, and that a check is stored only when the POST names both `session` and `messageId`.

- [ ] **Step 9: Commit**

```bash
git add ee/claim-check/routes.ts ee/claim-check/routes.test.ts src/exulu/routes.ts mintlify-docs/api-reference/rest/claim-check.mdx
git commit -m "feat(claim-check): persist a check per message and read a session's checks back"
```

---

## Backend half done when

- `npx jest ee/claim-check/ src/exulu/claim-check/ src/postgres/ src/exulu/skill-env/` is green.
- `npm run type-check` matches the baseline captured in Task B1.
- `npm run lint` still reports 211 errors / 911 warnings.
- The frontend half's plan (`2026-10-14-claim-check-stage-3-frontend.md`) can consume: the `claimCheck` metadata fragment, `POST /claims/check` with `session` + `messageId`, and `GET /claims/check/:session`.
