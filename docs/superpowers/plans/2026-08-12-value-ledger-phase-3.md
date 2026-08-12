# Value Ledger Phase 3 — What it's actually used for

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Answer "what is the platform actually used for" with two independent sources that cross-check each other — a deterministic tool-usage spine that needs no LLM, and a sampled intent classification that does.

**Architecture:** Both read `SpendLogs.proxy_server_request`, whose real shape was established by sampling 300 production rows. The deterministic spine recovers tool calls from resent assistant turns; the classifier reads only the first user message. Results land in the app's own database and are folded into the monthly snapshot like any other panel.

**Tech Stack:** Unchanged, plus one LLM call path through the customer's own LiteLLM gateway.

**Context:** Phases 0, 1 and 1.5 are complete — 194 tests, a report that tells a story, validated against production. This phase adds the panel Daniel has asked for twice.

## Verified structure — established by sampling 300 real production rows

Do not re-derive these; they were measured, and several contradict reasonable assumptions.

| Fact | Consequence |
|---|---|
| `proxy_server_request` **is the request body directly** — top-level `model`, `messages`, `tools`, `system`, `metadata`. There is **no `body` wrapper** | A parser reaching for `.body` gets `undefined` on every row |
| `messages` and `response` **columns** are frequently `{}` | Never read the `messages` column. Everything is in `proxy_server_request` |
| Median body **10.8 KB**, max **467 KB** | Fetching whole bodies for thousands of rows is expensive; sample, and select only the columns needed |
| First user message: median **1,697 chars** | Cheap to classify. This is the classifier's input |
| `content` is a **`str` in 212 of 300, a `list` in 88** | The list form is `[{type:"text", text:"…"}]`, sometimes with `cache_control`. A parser assuming string silently drops a third of rows into `unclassified`, looking like classifier weakness rather than a bug |
| Assistant turns carry `tool_use` parts with `name` | Tools **actually called** are recoverable — 20 distinct, thousands of calls |
| Conversations **resend their whole history** | The same `tool_use` appears in every later request. Naive counting overcounts enormously — see Task 2 |
| `SpendLogs.session_id` column is **100% populated** (Phase 0) | Use the column for session identity. The body's `litellm_session_id` is only on ~31% of rows — do not use it |

## Global Constraints

Carried from earlier phases. Every task's requirements implicitly include these.

- **C1 — Observe only.** Never prompt or survey a user. Tenant-level admin opt-in is configuration, not asking.
- **C2/G4 — Team-level only, min-N 5.** No per-person figures. Use-case shares are aggregate.
- **C4 — LiteLLM is a hard boundary.** No Exulu reads.
- **G1 — Never sum across tag dimensions.** Totals from `SpendLogs` rows only.
- **G2 — Read-only against LiteLLM.** The classifier's own LLM calls go through the gateway's HTTP API, never through the read-only database connection.
- **G3 — Snapshot immutability.** Classification results are frozen into the snapshot like every other figure.
- **G5 — Evidence-Lock.** Every rendered number through the registry.
- **G8 — Money units.** `spendUsd` at source, `spendReporting` in panels.
- **NEW — The meter must not move the meter.** The classifier's own token spend is tagged distinctly, **excluded from every reported figure**, and **disclosed in the appendix**. A tool that inflates the invoice it exists to explain is self-defeating.
- **NEW — Classify, never estimate.** The panel reports what kind of work happened. It never converts that into hours or money saved. "38% document drafting" is checkable by sampling; "saved 200 hours" is not.

## File Structure

```
src/
├── litellm/
│   ├── types.ts            MODIFY — SessionSample, ToolUseRow, LiteLLMSource additions
│   ├── source-sql.ts       MODIFY — sampleSessions(), toolUseBodies(), spendForTag()
│   └── source-fake.ts      MODIFY — fixture fields
├── usecase/
│   ├── extract.ts          NEW — firstUserMessage(), toolUsesFromBody()
│   ├── taxonomy.ts         NEW — TOP_LEVEL taxonomy + the classifier prompt
│   ├── classify.ts         NEW — classifySessions() over a Classifier seam
│   ├── classifier-llm.ts   NEW — the real gateway-backed Classifier
│   └── spine.ts            NEW — buildToolSpine(): deterministic, no LLM
├── db/schema.ts            MODIFY — session_use_case table
├── metrics/
│   ├── types.ts            MODIFY — UseCasePanel, ToolSpineRow
│   └── usecase.ts          NEW — buildUseCasePanel()
├── snapshot/build.ts       MODIFY — include the panel
├── report/{html,csv}.ts    MODIFY — render it
└── jobs/monthly.ts         MODIFY — run classification before building
```

## Phasing within this plan

Tasks 1–3 deliver the **deterministic spine** — real use-case signal, complete coverage, no
LLM, no prompt content leaving the process, no cost. It is independently shippable and, on
the evidence of the sample, may be most of the value.

Tasks 4–7 add the **classifier**. They depend on the tenant opt-in being switched on.

If only half of this ships, ship the first half.

---

## Task 1: Extract the two signals from a request body

**Files:**
- Create: `src/usecase/extract.ts`
- Test: `tests/usecase/extract.test.ts`, `tests/fixtures/request-body.ts`

**Interfaces:**
- Produces: `firstUserMessage(body: unknown): string | null`, `toolUsesFromBody(body: unknown): {id: string; name: string}[]`

- [ ] **Step 1: Write the fixture**

Create `tests/fixtures/request-body.ts`. These shapes are copied from real production rows;
the text is invented.

```ts
/** Shapes mirror real production bodies. proxy_server_request IS the body — no wrapper. */
export const bodyStringContent = {
  model: "claude-sonnet-4-6",
  messages: [
    { role: "system", content: "you are helpful" },
    { role: "user", content: "Refactor the invoice parser to handle multi-currency" },
    { role: "assistant", content: "Sure." },
  ],
};

export const bodyListContent = {
  model: "vertex-gemini-3.5-flash",
  messages: [
    {
      role: "user",
      content: [
        { type: "text", text: "Summarise this QBR deck" },
        { type: "text", text: " for the Fingerhaus account", cache_control: { type: "ephemeral" } },
      ],
    },
  ],
};

export const bodyWithToolUses = {
  model: "claude-sonnet-4-6",
  messages: [
    { role: "user", content: "fix the failing test" },
    { role: "assistant", content: [
      { type: "text", text: "Looking." },
      { type: "tool_use", id: "tu_1", name: "Read", input: {} },
      { type: "tool_use", id: "tu_2", name: "Edit", input: {} },
    ] },
    { role: "user", content: "carry on" },
    { role: "assistant", content: [
      { type: "tool_use", id: "tu_1", name: "Read", input: {} },   // resent — same id
      { type: "tool_use", id: "tu_3", name: "Bash", input: {} },
    ] },
  ],
};

export const bodyNoUser = { model: "x", messages: [{ role: "system", content: "hi" }] };
```

- [ ] **Step 2: Write the failing test**

Create `tests/usecase/extract.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { firstUserMessage, toolUsesFromBody } from "../../src/usecase/extract";
import {
  bodyStringContent, bodyListContent, bodyWithToolUses, bodyNoUser,
} from "../fixtures/request-body";

describe("firstUserMessage", () => {
  it("reads plain string content", () => {
    expect(firstUserMessage(bodyStringContent))
      .toBe("Refactor the invoice parser to handle multi-currency");
  });

  it("joins the text parts of list content", () => {
    // A third of production rows use this shape. Treating it as a string
    // would silently drop them into `unclassified`.
    expect(firstUserMessage(bodyListContent))
      .toBe("Summarise this QBR deck for the Fingerhaus account");
  });

  it("takes the FIRST user message, not the last", () => {
    // Conversations resend their history; the first user turn is the original intent.
    const body = { messages: [
      { role: "user", content: "original goal" },
      { role: "assistant", content: "ok" },
      { role: "user", content: "and now something else" },
    ] };
    expect(firstUserMessage(body)).toBe("original goal");
  });

  it("returns null when there is no user message", () => {
    expect(firstUserMessage(bodyNoUser)).toBeNull();
  });

  it("returns null for junk rather than throwing", () => {
    expect(firstUserMessage(null)).toBeNull();
    expect(firstUserMessage({})).toBeNull();
    expect(firstUserMessage({ messages: "not an array" })).toBeNull();
  });
});

describe("toolUsesFromBody", () => {
  it("recovers tool uses from assistant turns", () => {
    const out = toolUsesFromBody(bodyWithToolUses);
    expect(out.map((t) => t.name).sort()).toEqual(["Bash", "Edit", "Read"]);
  });

  it("deduplicates by tool_use id within the body", () => {
    // tu_1 appears twice because the conversation was resent. Counting it
    // twice inside one body would already overcount before cross-request dedup.
    const out = toolUsesFromBody(bodyWithToolUses);
    expect(out.filter((t) => t.id === "tu_1")).toHaveLength(1);
    expect(out).toHaveLength(3);
  });

  it("returns an empty array for junk", () => {
    expect(toolUsesFromBody(null)).toEqual([]);
    expect(toolUsesFromBody({ messages: [{ role: "assistant", content: "plain" }] })).toEqual([]);
  });
});
```

- [ ] **Step 3: Run it to confirm it fails**

Run: `pnpm vitest run tests/usecase/extract.test.ts`
Expected: FAIL — cannot find module `../../src/usecase/extract`

- [ ] **Step 4: Implement `src/usecase/extract.ts`**

```ts
/**
 * Parsing helpers for LiteLLM's `proxy_server_request`, whose shape was established by
 * sampling 300 production rows. That column IS the request body — there is no `body`
 * wrapper — and message `content` is a plain string on roughly two thirds of rows and a
 * list of typed parts on the rest.
 *
 * Everything here is defensive: the column is untyped JSON written by a proxy we do not
 * control, so a malformed row must yield null/[] rather than throw and take the job down.
 */

type Part = { type?: unknown; text?: unknown; id?: unknown; name?: unknown };

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : null;
}

function contentToText(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const text = content
      .map((p) => {
        const part = asRecord(p) as Part | null;
        return part && part.type === "text" && typeof part.text === "string" ? part.text : "";
      })
      .join("");
    return text.length > 0 ? text : null;
  }
  return null;
}

/** The original intent of the conversation: its FIRST user turn. */
export function firstUserMessage(body: unknown): string | null {
  const b = asRecord(body);
  if (!b || !Array.isArray(b.messages)) return null;
  for (const m of b.messages) {
    const msg = asRecord(m);
    if (msg && msg.role === "user") {
      const text = contentToText(msg.content);
      if (text !== null) return text;
    }
  }
  return null;
}

/**
 * Tools the model actually CALLED, recovered from assistant turns. Deduplicated by
 * tool_use id: a resent conversation repeats earlier calls verbatim, so the same id can
 * appear several times within one body.
 */
export function toolUsesFromBody(body: unknown): { id: string; name: string }[] {
  const b = asRecord(body);
  if (!b || !Array.isArray(b.messages)) return [];
  const seen = new Set<string>();
  const out: { id: string; name: string }[] = [];
  for (const m of b.messages) {
    const msg = asRecord(m);
    if (!msg || msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
    for (const p of msg.content) {
      const part = asRecord(p) as Part | null;
      if (!part || part.type !== "tool_use") continue;
      if (typeof part.name !== "string" || typeof part.id !== "string") continue;
      if (seen.has(part.id)) continue;
      seen.add(part.id);
      out.push({ id: part.id, name: part.name });
    }
  }
  return out;
}
```

- [ ] **Step 5: Run the tests**

Run: `pnpm vitest run tests/usecase/extract.test.ts`
Expected: 8 passed

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat: extract first user message and tool uses from request bodies"
```

---

> **SUPERSEDED DURING EXECUTION — read this before Task 2.**
>
> Tasks 2 and 3 as written fetch whole request bodies and deduplicate in TypeScript. Task 3
> ran that against real data and it returned **4,000 bodies and zero tool uses**: the
> `ORDER BY "startTime" DESC LIMIT n` takes a contiguous recent slice, and the tool-bearing
> rows sat outside it. Fetching bodies is also the wrong shape — median 10.8 KB across ~22%
> of rows is hundreds of megabytes a month to extract a few thousand short strings.
>
> The shipped design extracts in SQL instead, with `DISTINCT (session_id, use_id)` doing the
> dedup in Postgres and no bodies transferring at all. See `src/litellm/source-sql.ts`
> `toolUseRows()`. Measured on real data: **4,105 naive occurrences collapse to 435 distinct
> calls, 9.4× inflation avoided**, in 968 ms.
>
> `toolUsesFromBody` was removed with the body-fetching path; `firstUserMessage` remains and
> Task 4 still uses it.

## Task 2: The deterministic tool spine

Tools actually called, per month, with no LLM and no prompt content leaving the process.
On the production sample this alone distinguishes code editing (`Read`/`Edit`/`Write`/`Bash`)
from browser/UI work (`mcp__playwright__*`) from design-to-code (`mcp__figma-desktop__*`).

**The overcounting trap:** a conversation resends its history, so a `tool_use` made in turn
one reappears in every later request of that session. Counting across requests without
deduplicating by `tool_use` id inflates the numbers by roughly the conversation length —
which for these agent sessions is large. Dedup is per **session**, not per request.

**Files:**
- Modify: `src/litellm/types.ts`, `src/litellm/source-sql.ts`, `src/litellm/source-fake.ts`
- Create: `src/usecase/spine.ts`
- Modify: `src/metrics/types.ts`
- Test: `tests/usecase/spine.test.ts`, plus an integration test

**Interfaces:**
- Produces: `ToolUseRow` (`{sessionId, requestId, body}`), `LiteLLMSource.toolUseBodies(fromIso, toIso, limit)`, `buildToolSpine(rows): ToolSpineRow[]`, `ToolSpineRow` (`{tool, calls, sessions, sharePct}`)

- [ ] **Step 1: Add the source type and method**

In `src/litellm/types.ts`:

```ts
/** A request body fetched for tool-call recovery. Bodies are large — always bounded. */
export type ToolUseRow = { sessionId: string; requestId: string; body: unknown };
```

and on `LiteLLMSource`:

```ts
  /**
   * Request bodies carrying assistant tool_use parts, for the deterministic spine.
   * Bounded by `limit` because the median body is ~11 KB and the max is ~467 KB.
   */
  toolUseBodies(fromIso: string, toIso: string, limit: number): Promise<ToolUseRow[]>;
```

- [ ] **Step 2: Write the failing spine test**

Create `tests/usecase/spine.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildToolSpine } from "../../src/usecase/spine";

const row = (sessionId: string, requestId: string, uses: [string, string][]) => ({
  sessionId, requestId,
  body: { messages: [{ role: "assistant",
    content: uses.map(([id, name]) => ({ type: "tool_use", id, name })) }] },
});

describe("buildToolSpine", () => {
  it("counts distinct tool_use ids within a session, not repetitions", () => {
    // The same conversation resent twice: r2 repeats tu_1 and adds tu_2.
    const rows = [
      row("s1", "r1", [["tu_1", "Read"]]),
      row("s1", "r2", [["tu_1", "Read"], ["tu_2", "Edit"]]),
    ];
    const spine = buildToolSpine(rows);
    expect(spine.find((t) => t.tool === "Read")!.calls).toBe(1);   // NOT 2
    expect(spine.find((t) => t.tool === "Edit")!.calls).toBe(1);
  });

  it("counts the same tool id in different sessions separately", () => {
    const rows = [row("s1", "r1", [["tu_1", "Read"]]), row("s2", "r1", [["tu_1", "Read"]])];
    expect(buildToolSpine(rows).find((t) => t.tool === "Read")!.calls).toBe(2);
  });

  it("reports how many distinct sessions used each tool", () => {
    const rows = [
      row("s1", "r1", [["a", "Read"], ["b", "Edit"]]),
      row("s2", "r1", [["c", "Read"]]),
    ];
    const spine = buildToolSpine(rows);
    expect(spine.find((t) => t.tool === "Read")!.sessions).toBe(2);
    expect(spine.find((t) => t.tool === "Edit")!.sessions).toBe(1);
  });

  it("computes share of all calls and sorts descending", () => {
    const rows = [row("s1", "r1", [["a", "Read"], ["b", "Read"], ["c", "Edit"]])];
    const spine = buildToolSpine(rows);
    expect(spine[0]!.tool).toBe("Read");
    expect(spine[0]!.sharePct).toBeCloseTo(66.7, 1);
  });

  it("returns an empty array for no rows, with no NaN", () => {
    expect(buildToolSpine([])).toEqual([]);
  });
});
```

- [ ] **Step 3: Run it to confirm it fails**

Run: `pnpm vitest run tests/usecase/spine.test.ts`
Expected: FAIL — cannot find module

- [ ] **Step 4: Add the panel type**

In `src/metrics/types.ts`:

```ts
export type ToolSpineRow = {
  tool: string;
  calls: number;      // distinct tool_use ids, deduplicated within each session
  sessions: number;   // distinct sessions in which the tool was called
  sharePct: number;
};
```

- [ ] **Step 5: Implement `src/usecase/spine.ts`**

```ts
import type { ToolUseRow } from "../litellm/types";
import type { ToolSpineRow } from "../metrics/types";
import { toolUsesFromBody } from "./extract";

/**
 * Tool calls per month, from assistant tool_use parts.
 *
 * Dedup is keyed on session + tool_use id. Agent conversations resend their whole history,
 * so a call made in the first turn reappears in every later request of that session;
 * counting per request would inflate totals by roughly the conversation length. The id is
 * stable across resends, which is what makes the dedup exact rather than heuristic.
 */
export function buildToolSpine(rows: ToolUseRow[]): ToolSpineRow[] {
  const seen = new Set<string>();
  const calls = new Map<string, number>();
  const sessions = new Map<string, Set<string>>();

  for (const r of rows) {
    for (const use of toolUsesFromBody(r.body)) {
      const key = `${r.sessionId}\u0000${use.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      calls.set(use.name, (calls.get(use.name) ?? 0) + 1);
      if (!sessions.has(use.name)) sessions.set(use.name, new Set());
      sessions.get(use.name)!.add(r.sessionId);
    }
  }

  const total = [...calls.values()].reduce((s, n) => s + n, 0);
  return [...calls.entries()]
    .map(([tool, n]) => ({
      tool,
      calls: n,
      sessions: sessions.get(tool)?.size ?? 0,
      sharePct: total > 0 ? (n / total) * 100 : 0,
    }))
    .sort((a, b) => b.calls - a.calls);
}
```

- [ ] **Step 6: Implement the SQL**

In `src/litellm/source-sql.ts`, beside the other methods. Select only the columns needed —
these rows are large:

```ts
    async toolUseBodies(from, to, limit) {
      const { rows } = await pool.query(
        `SELECT session_id, request_id, proxy_server_request
         FROM "LiteLLM_SpendLogs"
         WHERE "startTime" >= $1 AND "startTime" < $2
           AND session_id IS NOT NULL
           AND proxy_server_request::text NOT IN ('{}', 'null', '')
         ORDER BY "startTime" DESC
         LIMIT $3`,
        [from, to, limit],
      );
      return rows.map((r) => ({
        sessionId: r.session_id, requestId: r.request_id, body: r.proxy_server_request,
      })) satisfies ToolUseRow[];
    },
```

Add the fake-source field `toolUseBodies?: ToolUseRow[]` and its stub.

**Note on `ORDER BY "startTime" DESC` with a limit:** this takes the most recent N requests
of the month, not a uniform sample. For tool counting that biases toward the end of the
month. Task 3 addresses coverage disclosure; do not silently present a truncated count as
complete.

- [ ] **Step 7: Run the tests**

Run: `pnpm vitest run tests/usecase && pnpm tsc --noEmit`
Expected: 13 passed, typecheck clean

- [ ] **Step 8: Commit**

```bash
git add -A && git commit -m "feat: deterministic tool spine with per-session tool_use dedup"
```

---

## Task 3: Validate the spine against production before building on it

A checkpoint, not a feature. The spine's whole value is that its numbers are real; this task
proves that against the restored production database before the classifier is layered on.

**Files:**
- Create: `scripts/spine-check.ts`

- [ ] **Step 1: Write the script**

Create `scripts/spine-check.ts`:

```ts
/**
 * Runs the deterministic spine against a real LiteLLM database and prints the result.
 * Usage: LITELLM_DATABASE_URL=... npx tsx scripts/spine-check.ts 2026-07
 */
import { createLiteLLMSource } from "../src/litellm/source-sql";
import { buildToolSpine } from "../src/usecase/spine";

const url = process.env.LITELLM_DATABASE_URL;
const month = process.argv[2];
if (!url || !month) {
  console.error("usage: LITELLM_DATABASE_URL=... npx tsx scripts/spine-check.ts YYYY-MM");
  process.exit(1);
}
const [y, m] = month.split("-").map(Number) as [number, number];
const from = new Date(Date.UTC(y, m - 1, 1)).toISOString();
const to = new Date(Date.UTC(y, m, 1)).toISOString();

const { source, pool } = createLiteLLMSource(url);
const rows = await source.toolUseBodies(from, to, 4000);
const spine = buildToolSpine(rows);
console.log(`bodies fetched: ${rows.length}`);
console.log(`distinct sessions: ${new Set(rows.map((r) => r.sessionId)).size}`);
console.log(`distinct tools: ${spine.length}`);
for (const t of spine.slice(0, 20)) {
  console.log(`  ${t.tool.padEnd(42)} ${String(t.calls).padStart(6)} calls  ` +
              `${String(t.sessions).padStart(4)} sessions  ${t.sharePct.toFixed(1)}%`);
}
await pool.end();
```

- [ ] **Step 2: Run it against the restored production database**

```bash
cd ~/Desktop/Projects/exulu/adoption-and-value-tracker
LITELLM_DATABASE_URL=postgres://probe:probe@localhost:55441/litellm \
  npx tsx scripts/spine-check.ts 2026-07
```

- [ ] **Step 3: Sanity-check the output before proceeding**

The numbers must be plausible. Specifically:
- Tool names should be recognisable (`Read`, `Edit`, `Bash`, `mcp__playwright__*`, `mcp__figma-desktop__*`).
- `calls` should exceed `sessions` for common tools but not absurdly — a tool with 500 calls across 3 sessions suggests the dedup is not working.
- Compare the ratio against the 300-row sample, where 20 distinct tools were seen.

If the counts look inflated, the dedup key is wrong. **Stop and fix it before Task 4** —
every downstream figure inherits this.

- [ ] **Step 4: Commit the script**

```bash
git add -A && git commit -m "chore: spine validation script for real data"
```

---

## Task 4: Storage and sampling for classification

**Files:**
- Modify: `src/db/schema.ts`, `src/config.ts`, `.env.example`
- Modify: `src/litellm/types.ts`, `src/litellm/source-sql.ts`, `src/litellm/source-fake.ts`
- Test: `tests/db/schema.test.ts` (extend), `tests/litellm/source-sql.integration.test.ts` (extend)

**Interfaces:**
- Produces: `sessionUseCase` table; config keys `USE_CASE_CLASSIFICATION_ENABLED`, `USE_CASE_SAMPLE_SIZE`, `USE_CASE_MODEL`; `SessionSample` (`{sessionId, firstMessage, month}`); `LiteLLMSource.sampleSessions(fromIso, toIso, limit)`

### Why results are stored rather than recomputed

Classification costs tokens and is non-deterministic. Storing the label per session means a
re-run of a month reuses existing labels instead of paying again and possibly disagreeing
with the report already sent. It also makes the sample auditable: an admin can read what was
classified and check it, which is the property that makes the panel defensible at all.

- [ ] **Step 1: Add the table**

In `src/db/schema.ts`:

```ts
/**
 * One row per classified session. Stored, not recomputed: classification costs tokens and
 * is non-deterministic, so a re-run must reuse the label the report was built from.
 * `label` is null when confidence fell below the threshold — an honest "unclassified"
 * rather than a forced guess.
 */
export const sessionUseCase = pgTable("session_use_case", {
  sessionId: text("session_id").primaryKey(),
  month: text("month").notNull(),
  label: text("label"),
  subLabel: text("sub_label"),
  confidence: doublePrecision("confidence"),
  model: text("model").notNull(),
  classifiedAt: timestamp("classified_at", { withTimezone: true }).notNull().defaultNow(),
});
```

Import `doublePrecision` from `drizzle-orm/pg-core`. Generate the migration with
`OWN_DATABASE_URL=postgres://localhost/x pnpm drizzle-kit generate`.

- [ ] **Step 2: Extend the schema test**

Add to `tests/db/schema.test.ts`, following the existing complete-column-set pattern:

```ts
it("session_use_case has exactly its seven columns", () => {
  expect(Object.keys(getTableColumns(sessionUseCase)).sort()).toEqual(
    ["classifiedAt", "confidence", "label", "month", "model", "sessionId", "subLabel"].sort(),
  );
});

it("keys by session so a session is classified at most once", () => {
  expect(sessionUseCase.sessionId.primary).toBe(true);
});
```

- [ ] **Step 3: Add the config keys**

In `src/config.ts`, add to the `Env` schema:

```ts
  USE_CASE_CLASSIFICATION_ENABLED: z.coerce.boolean().default(false),
  USE_CASE_SAMPLE_SIZE: z.coerce.number().int().positive().default(200),
  USE_CASE_MODEL: z.string().min(1).default("vertex_ai/gemini-3.5-flash"),
  LITELLM_GATEWAY_URL: z.string().min(1).optional(),
  LITELLM_GATEWAY_TOKEN: z.string().min(1).optional(),
```

and to `AppConfig`:

```ts
  useCase: {
    enabled: boolean; sampleSize: number; model: string;
    gatewayUrl?: string; gatewayToken?: string;
  };
```

**Default `false`.** This is the tenant opt-in — the feature reads customer prompts, so it
must be switched on deliberately, never by upgrading. Add a test that it defaults off.

Add all five keys to `.env.example` with a comment on the enabled flag stating that it
enables reading prompt text.

- [ ] **Step 4: Add the sampling query**

In `src/litellm/types.ts`:

```ts
/** One session's opening user message, the classifier's only input. */
export type SessionSample = { sessionId: string; firstMessage: string };
```

and on `LiteLLMSource`:

```ts
  /** One request per session — the earliest — for classification. */
  sampleSessions(fromIso: string, toIso: string, limit: number): Promise<SessionSample[]>;
```

In `src/litellm/source-sql.ts`. Taking the EARLIEST request per session matters: the first
request carries the original intent before the conversation accumulated history, and it is
also the smallest body.

```ts
    async sampleSessions(from, to, limit) {
      const { rows } = await pool.query(
        `SELECT DISTINCT ON (session_id) session_id, proxy_server_request
         FROM "LiteLLM_SpendLogs"
         WHERE "startTime" >= $1 AND "startTime" < $2
           AND session_id IS NOT NULL
           AND proxy_server_request::text NOT IN ('{}', 'null', '')
         ORDER BY session_id, "startTime" ASC
         LIMIT $3`,
        [from, to, limit],
      );
      const out: SessionSample[] = [];
      for (const r of rows) {
        const msg = firstUserMessage(r.proxy_server_request);
        if (msg) out.push({ sessionId: r.session_id, firstMessage: msg });
      }
      return out;
    },
```

Import `firstUserMessage` from `../usecase/extract`. Add the fake-source field.

- [ ] **Step 5: Add an integration test**

Extend the seed in `tests/fixtures/seed-litellm.sql` so two rows share a `session_id` with
different `startTime` values and non-empty `proxy_server_request`, then assert
`sampleSessions` returns ONE row for that session and that it is the earlier request's
message. That is the property `DISTINCT ON` is there to provide.

- [ ] **Step 6: Run tests and migration, then commit**

```bash
pnpm vitest run && pnpm tsc --noEmit
git add -A && git commit -m "feat: session_use_case storage, opt-in config and session sampling"
```

---

## Task 5: The taxonomy and the classifier

**Files:**
- Create: `src/usecase/taxonomy.ts`, `src/usecase/classify.ts`, `src/usecase/classifier-llm.ts`
- Test: `tests/usecase/classify.test.ts`

**Interfaces:**
- Produces: `TOP_LEVEL` (readonly tuple), `TopLevel` type, `buildPrompt(message: string): string`, `Classifier` interface, `classifySessions(samples, classifier, opts): Promise<ClassifiedSession[]>`, `createLlmClassifier(cfg): Classifier`

### Design notes that are not negotiable

**A fixed top level with emergent sub-labels.** Purely emergent categories drift month to
month and destroy trending, which is the whole point of a monthly report. A fixed top level
keeps the trend comparable; the free-text sub-label keeps it honest about what OPEN actually
does.

**Confidence threshold with an honest bucket.** Below the threshold the label is `null` and
the panel reports it as `unclassified`. A forced guess is worse than an admitted gap — the
report's credibility is the product.

**The classifier is a seam.** `classifySessions` takes a `Classifier`, so every test runs
with a deterministic fake and no network. Only `createLlmClassifier` touches the gateway.

**The meter must not move the meter.** `createLlmClassifier` tags its own calls
`value_ledger_internal_classification`. Task 6 excludes that tag from every reported figure
and discloses the cost separately.

- [ ] **Step 1: Write the taxonomy**

Create `src/usecase/taxonomy.ts`:

```ts
/**
 * Fixed top level so month-over-month trends stay comparable; the free-text sub-label
 * carries the specificity. Derived from what the production sample actually contains:
 * coding agents, browser/UI automation, design-to-code, document and analysis work.
 */
export const TOP_LEVEL = [
  "code_change",        // writing, refactoring, fixing code
  "code_understanding", // reading, explaining, reviewing, debugging without editing
  "ui_automation",      // driving a browser, testing, screenshots
  "design_to_code",     // working from designs or design tools
  "data_lookup",        // querying systems of record, retrieving facts
  "document_drafting",  // producing prose: offers, reports, summaries, emails
  "analysis",           // evaluating, comparing, scoring, researching
  "ops",                // deployment, infrastructure, configuration, scheduling
  "other",
] as const;

export type TopLevel = (typeof TOP_LEVEL)[number];

export function buildPrompt(message: string): string {
  return [
    "Classify the INTENT of the following opening message from a work session.",
    "",
    `Choose exactly one category from: ${TOP_LEVEL.join(", ")}.`,
    "Also give a short free-text sub_label (2-4 words) describing the specific task,",
    "and a confidence between 0 and 1.",
    "",
    "Judge only what the person asked for. Do not speculate about outcomes, value, or",
    "time saved. If the message is too short or ambiguous to classify, use \"other\" with",
    "low confidence rather than guessing.",
    "",
    'Reply with JSON only: {"label": "...", "sub_label": "...", "confidence": 0.0}',
    "",
    "MESSAGE:",
    message.slice(0, 4000),
  ].join("\n");
}
```

Truncating at 4,000 characters is deliberate: the sampled median is 1,697, so this keeps
essentially all real messages whole while bounding a pathological one.

- [ ] **Step 2: Write the failing test**

Create `tests/usecase/classify.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { classifySessions } from "../../src/usecase/classify";
import { TOP_LEVEL, buildPrompt } from "../../src/usecase/taxonomy";
import type { Classifier } from "../../src/usecase/classify";

const samples = [
  { sessionId: "s1", firstMessage: "Refactor the invoice parser" },
  { sessionId: "s2", firstMessage: "ok" },
];

const fake = (out: Record<string, { label: string; subLabel: string; confidence: number }>): Classifier => ({
  classify: vi.fn(async (msg: string) => out[msg] ?? null),
});

describe("classifySessions", () => {
  it("labels a confident classification", async () => {
    const c = fake({ "Refactor the invoice parser": { label: "code_change", subLabel: "refactor parser", confidence: 0.9 } });
    const out = await classifySessions([samples[0]!], c, { minConfidence: 0.6, model: "m" });
    expect(out[0]).toMatchObject({ sessionId: "s1", label: "code_change", subLabel: "refactor parser" });
  });

  it("stores null label below the confidence threshold", async () => {
    // An admitted gap beats a forced guess — the panel reports these as unclassified.
    const c = fake({ ok: { label: "other", subLabel: "unclear", confidence: 0.2 } });
    const out = await classifySessions([samples[1]!], c, { minConfidence: 0.6, model: "m" });
    expect(out[0]!.label).toBeNull();
    expect(out[0]!.confidence).toBeCloseTo(0.2, 6);
  });

  it("stores null when the classifier returns nothing", async () => {
    const out = await classifySessions([samples[0]!], fake({}), { minConfidence: 0.6, model: "m" });
    expect(out[0]!.label).toBeNull();
  });

  it("rejects a label outside the taxonomy rather than inventing a category", async () => {
    const c = fake({ "Refactor the invoice parser": { label: "wizardry", subLabel: "x", confidence: 0.99 } });
    const out = await classifySessions([samples[0]!], c, { minConfidence: 0.6, model: "m" });
    expect(out[0]!.label).toBeNull();
  });

  it("continues past a classifier error instead of failing the run", async () => {
    const c: Classifier = { classify: vi.fn()
      .mockRejectedValueOnce(new Error("gateway down"))
      .mockResolvedValueOnce({ label: "ops", subLabel: "deploy", confidence: 0.8 }) };
    const out = await classifySessions(samples, c, { minConfidence: 0.6, model: "m" });
    expect(out).toHaveLength(2);
    expect(out[0]!.label).toBeNull();
    expect(out[1]!.label).toBe("ops");
  });

  it("records the model used, for auditability", async () => {
    const c = fake({ "Refactor the invoice parser": { label: "code_change", subLabel: "x", confidence: 0.9 } });
    const out = await classifySessions([samples[0]!], c, { minConfidence: 0.6, model: "gemini-3.5-flash" });
    expect(out[0]!.model).toBe("gemini-3.5-flash");
  });
});

describe("buildPrompt", () => {
  it("lists every taxonomy category", () => {
    const p = buildPrompt("hello");
    for (const t of TOP_LEVEL) expect(p).toContain(t);
  });

  it("forbids speculating about value or time saved", () => {
    expect(buildPrompt("hello")).toMatch(/Do not speculate about outcomes, value, or/);
  });

  it("truncates a pathological message", () => {
    expect(buildPrompt("x".repeat(10_000)).length).toBeLessThan(5_000);
  });
});
```

- [ ] **Step 3: Run it to confirm it fails**

Run: `pnpm vitest run tests/usecase/classify.test.ts`
Expected: FAIL — cannot find module

- [ ] **Step 4: Implement `src/usecase/classify.ts`**

```ts
import type { SessionSample } from "../litellm/types";
import { TOP_LEVEL, type TopLevel } from "./taxonomy";

export type ClassifierResult = { label: string; subLabel: string; confidence: number };

/** The seam. Tests use a deterministic fake; only createLlmClassifier touches a network. */
export type Classifier = { classify(message: string): Promise<ClassifierResult | null> };

export type ClassifiedSession = {
  sessionId: string;
  label: TopLevel | null;
  subLabel: string | null;
  confidence: number | null;
  model: string;
};

export type ClassifyOptions = { minConfidence: number; model: string };

const isTopLevel = (s: string): s is TopLevel =>
  (TOP_LEVEL as readonly string[]).includes(s);

/**
 * Classifies sequentially. Deliberately not parallel: this runs once a month over a
 * few hundred short messages, and a burst of concurrent calls against the customer's own
 * gateway could trip their rate limits or budgets — the report must not disrupt the
 * platform it reports on.
 */
export async function classifySessions(
  samples: SessionSample[], classifier: Classifier, opts: ClassifyOptions,
): Promise<ClassifiedSession[]> {
  const out: ClassifiedSession[] = [];
  for (const s of samples) {
    let r: ClassifierResult | null = null;
    try {
      r = await classifier.classify(s.firstMessage);
    } catch (err) {
      console.warn(`[use-case] classify failed for session ${s.sessionId}:`, err);
    }
    const ok = r !== null && isTopLevel(r.label) && r.confidence >= opts.minConfidence;
    out.push({
      sessionId: s.sessionId,
      label: ok ? (r!.label as TopLevel) : null,
      subLabel: ok ? r!.subLabel : null,
      confidence: r?.confidence ?? null,
      model: opts.model,
    });
  }
  return out;
}
```

- [ ] **Step 5: Implement `src/usecase/classifier-llm.ts`**

```ts
import type { AppConfig } from "../config";
import type { Classifier, ClassifierResult } from "./classify";
import { buildPrompt } from "./taxonomy";

/** Tag used so the classifier's own spend can be excluded from every reported figure. */
export const CLASSIFIER_TAG = "value_ledger_internal_classification";

/**
 * Routes classification through the customer's own LiteLLM gateway.
 *
 * Two deliberate properties. The calls carry CLASSIFIER_TAG so Task 6 can exclude them from
 * the report and disclose their cost separately — a tool that inflates the invoice it
 * exists to explain is self-defeating. And nothing new sees the prompts: they already
 * traverse this exact gateway, which is what the platform is.
 */
export function createLlmClassifier(cfg: AppConfig): Classifier {
  const url = cfg.useCase.gatewayUrl;
  const token = cfg.useCase.gatewayToken;
  if (!url || !token) {
    throw new Error(
      "Use-case classification is enabled but LITELLM_GATEWAY_URL / LITELLM_GATEWAY_TOKEN are not set.",
    );
  }
  return {
    async classify(message: string): Promise<ClassifierResult | null> {
      const res = await fetch(`${url.replace(/\/$/, "")}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
          "x-litellm-tags": CLASSIFIER_TAG,
        },
        body: JSON.stringify({
          model: cfg.useCase.model,
          messages: [{ role: "user", content: buildPrompt(message) }],
          temperature: 0,
          max_tokens: 200,
        }),
      });
      if (!res.ok) throw new Error(`classifier HTTP ${res.status}`);
      const json = (await res.json()) as {
        choices?: { message?: { content?: string } }[];
      };
      const text = json.choices?.[0]?.message?.content;
      if (typeof text !== "string") return null;
      const match = text.match(/\{[\s\S]*\}/);
      if (!match) return null;
      const parsed = JSON.parse(match[0]) as Record<string, unknown>;
      if (typeof parsed.label !== "string" || typeof parsed.confidence !== "number") return null;
      return {
        label: parsed.label,
        subLabel: typeof parsed.sub_label === "string" ? parsed.sub_label : "",
        confidence: parsed.confidence,
      };
    },
  };
}
```

- [ ] **Step 6: Run the tests and commit**

```bash
pnpm vitest run tests/usecase && pnpm tsc --noEmit
git add -A && git commit -m "feat: use-case taxonomy and gateway-backed classifier behind a seam"
```

---

## Task 6: The panel, and excluding the classifier's own spend

**Files:**
- Create: `src/metrics/usecase.ts`
- Modify: `src/metrics/types.ts`, `src/snapshot/build.ts`, `src/jobs/monthly.ts`
- Modify: `src/litellm/source-sql.ts` (exclusion + classifier cost)
- Test: `tests/metrics/usecase.test.ts`

**Interfaces:**
- Produces: `UseCasePanel`, `buildUseCasePanel(classified, spine, opts)`, `LiteLLMSource.spendForTag(fromIso, toIso, tag)`

- [ ] **Step 1: Add the panel type**

In `src/metrics/types.ts`:

```ts
export type UseCaseShare = {
  label: string;          // a TopLevel value, or "unclassified"
  sessions: number;
  sharePct: number;
  exampleSubLabels: string[];   // up to 3, for texture
};

export type UseCasePanel = {
  enabled: boolean;
  sampledSessions: number;
  totalSessions: number;
  classifiedSessions: number;
  unclassifiedSessions: number;
  shares: UseCaseShare[];
  toolSpine: ToolSpineRow[];
  /** The classifier's own cost. Excluded from every other figure, disclosed here. */
  classifierSpendReporting: number;
};
```

and `useCase: UseCasePanel;` on `Snapshot`.

- [ ] **Step 2: Write the failing test**

Create `tests/metrics/usecase.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildUseCasePanel } from "../../src/metrics/usecase";

const classified = [
  { sessionId: "a", label: "code_change" as const, subLabel: "refactor parser", confidence: 0.9, model: "m" },
  { sessionId: "b", label: "code_change" as const, subLabel: "fix test", confidence: 0.8, model: "m" },
  { sessionId: "c", label: "analysis" as const, subLabel: "compare vendors", confidence: 0.7, model: "m" },
  { sessionId: "d", label: null, subLabel: null, confidence: 0.3, model: "m" },
];

const opts = { totalSessions: 100, classifierSpendUsd: 0.42, fxRateUsdToReporting: 0.5, enabled: true };

describe("buildUseCasePanel", () => {
  // Denominator is classified.length (all sampled sessions, including unclassified) so
  // all shares sum to 100%. With 4 sessions: code_change=2→50%, analysis=1→25%,
  // unclassified=1→25%. Using labelled.length (3) as the denominator would give 66.7%
  // for code_change and overstate every category by silently excluding unclassified sessions.
  it("computes shares over all sampled sessions so the sum is 100%", () => {
    const p = buildUseCasePanel(classified, [], opts);
    expect(p.shares.find((s) => s.label === "code_change")!.sharePct).toBeCloseTo(50, 1);
    expect(p.shares.find((s) => s.label === "analysis")!.sharePct).toBeCloseTo(25, 1);
  });

  it("all shares sum to 100% when there is at least one classified session", () => {
    const p = buildUseCasePanel(classified, [], opts);
    const total = p.shares.reduce((acc, s) => acc + s.sharePct, 0);
    expect(total).toBeCloseTo(100, 5);
  });

  it("reports unclassified as its own honest bucket, not dropped", () => {
    const p = buildUseCasePanel(classified, [], opts);
    expect(p.unclassifiedSessions).toBe(1);
    expect(p.shares.some((s) => s.label === "unclassified")).toBe(true);
  });

  it("discloses sample coverage against the true session count", () => {
    const p = buildUseCasePanel(classified, [], opts);
    expect(p.sampledSessions).toBe(4);
    expect(p.totalSessions).toBe(100);
  });

  it("converts the classifier's own spend and keeps it separate", () => {
    const p = buildUseCasePanel(classified, [], opts);
    expect(p.classifierSpendReporting).toBeCloseTo(0.21, 6);
  });

  it("carries up to three example sub-labels per category", () => {
    const p = buildUseCasePanel(classified, [], opts);
    const cc = p.shares.find((s) => s.label === "code_change")!;
    expect(cc.exampleSubLabels).toContain("refactor parser");
    expect(cc.exampleSubLabels.length).toBeLessThanOrEqual(3);
  });

  it("returns a disabled, empty panel without dividing by zero", () => {
    const p = buildUseCasePanel([], [], { ...opts, enabled: false, totalSessions: 0 });
    expect(p.enabled).toBe(false);
    expect(p.shares).toEqual([]);
    expect(p.sampledSessions).toBe(0);
  });
});
```

- [ ] **Step 3: Implement `src/metrics/usecase.ts`**

```ts
import type { ClassifiedSession } from "../usecase/classify";
import type { ToolSpineRow, UseCasePanel, UseCaseShare } from "./types";

export type UseCaseOptions = {
  totalSessions: number;
  classifierSpendUsd: number;
  fxRateUsdToReporting: number;
  enabled: boolean;
};

export function buildUseCasePanel(
  classified: ClassifiedSession[], toolSpine: ToolSpineRow[], opts: UseCaseOptions,
): UseCasePanel {
  const labelled = classified.filter((c) => c.label !== null);
  const unclassified = classified.length - labelled.length;

  const byLabel = new Map<string, { n: number; subs: string[] }>();
  for (const c of labelled) {
    const key = c.label as string;
    if (!byLabel.has(key)) byLabel.set(key, { n: 0, subs: [] });
    const e = byLabel.get(key)!;
    e.n++;
    if (c.subLabel && e.subs.length < 3 && !e.subs.includes(c.subLabel)) e.subs.push(c.subLabel);
  }

  const denom = classified.length;
  const shares: UseCaseShare[] = [...byLabel.entries()]
    .map(([label, e]) => ({
      label, sessions: e.n,
      sharePct: denom > 0 ? (e.n / denom) * 100 : 0,
      exampleSubLabels: e.subs,
    }))
    .sort((a, b) => b.sessions - a.sessions);

  if (unclassified > 0) {
    shares.push({
      label: "unclassified", sessions: unclassified,
      sharePct: denom > 0 ? (unclassified / denom) * 100 : 0,
      exampleSubLabels: [],
    });
  }

  return {
    enabled: opts.enabled,
    sampledSessions: classified.length,
    totalSessions: opts.totalSessions,
    classifiedSessions: labelled.length,
    unclassifiedSessions: unclassified,
    shares: opts.enabled ? shares : [],
    toolSpine,
    classifierSpendReporting: opts.classifierSpendUsd * opts.fxRateUsdToReporting,
  };
}
```

- [ ] **Step 4: Exclude the classifier's spend from every reported figure**

This is the load-bearing part of "the meter must not move the meter".

In `src/litellm/source-sql.ts`, add:

```ts
    async spendForTag(from, to, tag) {
      const { rows } = await pool.query(
        `SELECT COALESCE(SUM(s.spend),0) AS spend
         FROM "LiteLLM_SpendLogs" s
         WHERE s."startTime" >= $1 AND s."startTime" < $2
           AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(s.request_tags::jsonb) t
                       WHERE t = $3)`,
        [from, to, tag],
      );
      return num(rows[0].spend);
    },
```

and add a `NOT EXISTS` clause excluding `CLASSIFIER_TAG` to **`monthTotals`, `dailyByTagPrefix`,
`spendWithTagPrefix`, `modelSpend`, `clientTools`, `projects`, `userTeams`, `humanUserDays`
and `humanUserMonths`.** Every one — a single omission means the classifier's spend leaks
into one panel and the figures stop reconciling with each other.

Add an integration test: seed one row tagged `value_ledger_internal_classification` and
assert it is absent from `monthTotals` but present in `spendForTag`.

- [ ] **Step 5: Wire into the job and the snapshot**

`buildSnapshot` gains the panel. In `runMonthlyJob`, between the guard and the build:
if `cfg.useCase.enabled`, sample sessions, load any already-stored labels for the month,
classify only the ones not yet stored, persist them, then read the month's labels back.
When disabled, pass an empty classified list and `enabled: false`.

The ordering rule is unchanged: `assertMonthComplete` still runs first.

- [ ] **Step 6: Run tests, migration, commit**

```bash
pnpm vitest run && pnpm tsc --noEmit
git add -A && git commit -m "feat: use-case panel with classifier spend excluded and disclosed"
```

---

## Task 7: Render it

**Files:**
- Modify: `src/report/html.ts`, `src/report/csv.ts`, `tests/fixtures/snapshot.ts`
- Test: `tests/report/html.test.ts`, `tests/report/csv.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `tests/report/html.test.ts`:

```ts
describe("renderHtml — use cases", () => {
  it("renders the tool spine even when classification is off", () => {
    const s = makeSnapshotFixture();
    s.useCase = { enabled: false, sampledSessions: 0, totalSessions: 300,
      classifiedSessions: 0, unclassifiedSessions: 0, shares: [],
      toolSpine: [{ tool: "Read", calls: 1007, sessions: 40, sharePct: 32.1 }],
      classifierSpendReporting: 0 };
    const t = visibleText(renderHtml(s));
    expect(t).toContain("Read");
    expect(t).toContain("1,007");
  });

  it("discloses the sample size against the true session count", () => {
    const t = visibleText(renderHtml(makeSnapshotFixture()));
    expect(t).toMatch(/200 of 300 sessions|sampled/i);
  });

  it("shows the unclassified bucket rather than hiding it", () => {
    const t = visibleText(renderHtml(makeSnapshotFixture()));
    expect(t).toContain("unclassified");
  });

  it("discloses the classifier's own cost in the appendix", () => {
    const t = visibleText(renderHtml(makeSnapshotFixture()));
    expect(t).toMatch(/classif\w+ .*cost|cost of classif/i);
  });

  it("still passes Evidence-Lock with the new panel", () => {
    expect(() => renderHtml(makeSnapshotFixture())).not.toThrow();
  });
});
```

Update `makeSnapshotFixture` to include a populated `useCase` panel with
`sampledSessions: 200`, `totalSessions: 300`, two shares plus an `unclassified` share, a
two-row `toolSpine`, and `classifierSpendReporting: 0.21`.

- [ ] **Step 2: Render the section**

Between "Where it went — by project" and "Reliability", add a "What it was used for"
section:

- **The tool spine as bars** — `barRow` per tool, label through `re()`, value
  `${n.int(t.calls)} calls · ${n.pct(t.sharePct)}%`. Render this whenever the spine is
  non-empty, regardless of `enabled` — it needs no classification.
- **Use-case shares as bars** when `enabled`, including the `unclassified` row.
- **A coverage line**: `Sampled ${n.int(sampledSessions)} of ${n.int(totalSessions)} sessions.`
- **When `enabled` is false**, a single muted line stating that intent classification is off
  and that the tool usage above is derived without reading any prompt text. Do not silently
  omit the section — its absence would read as no data rather than a switched-off feature.
- **In the appendix**, one sentence disclosing the classifier's own spend and stating it is
  excluded from every figure in the report.

Every visible number through the registry; every label through `re()`.

- [ ] **Step 3: Add CSV rows**

```ts
  for (const s of s.useCase.shares) {
    rows.push(["usecase", "sessions", s.label, s.sessions]);
    rows.push(["usecase", "share_pct", s.label, s.sharePct]);
  }
  for (const t of s.useCase.toolSpine) {
    rows.push(["toolspine", "calls", t.tool, t.calls]);
    rows.push(["toolspine", "sessions", t.tool, t.sessions]);
  }
  rows.push(["usecase", "sampled_sessions", "", s.useCase.sampledSessions]);
  rows.push(["usecase", "total_sessions", "", s.useCase.totalSessions]);
  rows.push(["usecase", "classifier_spend_reporting", "", s.useCase.classifierSpendReporting]);
```

- [ ] **Step 4: Render against production and read it**

With classification disabled first — the spine alone should already be informative. Then
with it enabled against the restore, and check that a handful of labels are plausible by
reading them next to their sessions. If the labels look wrong, the taxonomy or the prompt is
wrong; fix that rather than lowering the confidence threshold.

- [ ] **Step 5: Run everything and commit**

```bash
pnpm vitest run && pnpm tsc --noEmit
git add -A && git commit -m "feat: render use-case shares and tool spine"
```

---

## Self-review notes

**Driver coverage.** "LLM-based use case categorisation (analysis of prompts / inputs /
outputs)" → Tasks 4–7. The deterministic half Daniel deprioritised is Tasks 1–3, included
because the production sample showed it is stronger than expected and it needs no prompt
access at all.

**Constraint coverage.** C1: no user is ever asked; the opt-in is tenant config defaulting
off. C2/G4: shares are aggregate; no session is attributed to a person. G2: the classifier
uses the gateway's HTTP API, never the read-only DB connection. G5: Task 7 routes every
number through the registry. The new "meter must not move the meter" constraint is
implemented in Task 6 Step 4 and disclosed in Task 7.

**Known risk carried deliberately.** `toolUseBodies` and `sampleSessions` are both bounded
by a limit and ordered, so neither is a uniform random sample. Task 7 discloses the sample
size against the true session count rather than implying completeness. Making the sample
uniform would need `TABLESAMPLE` or a random sort over a large table; that is a refinement,
not a blocker, and the disclosure is what keeps it honest meanwhile.

**Deliberately not included.** Any conversion of use-case shares into hours or money saved.
That is the line the whole design refuses to cross.
