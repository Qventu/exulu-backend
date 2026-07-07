# Context-Window Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make it impossible for a chat session to hit the model's max context length: cap + offload oversized tool outputs, gate every request against a token budget, let the user compact the conversation (steerable) via a checkpoint message, and show an accurate context meter with warn/block states.

**Architecture:** Backend gets a single thresholds module (`context-budget.ts`) feeding four layers: (1) a universal tool-output guard in the tool-conversion layer that offloads oversized outputs to session files with a pointer + a new `read_session_file` tool, (2) a pre-flight budget gate inside `generateStream`/`generateSync` that refuses to call the model past 95% of the usable window, (3) an in-flight `prepareStep` guard that collapses older tool results mid-response, and (4) a compact endpoint that summarizes older history into a checkpoint message row. The frontend mirrors the threshold math, replaces the cumulative-sum meter with real occupancy, and adds a warn banner / blocked composer / compaction divider.

**Tech Stack:** Backend: TypeScript, Express, Vercel AI SDK v6 (`ai`), Knex/Postgres, Jest (ts-jest). Frontend: Next.js App Router, AI SDK `useChat`, Apollo, next-intl, Vitest.

**Spec:** `docs/superpowers/specs/2026-07-07-context-window-management-design.md`

## Global Constraints

- Backend repo: `/Users/daniel.claessen/Desktop/Projects/exulu/backend` (Node v22.18.0, tests: `npm test` = jest, co-located `*.test.ts`). Frontend repo: `/Users/daniel.claessen/Desktop/Projects/exulu/frontend` (tests: `npm test` = vitest run). Work on branch `feature/context-window-management` in BOTH repos (created in Task 1 / Task 13).
- **No new Postgres columns, no migrations.** Checkpoints are ordinary `agent_messages` rows; all new state lives inside the serialized UIMessage `metadata` JSON.
- **Thresholds have exactly one backend source of truth** (`src/exulu/context-budget.ts`) and one frontend mirror (`app/(application)/chat/lib/context-budget.ts`). Formulas (from the spec): `outputReserve = min(32000, 0.2×window)`, `usableWindow = window − outputReserve`, `warnThreshold = 0.80×usableWindow`, `blockThreshold = 0.95×usableWindow`, `toolOutputCapTokens = min(25000, max(4000, 0.1×window))`, `compactionTailTokens = 0.10×usableWindow`, `summaryBudgetTokens = min(8000, 0.05×usableWindow)`. Default window when unknown: `128_000`.
- **Token estimation is `Math.ceil(chars / 4)` everywhere** — deterministic, synchronous, no network. (The spec mentions tiktoken with a chars/4 fallback, but it also requires "never calls a network endpoint", and the repo's `ExuluTokenizer` uses `tiktoken/lite` + `load()` which downloads BPE data over HTTP. chars/4 honors the hard constraint; real per-turn usage metadata anchors the numbers each turn, so estimator drift self-corrects.)
- Error codes are the string literals `"CONTEXT_COMPACTION_REQUIRED"` and `"COMPACTION_INSUFFICIENT"`, always embedded in a JSON error body so the frontend can match with `message.includes(code)`.
- **No violet/purple accents** in new UI (user design rule). Use the existing `warning` tokens for banner/chip states.
- New user-facing strings in `app/(application)/chat/**` go through next-intl (`messages/en.json` AND `messages/de.json`, `chat.*` namespace; run `npm run check-messages` after editing). `components/message-renderer.tsx` uses hardcoded English by existing convention — keep that convention for the divider.
- Commit after every task, in the repo the task touched. Backend commit prefix `feat(context):`, frontend `feat(chat):`.

---

## Backend

### Task 1: `context-budget.ts` — thresholds, estimation, occupancy, checkpoint helpers, error types

**Files:**
- Create: `src/exulu/context-budget.ts`
- Test: `src/exulu/context-budget.test.ts`

**Interfaces:**
- Consumes: `UIMessage` type from `ai`.
- Produces (used by nearly every later task):
  - `DEFAULT_CONTEXT_WINDOW: number` (= 128_000)
  - `type ContextBudget = { contextWindow: number; outputReserve: number; usableWindow: number; warnThreshold: number; blockThreshold: number; toolOutputCapTokens: number; compactionTailTokens: number; summaryBudgetTokens: number }`
  - `deriveContextBudget(contextWindow?: number | null): ContextBudget`
  - `estimateTokens(text: string): number` (sync, chars/4)
  - `estimateMessageTokens(message: UIMessage): number`
  - `type CompactionMetadata = { coversUpTo: string; originalTokens: number; summaryTokens: number; occupancyEstimate: number; steer?: string }`
  - `getCompaction(message: UIMessage): CompactionMetadata | undefined`
  - `sliceHistoryAtCheckpoint(messages: UIMessage[]): UIMessage[]` (model-view assembly; input is CHRONOLOGICAL order)
  - `contextOccupancy(messages: UIMessage[]): number` (input is CHRONOLOGICAL order)
  - `CONTEXT_COMPACTION_REQUIRED = "CONTEXT_COMPACTION_REQUIRED"`, `COMPACTION_INSUFFICIENT = "COMPACTION_INSUFFICIENT"`
  - `class ContextCompactionRequiredError extends Error` (its `.message` IS a JSON string carrying the code)
  - `isProviderContextLengthError(message: string): boolean`
  - `mapStreamErrorMessage(message: string): string`

- [ ] **Step 1: Create the branch**

```bash
cd /Users/daniel.claessen/Desktop/Projects/exulu/backend
git checkout develop && git pull && git checkout -b feature/context-window-management
```

- [ ] **Step 2: Write the failing test**

Create `src/exulu/context-budget.test.ts`:

```ts
import type { UIMessage } from "ai";
import {
  deriveContextBudget,
  estimateTokens,
  contextOccupancy,
  sliceHistoryAtCheckpoint,
  getCompaction,
  ContextCompactionRequiredError,
  isProviderContextLengthError,
  mapStreamErrorMessage,
  CONTEXT_COMPACTION_REQUIRED,
  DEFAULT_CONTEXT_WINDOW,
} from "./context-budget";

const text = (role: "user" | "assistant", body: string, metadata?: object): UIMessage =>
  ({ id: `m_${Math.random().toString(36).slice(2)}`, role, parts: [{ type: "text", text: body }], ...(metadata ? { metadata } : {}) }) as UIMessage;

describe("deriveContextBudget", () => {
  it("derives the spec formulas for a 200K window", () => {
    const b = deriveContextBudget(200_000);
    expect(b.outputReserve).toBe(32_000); // min(32000, 40000)
    expect(b.usableWindow).toBe(168_000);
    expect(b.warnThreshold).toBe(134_400); // 0.8 × usable
    expect(b.blockThreshold).toBe(159_600); // 0.95 × usable
    expect(b.toolOutputCapTokens).toBe(20_000); // min(25000, max(4000, 20000))
    expect(b.compactionTailTokens).toBe(16_800);
    expect(b.summaryBudgetTokens).toBe(8_000); // min(8000, 8400)
  });

  it("clamps the tool cap for tiny and huge windows", () => {
    expect(deriveContextBudget(32_000).toolOutputCapTokens).toBe(4_000); // floor
    expect(deriveContextBudget(1_000_000).toolOutputCapTokens).toBe(25_000); // ceiling
  });

  it("falls back to the default window for undefined/0/negative", () => {
    for (const input of [undefined, null, 0, -5]) {
      expect(deriveContextBudget(input as never).contextWindow).toBe(DEFAULT_CONTEXT_WINDOW);
    }
  });
});

describe("estimateTokens", () => {
  it("is ceil(chars/4) and 0 for empty", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
  });
});

describe("contextOccupancy", () => {
  it("estimates the whole history when no anchor exists", () => {
    const messages = [text("user", "x".repeat(400)), text("assistant", "y".repeat(400))];
    const occ = contextOccupancy(messages);
    // Serialized JSON is larger than the raw text, so > 200 tokens; sanity band.
    expect(occ).toBeGreaterThan(200);
    expect(occ).toBeLessThan(500);
  });

  it("anchors on the last assistant message with usage metadata and adds the delta", () => {
    const messages = [
      text("user", "hello"),
      text("assistant", "hi", { inputTokens: 90_000, outputTokens: 1_000, totalTokens: 91_000 }),
      text("user", "z".repeat(4_000)), // ~1000+ tokens serialized
    ];
    const occ = contextOccupancy(messages);
    expect(occ).toBeGreaterThan(91_000);
    expect(occ).toBeLessThan(93_500);
  });

  it("prefers a compaction checkpoint that comes after the last usage anchor", () => {
    const messages = [
      text("assistant", "old", { inputTokens: 900_000, outputTokens: 2_000 }),
      text("user", "[Conversation summary]", {
        compaction: { coversUpTo: "m_x", originalTokens: 900_000, summaryTokens: 3_000, occupancyEstimate: 12_000 },
      }),
    ];
    expect(contextOccupancy(messages)).toBe(12_000);
  });
});

describe("sliceHistoryAtCheckpoint", () => {
  it("returns messages unchanged when no checkpoint exists", () => {
    const messages = [text("user", "a"), text("assistant", "b")];
    expect(sliceHistoryAtCheckpoint(messages)).toEqual(messages);
  });

  it("returns [checkpoint, ...messages after coversUpTo], dropping summarized head", () => {
    const head = text("user", "old question");
    const covered = text("assistant", "old answer");
    const tailUser = text("user", "recent question");
    const tailAssistant = text("assistant", "recent answer");
    const checkpoint = text("user", "[Conversation summary]", {
      compaction: { coversUpTo: covered.id, originalTokens: 100, summaryTokens: 10, occupancyEstimate: 50 },
    });
    // Chronological order: checkpoint row was inserted AFTER the tail existed.
    const result = sliceHistoryAtCheckpoint([head, covered, tailUser, tailAssistant, checkpoint]);
    expect(result.map((m) => m.id)).toEqual([checkpoint.id, tailUser.id, tailAssistant.id]);
  });

  it("uses only the NEWEST checkpoint when several exist", () => {
    const a = text("user", "a");
    const cp1 = text("user", "[summary 1]", { compaction: { coversUpTo: a.id, originalTokens: 1, summaryTokens: 1, occupancyEstimate: 1 } });
    const b = text("user", "b");
    const cp2 = text("user", "[summary 2]", { compaction: { coversUpTo: b.id, originalTokens: 1, summaryTokens: 1, occupancyEstimate: 1 } });
    const c = text("user", "c");
    const result = sliceHistoryAtCheckpoint([a, cp1, b, c, cp2]);
    expect(result.map((m) => m.id)).toEqual([cp2.id, c.id]);
    expect(getCompaction(result[0]!)).toBeDefined();
  });
});

describe("error helpers", () => {
  it("ContextCompactionRequiredError carries a JSON message with the code", () => {
    const err = new ContextCompactionRequiredError(150_000, deriveContextBudget(200_000));
    const parsed = JSON.parse(err.message);
    expect(parsed.code).toBe(CONTEXT_COMPACTION_REQUIRED);
    expect(parsed.occupancy).toBe(150_000);
    expect(parsed.usableWindow).toBe(168_000);
    expect(typeof parsed.message).toBe("string");
  });

  it("matches known provider context-length error shapes", () => {
    for (const msg of [
      "litellm.ContextWindowExceededError: ...",
      "This model's maximum context length is 128000 tokens",
      "prompt is too long: 210000 tokens > 200000 maximum",
      "Input is too long for requested model.",
      "The input token count exceeds the maximum number of tokens allowed",
    ]) {
      expect(isProviderContextLengthError(msg)).toBe(true);
    }
    expect(isProviderContextLengthError("rate limit exceeded")).toBe(false);
    expect(isProviderContextLengthError("tool call validation failed")).toBe(false);
  });

  it("mapStreamErrorMessage wraps context errors as the structured JSON and passes others through", () => {
    const mapped = mapStreamErrorMessage("prompt is too long: 999");
    expect(JSON.parse(mapped).code).toBe(CONTEXT_COMPACTION_REQUIRED);
    expect(mapStreamErrorMessage("something else")).toBe("something else");
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
npm test -- src/exulu/context-budget.test.ts
```
Expected: FAIL — `Cannot find module './context-budget'`.

- [ ] **Step 4: Write the implementation**

Create `src/exulu/context-budget.ts`:

```ts
import type { UIMessage } from "ai";

/**
 * Single source of truth for context-window budget math (spec:
 * docs/superpowers/specs/2026-07-07-context-window-management-design.md).
 * The frontend mirrors these formulas in
 * exulu/frontend/app/(application)/chat/lib/context-budget.ts — keep in sync.
 */

export const DEFAULT_CONTEXT_WINDOW = 128_000;

export type ContextBudget = {
  contextWindow: number;
  outputReserve: number;
  usableWindow: number;
  warnThreshold: number;
  blockThreshold: number;
  toolOutputCapTokens: number;
  compactionTailTokens: number;
  summaryBudgetTokens: number;
};

export const deriveContextBudget = (contextWindowInput?: number | null): ContextBudget => {
  const contextWindow =
    contextWindowInput != null && contextWindowInput > 0 ? contextWindowInput : DEFAULT_CONTEXT_WINDOW;
  const outputReserve = Math.min(32_000, Math.floor(contextWindow * 0.2));
  const usableWindow = contextWindow - outputReserve;
  return {
    contextWindow,
    outputReserve,
    usableWindow,
    warnThreshold: Math.floor(usableWindow * 0.8),
    blockThreshold: Math.floor(usableWindow * 0.95),
    toolOutputCapTokens: Math.min(25_000, Math.max(4_000, Math.floor(contextWindow * 0.1))),
    compactionTailTokens: Math.floor(usableWindow * 0.1),
    summaryBudgetTokens: Math.min(8_000, Math.floor(usableWindow * 0.05)),
  };
};

/**
 * chars/4 heuristic — deterministic, sync, no network. Real per-turn usage
 * metadata anchors occupancy every turn, so estimator drift never accumulates.
 */
export const estimateTokens = (text: string): number => (text ? Math.ceil(text.length / 4) : 0);

export const estimateMessageTokens = (message: UIMessage): number =>
  estimateTokens(JSON.stringify(message));

export type CompactionMetadata = {
  coversUpTo: string;
  originalTokens: number;
  summaryTokens: number;
  occupancyEstimate: number;
  steer?: string;
};

export const getCompaction = (message: UIMessage): CompactionMetadata | undefined =>
  (message.metadata as { compaction?: CompactionMetadata } | undefined)?.compaction;

/**
 * Model-view assembly. Input MUST be in chronological (createdAt) order.
 * The newest checkpoint replaces everything up to and including its
 * `coversUpTo` message; messages created after that point (the verbatim tail
 * plus anything newer) follow the summary.
 */
export const sliceHistoryAtCheckpoint = (messages: UIMessage[]): UIMessage[] => {
  let checkpointIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (getCompaction(messages[i]!)) {
      checkpointIdx = i;
      break;
    }
  }
  if (checkpointIdx === -1) return messages;
  const checkpoint = messages[checkpointIdx]!;
  const coversUpTo = getCompaction(checkpoint)!.coversUpTo;
  const coversIdx = messages.findIndex((m) => m.id === coversUpTo);
  // coversUpTo missing (deleted row): degrade to "summary only + newer than
  // the checkpoint" rather than resending the whole history.
  const boundary = coversIdx === -1 ? checkpointIdx : coversIdx;
  const after = messages.filter((m, i) => i > boundary && i !== checkpointIdx);
  return [checkpoint, ...after];
};

/**
 * Occupancy = the newest REAL number we have, plus a chars/4 estimate of
 * everything after it. Input MUST be in chronological order. Anchors:
 *  - an assistant message with usage metadata (inputTokens reflects the whole
 *    prompt of that turn, outputTokens its response), or
 *  - a compaction checkpoint (occupancyEstimate = summary + verbatim tail).
 */
export const contextOccupancy = (messages: UIMessage[]): number => {
  let anchorIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    const meta = m.metadata as { inputTokens?: number } | undefined;
    if (getCompaction(m) || (m.role === "assistant" && typeof meta?.inputTokens === "number")) {
      anchorIdx = i;
      break;
    }
  }
  let total = 0;
  let rest = messages;
  if (anchorIdx !== -1) {
    const anchor = messages[anchorIdx]!;
    const compaction = getCompaction(anchor);
    if (compaction) {
      total = compaction.occupancyEstimate;
    } else {
      const meta = anchor.metadata as { inputTokens?: number; outputTokens?: number };
      total = (meta.inputTokens ?? 0) + (meta.outputTokens ?? 0);
    }
    rest = messages.slice(anchorIdx + 1);
  }
  for (const m of rest) total += estimateMessageTokens(m);
  return total;
};

export const CONTEXT_COMPACTION_REQUIRED = "CONTEXT_COMPACTION_REQUIRED";
export const COMPACTION_INSUFFICIENT = "COMPACTION_INSUFFICIENT";

/**
 * Thrown by the pre-flight budget gate. The message IS a JSON string so it
 * survives every error channel (HTTP body, SSE error part) and the frontend
 * can `JSON.parse` it or match `.includes(CONTEXT_COMPACTION_REQUIRED)`.
 */
export class ContextCompactionRequiredError extends Error {
  constructor(
    public occupancy: number,
    public budget: ContextBudget,
  ) {
    super(
      JSON.stringify({
        code: CONTEXT_COMPACTION_REQUIRED,
        message:
          `This conversation no longer fits the model's context window ` +
          `(~${occupancy.toLocaleString("en-US")} of ${budget.usableWindow.toLocaleString("en-US")} usable tokens). ` +
          `Compact the conversation to continue.`,
        occupancy,
        usableWindow: budget.usableWindow,
        contextWindow: budget.contextWindow,
      }),
    );
    this.name = "ContextCompactionRequiredError";
  }
}

// Known provider phrasings for "your prompt does not fit". Sources: LiteLLM
// (ContextWindowExceededError), OpenAI ("maximum context length"), Anthropic
// ("prompt is too long"), Vertex/Gemini ("input token count exceeds"),
// generic gateways ("input is too long", "context window/length").
const PROVIDER_CONTEXT_ERROR_PATTERNS: RegExp[] = [
  /ContextWindowExceededError/i,
  /context.?window/i,
  /context.?length/i,
  /maximum context/i,
  /prompt is too long/i,
  /input is too long/i,
  /token count exceeds/i,
  /too many tokens/i,
];

export const isProviderContextLengthError = (message: string): boolean =>
  PROVIDER_CONTEXT_ERROR_PATTERNS.some((re) => re.test(message));

/** Map a raw stream-error message to the structured code when it is a context-length failure. */
export const mapStreamErrorMessage = (message: string): string =>
  isProviderContextLengthError(message)
    ? JSON.stringify({
        code: CONTEXT_COMPACTION_REQUIRED,
        message:
          "The model rejected the request because the conversation exceeds its context window. Compact the conversation to continue.",
        providerMessage: message.slice(0, 500),
      })
    : message;
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
npm test -- src/exulu/context-budget.test.ts
```
Expected: PASS (all suites).

- [ ] **Step 6: Commit**

```bash
git add src/exulu/context-budget.ts src/exulu/context-budget.test.ts
git commit -m "feat(context): context budget math, occupancy, checkpoint slicing, error codes"
```

---

### Task 2: `resolve-context-window.ts` — real context window at runtime

**Files:**
- Create: `src/exulu/resolve-context-window.ts`
- Test: `src/exulu/resolve-context-window.test.ts`

**Interfaces:**
- Consumes: `findLiteLLMModel(modelName)` from `./litellm/catalog` (returns `{ max_input_tokens, max_tokens, ... } | undefined`); `DEFAULT_CONTEXT_WINDOW` from Task 1; `ExuluProvider` type from `./provider` (its `maxContextLength?: number`; note the LiteLLM-mode sentinel THROWS on property access — see `LITELLM_PROVIDER_SENTINEL` in `resolve-model.ts:74`).
- Produces: `resolveContextWindow({ modelId, exuluProvider }: { modelId: string; exuluProvider?: ExuluProvider }): Promise<number>` — always a positive number.

- [ ] **Step 1: Write the failing test**

Create `src/exulu/resolve-context-window.test.ts`:

```ts
import { resolveContextWindow } from "./resolve-context-window";
import { DEFAULT_CONTEXT_WINDOW } from "./context-budget";
import type { ExuluProvider } from "./provider";

jest.mock("./litellm/catalog", () => ({
  findLiteLLMModel: jest.fn(),
}));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { findLiteLLMModel } = require("./litellm/catalog") as { findLiteLLMModel: jest.Mock };

const ORIGINAL_ENV = process.env.EXULU_USE_LITELLM;
afterEach(() => {
  process.env.EXULU_USE_LITELLM = ORIGINAL_ENV;
  jest.clearAllMocks();
});

describe("resolveContextWindow", () => {
  it("prefers max_input_tokens from the LiteLLM catalog in LiteLLM mode", async () => {
    process.env.EXULU_USE_LITELLM = "true";
    findLiteLLMModel.mockResolvedValue({ max_input_tokens: 1_000_000, max_tokens: 900_000 });
    await expect(resolveContextWindow({ modelId: "gemini-2.5-pro" })).resolves.toBe(1_000_000);
  });

  it("falls back to max_tokens, then the default, in LiteLLM mode", async () => {
    process.env.EXULU_USE_LITELLM = "true";
    findLiteLLMModel.mockResolvedValue({ max_input_tokens: null, max_tokens: 200_000 });
    await expect(resolveContextWindow({ modelId: "m" })).resolves.toBe(200_000);
    findLiteLLMModel.mockResolvedValue(undefined);
    await expect(resolveContextWindow({ modelId: "unknown" })).resolves.toBe(DEFAULT_CONTEXT_WINDOW);
  });

  it("uses ExuluProvider.maxContextLength in catalog mode", async () => {
    process.env.EXULU_USE_LITELLM = "false";
    const provider = { maxContextLength: 400_000 } as ExuluProvider;
    await expect(resolveContextWindow({ modelId: "row-id", exuluProvider: provider })).resolves.toBe(400_000);
  });

  it("survives a provider whose property access throws (LiteLLM sentinel) and returns the default", async () => {
    process.env.EXULU_USE_LITELLM = "false";
    const sentinel = new Proxy({} as ExuluProvider, {
      get() {
        throw new Error("not available");
      },
    });
    await expect(resolveContextWindow({ modelId: "x", exuluProvider: sentinel })).resolves.toBe(DEFAULT_CONTEXT_WINDOW);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test -- src/exulu/resolve-context-window.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `src/exulu/resolve-context-window.ts`:

```ts
import { findLiteLLMModel } from "./litellm/catalog";
import { DEFAULT_CONTEXT_WINDOW } from "./context-budget";
import type { ExuluProvider } from "./provider";

/**
 * Resolve the model's real max input context at runtime. Fixes the standing
 * bug where agent.maxContextLength is only hydrated in the GraphQL layer and
 * runtime consumers (truncateToolOutput) always saw the 128K default.
 *
 * LiteLLM mode: catalog max_input_tokens ?? max_tokens.
 * Catalog mode: ExuluProvider.maxContextLength (property access is guarded —
 * in LiteLLM mode `resolved.exuluProvider` is a sentinel Proxy that throws).
 */
export const resolveContextWindow = async ({
  modelId,
  exuluProvider,
}: {
  modelId: string;
  exuluProvider?: ExuluProvider;
}): Promise<number> => {
  if (process.env.EXULU_USE_LITELLM === "true") {
    const entry = await findLiteLLMModel(modelId);
    const fromCatalog = entry?.max_input_tokens ?? entry?.max_tokens;
    if (fromCatalog != null && fromCatalog > 0) return fromCatalog;
  } else if (exuluProvider) {
    try {
      const fromProvider = exuluProvider.maxContextLength;
      if (fromProvider != null && fromProvider > 0) return fromProvider;
    } catch {
      // LITELLM_PROVIDER_SENTINEL throws on any property access — degrade.
    }
  }
  console.warn(
    `[EXULU] Unknown context window for model "${modelId}" — assuming ${DEFAULT_CONTEXT_WINDOW}. ` +
      `Check the LiteLLM catalog / provider template metadata.`,
  );
  return DEFAULT_CONTEXT_WINDOW;
};
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npm test -- src/exulu/resolve-context-window.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/exulu/resolve-context-window.ts src/exulu/resolve-context-window.test.ts
git commit -m "feat(context): resolve real model context window in both LiteLLM and catalog modes"
```

---

### Task 3: `truncateToolOutput` — optional char-limit override

**Files:**
- Modify: `src/utils/truncate-tool-output.ts`
- Test: `src/utils/truncate-tool-output.test.ts` (append cases)

**Interfaces:**
- Produces: `truncateToolOutput(output: string, maxContextLength: number | undefined, toolName: string, tailFraction = 0.1, charLimitOverride?: number): string`. Behavior with 4 args is byte-identical to today (existing tests must keep passing).

- [ ] **Step 1: Write the failing test** — append to `src/utils/truncate-tool-output.test.ts`:

```ts
describe("charLimitOverride", () => {
  it("uses the override instead of the 25% rule", () => {
    const output = "a".repeat(10_000);
    const result = truncateToolOutput(output, 1_000_000, "readFile", 0.1, 4_000);
    expect(result.length).toBeLessThan(10_000);
    expect(result).toContain("OUTPUT TRUNCATED");
    // head 90% + tail 10% of the 4000-char budget
    expect(result.startsWith("a".repeat(3_600))).toBe(true);
    expect(result.endsWith("a".repeat(400))).toBe(true);
  });

  it("ignores a non-positive override", () => {
    const output = "a".repeat(10);
    expect(truncateToolOutput(output, 128_000, "bash", 0.1, 0)).toBe(output);
  });
});
```

- [ ] **Step 2: Run test to verify the new cases fail**

```bash
npm test -- src/utils/truncate-tool-output.test.ts
```
Expected: the two new cases FAIL (first: no truncation happens at 25% of 1M; the function signature has no 5th param yet), existing cases PASS.

- [ ] **Step 3: Implement** — in `src/utils/truncate-tool-output.ts` change the signature and `charLimit` line:

```ts
export const truncateToolOutput = (
  output: string,
  maxContextLength: number | undefined,
  toolName: string,
  tailFraction = 0.1,
  charLimitOverride?: number,
): string => {
  const effectiveCtx = (maxContextLength != null && maxContextLength > 0) ? maxContextLength : 128_000;
  const charLimit =
    charLimitOverride != null && charLimitOverride > 0
      ? charLimitOverride
      : Math.floor(effectiveCtx * 0.25 * 4);
```
(the rest of the function body is unchanged).

- [ ] **Step 4: Run the full utils test to verify all pass**

```bash
npm test -- src/utils/truncate-tool-output.test.ts
```
Expected: PASS (old + new cases).

- [ ] **Step 5: Commit**

```bash
git add src/utils/truncate-tool-output.ts src/utils/truncate-tool-output.test.ts
git commit -m "feat(context): optional char-limit override for truncateToolOutput"
```

---

### Task 4: `tool-output-offload.ts` — cap + offload guard

**Files:**
- Create: `src/exulu/tool-output-offload.ts`
- Test: `src/exulu/tool-output-offload.test.ts`

**Interfaces:**
- Consumes: `uploadFile(file: Buffer, fileName: string, config: ExuluConfig, options?, user?)` from `@SRC/uppy` (uploads to `[s3prefix/]user_<uid>/<fileName>`; session files live under `fileName = "sessions/<sessionID>/<name>"` — same layout the `GET /sessions/:id/files` route lists); `deriveContextBudget`, `estimateTokens` from Task 1.
- Produces:
  - `type ToolOutputGuardContext = { toolName: string; contextWindow?: number; sessionID?: string; user?: User; exuluConfig?: ExuluConfig }`
  - `type TruncatedToolOutput = { truncated: true; notice: string; sessionFile?: string; preview: string }`
  - `guardToolOutput(value: unknown, ctx: ToolOutputGuardContext): Promise<unknown>` — returns `value` unchanged when under cap, else a `TruncatedToolOutput`.
  - `guardExtractedFileText(filename: string, text: string, ctx: Omit<ToolOutputGuardContext, "toolName">): Promise<string>` — for document uploads; returns original text or `preview + notice`.

- [ ] **Step 1: Write the failing test**

Create `src/exulu/tool-output-offload.test.ts`:

```ts
import { guardToolOutput, guardExtractedFileText, type TruncatedToolOutput } from "./tool-output-offload";
import type { ExuluConfig } from "./app";
import type { User } from "@EXULU_TYPES/models/user";

jest.mock("@SRC/uppy", () => ({
  uploadFile: jest.fn().mockResolvedValue("bucket/prefix/user_1/sessions/s1/whatever.txt"),
}));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { uploadFile } = require("@SRC/uppy") as { uploadFile: jest.Mock };

const exuluConfig = { fileUploads: { s3Bucket: "b", s3key: "k", s3secret: "s", s3endpoint: "e" } } as unknown as ExuluConfig;
const user = { id: 1 } as User;
const baseCtx = { toolName: "web_search", contextWindow: 128_000, sessionID: "s1", user, exuluConfig };

afterEach(() => jest.clearAllMocks());

describe("guardToolOutput", () => {
  it("passes small outputs through untouched (string and object)", async () => {
    await expect(guardToolOutput("small", baseCtx)).resolves.toBe("small");
    const obj = { result: "ok" };
    await expect(guardToolOutput(obj, baseCtx)).resolves.toBe(obj);
    expect(uploadFile).not.toHaveBeenCalled();
  });

  it("offloads an oversized output to a session file and returns preview + notice", async () => {
    // 128K window → cap 12,800 tokens → 51,200 chars. Make it bigger.
    const big = "x".repeat(80_000);
    const guarded = (await guardToolOutput(big, baseCtx)) as TruncatedToolOutput;
    expect(guarded.truncated).toBe(true);
    expect(guarded.sessionFile).toMatch(/^tool-output-web_search-[a-f0-9]{8}\.txt$/);
    expect(guarded.notice).toContain("read_session_file");
    expect(guarded.notice).toContain(guarded.sessionFile!);
    expect(guarded.preview.length).toBeLessThanOrEqual(4_000);
    expect(uploadFile).toHaveBeenCalledWith(
      expect.any(Buffer),
      expect.stringMatching(/^sessions\/s1\/tool-output-web_search-[a-f0-9]{8}\.txt$/),
      exuluConfig,
      { contentType: "text/plain" },
      1,
    );
  });

  it("serializes non-string outputs before measuring and storing", async () => {
    const big = { rows: "y".repeat(80_000) };
    const guarded = (await guardToolOutput(big, baseCtx)) as TruncatedToolOutput;
    expect(guarded.truncated).toBe(true);
    const stored = (uploadFile.mock.calls[0]![0] as Buffer).toString("utf-8");
    expect(stored).toBe(JSON.stringify(big));
  });

  it("degrades to discard-notice when storage is unavailable or fails", async () => {
    const big = "x".repeat(80_000);
    // No sessionID → no storage attempted.
    const noSession = (await guardToolOutput(big, { ...baseCtx, sessionID: undefined })) as TruncatedToolOutput;
    expect(noSession.sessionFile).toBeUndefined();
    expect(noSession.notice).toContain("discarded");
    // Upload throws → same degraded result, no crash.
    uploadFile.mockRejectedValueOnce(new Error("s3 down"));
    const failed = (await guardToolOutput(big, baseCtx)) as TruncatedToolOutput;
    expect(failed.sessionFile).toBeUndefined();
    expect(failed.truncated).toBe(true);
  });

  it("passes null/undefined through", async () => {
    await expect(guardToolOutput(null, baseCtx)).resolves.toBeNull();
    await expect(guardToolOutput(undefined, baseCtx)).resolves.toBeUndefined();
  });
});

describe("guardExtractedFileText", () => {
  it("returns the original text when under the cap", async () => {
    await expect(guardExtractedFileText("a.odt", "short doc", baseCtx)).resolves.toBe("short doc");
  });

  it("offloads oversized document text and returns preview + pointer notice", async () => {
    const big = "z".repeat(80_000);
    const result = await guardExtractedFileText("bericht.odt", big, baseCtx);
    expect(result.length).toBeLessThan(big.length);
    expect(result).toContain("read_session_file");
    expect(result).toContain("bericht.odt");
    expect(uploadFile).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test -- src/exulu/tool-output-offload.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `src/exulu/tool-output-offload.ts`:

```ts
import { randomUUID } from "node:crypto";
import { uploadFile } from "@SRC/uppy";
import type { ExuluConfig } from "./app";
import type { User } from "@EXULU_TYPES/models/user";
import { deriveContextBudget, estimateTokens } from "./context-budget";

export type ToolOutputGuardContext = {
  toolName: string;
  contextWindow?: number;
  sessionID?: string;
  user?: User;
  exuluConfig?: ExuluConfig;
};

export type TruncatedToolOutput = {
  truncated: true;
  notice: string;
  sessionFile?: string;
  preview: string;
};

/** ~1K tokens of head preview kept inline. */
const PREVIEW_CHARS = 4_000;

/**
 * Store the full serialized output in the session's S3 file folder (the same
 * layout GET /sessions/:id/files lists and the sandbox mirrors), so the model
 * can page through it with read_session_file and the user sees it in the
 * Session-files side panel. Best-effort: any failure degrades to undefined.
 */
const storeAsSessionFile = async (
  serialized: string,
  ctx: ToolOutputGuardContext,
): Promise<string | undefined> => {
  if (!ctx.sessionID || !ctx.exuluConfig?.fileUploads) return undefined;
  const safeTool = ctx.toolName.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 40);
  const name = `tool-output-${safeTool}-${randomUUID().slice(0, 8)}.txt`;
  try {
    await uploadFile(
      Buffer.from(serialized, "utf-8"),
      `sessions/${ctx.sessionID}/${name}`,
      ctx.exuluConfig,
      { contentType: "text/plain" },
      ctx.user?.id,
    );
    return name;
  } catch (err) {
    console.error("[EXULU] Failed to offload oversized tool output to session files.", err);
    return undefined;
  }
};

const buildNotice = (tokens: number, capTokens: number, sessionFile?: string): string =>
  sessionFile
    ? `Tool output truncated: ~${tokens.toLocaleString("en-US")} tokens (limit ${capTokens.toLocaleString("en-US")}). ` +
      `The FULL output is saved as session file "${sessionFile}" — call read_session_file with ` +
      `{ filename: "${sessionFile}", offset, limit } to read specific line ranges.`
    : `Tool output truncated: ~${tokens.toLocaleString("en-US")} tokens (limit ${capTokens.toLocaleString("en-US")}). ` +
      `The remainder was discarded — re-run the tool with narrower arguments.`;

/**
 * Universal cap+offload guard for tool outputs (spec §2). Under the cap the
 * value passes through UNCHANGED (same reference — callers rely on identity
 * to detect truncation). Over the cap the full output is offloaded and the
 * model receives a small object whose `notice` leads with the recovery path.
 */
export const guardToolOutput = async (
  value: unknown,
  ctx: ToolOutputGuardContext,
): Promise<unknown> => {
  if (value == null) return value;
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  if (typeof serialized !== "string") return value; // unserializable — leave alone
  const budget = deriveContextBudget(ctx.contextWindow);
  const tokens = estimateTokens(serialized);
  if (tokens <= budget.toolOutputCapTokens) return value;
  const sessionFile = await storeAsSessionFile(serialized, ctx);
  const result: TruncatedToolOutput = {
    truncated: true,
    notice: buildNotice(tokens, budget.toolOutputCapTokens, sessionFile),
    ...(sessionFile ? { sessionFile } : {}),
    preview: serialized.slice(0, PREVIEW_CHARS),
  };
  return result;
};

/**
 * Same guard for document text extracted from uploaded files
 * (provider.ts processFilePartsInMessages). Returns a string because the
 * extracted text is embedded in a `<file ...>` text part.
 */
export const guardExtractedFileText = async (
  filename: string,
  text: string,
  ctx: Omit<ToolOutputGuardContext, "toolName">,
): Promise<string> => {
  const budget = deriveContextBudget(ctx.contextWindow);
  const tokens = estimateTokens(text);
  if (tokens <= budget.toolOutputCapTokens) return text;
  const sessionFile = await storeAsSessionFile(text, { ...ctx, toolName: `upload-${filename}` });
  const notice = sessionFile
    ? `[Document "${filename}" truncated: ~${tokens.toLocaleString("en-US")} tokens. The full extracted text is saved as ` +
      `session file "${sessionFile}" — read specific parts with read_session_file (offset/limit).]`
    : `[Document "${filename}" truncated: ~${tokens.toLocaleString("en-US")} tokens — the remainder is unavailable.]`;
  return `${text.slice(0, PREVIEW_CHARS)}\n\n${notice}`;
};
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npm test -- src/exulu/tool-output-offload.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/exulu/tool-output-offload.ts src/exulu/tool-output-offload.test.ts
git commit -m "feat(context): universal tool-output cap with restorable offload to session files"
```

---

### Task 5: `read_session_file` tool — the retrieval escape hatch

**Files:**
- Create: `src/templates/tools/session-file-read-tool.ts`
- Test: `src/templates/tools/session-file-read-tool.test.ts`

**Interfaces:**
- Consumes: `ExuluTool.internal(...)` from `@SRC/exulu/tool` (pass `type: "function"` — do NOT use `type: "context"`, that type triggers the citation-format system prompt in provider.ts); `getPresignedUrl(bucket, key, config)` from `@SRC/uppy`; session-file S3 layout `[s3prefix/]user_<uid>/sessions/<sessionID>/<filename>` (mirrors `buildSessionPrefixes` in `src/exulu/routes.ts:3867`).
- Produces: `createSessionFileReadTool({ sessionID, user, exuluConfig }: { sessionID?: string; user?: User; exuluConfig?: ExuluConfig }): ExuluTool | undefined` — undefined when sessionID or fileUploads config is missing. Tool id/name: `read_session_file`. Execute returns `{ content, totalLines, offset, linesReturned }` or `{ error }`.

- [ ] **Step 1: Write the failing test**

Create `src/templates/tools/session-file-read-tool.test.ts`:

```ts
import { createSessionFileReadTool } from "./session-file-read-tool";
import type { ExuluConfig } from "@SRC/exulu/app";
import type { User } from "@EXULU_TYPES/models/user";

jest.mock("@SRC/uppy", () => ({
  getPresignedUrl: jest.fn().mockResolvedValue("https://s3.example/presigned"),
}));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { getPresignedUrl } = require("@SRC/uppy") as { getPresignedUrl: jest.Mock };

const exuluConfig = {
  fileUploads: { s3Bucket: "bucket", s3prefix: "exulu" },
} as unknown as ExuluConfig;
const user = { id: 7 } as User;

const fileBody = Array.from({ length: 500 }, (_, i) => `line ${i + 1}`).join("\n");

beforeEach(() => {
  global.fetch = jest.fn().mockResolvedValue({ ok: true, text: async () => fileBody } as never) as never;
});
afterEach(() => jest.clearAllMocks());

describe("createSessionFileReadTool", () => {
  it("returns undefined without a session or file-upload config", () => {
    expect(createSessionFileReadTool({ sessionID: undefined, user, exuluConfig })).toBeUndefined();
    expect(createSessionFileReadTool({ sessionID: "s1", user, exuluConfig: {} as ExuluConfig })).toBeUndefined();
  });

  it("reads a line range from the session file via a presigned URL", async () => {
    const tool = createSessionFileReadTool({ sessionID: "s1", user, exuluConfig })!;
    const result = await (tool.tool!.execute as (i: unknown) => Promise<{ content: string; totalLines: number; offset: number; linesReturned: number }>)(
      { filename: "tool-output-web_search-abc12345.txt", offset: 10, limit: 3 },
    );
    expect(result.content).toBe("line 10\nline 11\nline 12");
    expect(result.totalLines).toBe(500);
    expect(result.offset).toBe(10);
    expect(result.linesReturned).toBe(3);
    expect(getPresignedUrl).toHaveBeenCalledWith(
      "bucket",
      "exulu/user_7/sessions/s1/tool-output-web_search-abc12345.txt",
      exuluConfig,
    );
  });

  it("defaults offset to 1 and limit to 250", async () => {
    const tool = createSessionFileReadTool({ sessionID: "s1", user, exuluConfig })!;
    const result = await (tool.tool!.execute as (i: unknown) => Promise<{ content: string; linesReturned: number }>)({
      filename: "f.txt",
    });
    expect(result.content.startsWith("line 1\n")).toBe(true);
    expect(result.linesReturned).toBe(250);
  });

  it("rejects path traversal and returns an instructive error", async () => {
    const tool = createSessionFileReadTool({ sessionID: "s1", user, exuluConfig })!;
    for (const filename of ["../secret", "a/b.txt", ""]) {
      const result = await (tool.tool!.execute as (i: unknown) => Promise<{ error?: string }>)({ filename });
      expect(result.error).toContain("Invalid filename");
    }
  });

  it("surfaces a read failure as an error object, not a throw", async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({ ok: false, status: 404 });
    const tool = createSessionFileReadTool({ sessionID: "s1", user, exuluConfig })!;
    const result = await (tool.tool!.execute as (i: unknown) => Promise<{ error?: string }>)({ filename: "gone.txt" });
    expect(result.error).toContain("404");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test -- src/templates/tools/session-file-read-tool.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `src/templates/tools/session-file-read-tool.ts`:

```ts
import { z } from "zod";
import { ExuluTool } from "@SRC/exulu/tool";
import { getPresignedUrl } from "@SRC/uppy";
import type { ExuluConfig } from "@SRC/exulu/app";
import type { User } from "@EXULU_TYPES/models/user";

const DEFAULT_LIMIT = 250;
/** Hard slice cap so a single read can never blow the context again. */
const MAX_CONTENT_CHARS = 16_000;

/**
 * Escape hatch for offloaded tool outputs and uploaded documents (spec §2):
 * page through any file in the session's S3 file folder by line range.
 * Registered for every session with file uploads configured — sandbox or not.
 */
export const createSessionFileReadTool = ({
  sessionID,
  user,
  exuluConfig,
}: {
  sessionID?: string;
  user?: User;
  exuluConfig?: ExuluConfig;
}): ExuluTool | undefined => {
  if (!sessionID || !exuluConfig?.fileUploads?.s3Bucket) return undefined;

  return ExuluTool.internal({
    id: "read_session_file",
    name: "read_session_file",
    description:
      "Read a line range from a file stored in this session's files — including offloaded tool outputs " +
      "(tool-output-*.txt) and uploaded documents. Use offset (1-based line number) and limit to page " +
      "through large files instead of reading everything at once.",
    inputSchema: z.object({
      filename: z
        .string()
        .describe('Exact session file name as referenced in a truncation notice, e.g. "tool-output-web_search-a1b2c3d4.txt"'),
      offset: z.number().int().min(1).optional().describe("1-based first line to read (default 1)"),
      limit: z.number().int().min(1).max(1000).optional().describe(`Number of lines to read (default ${DEFAULT_LIMIT})`),
    }),
    type: "function",
    category: "session",
    config: [],
    execute: async ({ filename, offset, limit }: { filename: string; offset?: number; limit?: number }) => {
      const safeName = String(filename ?? "").trim();
      if (!safeName || safeName.includes("..") || safeName.includes("/") || safeName.includes("\\")) {
        return {
          error: "Invalid filename — pass the bare file name exactly as listed in the session files (no paths).",
        };
      }
      const uploads = exuluConfig.fileUploads!;
      const generalPrefix = uploads.s3prefix ? `${uploads.s3prefix.replace(/\/$/, "")}/` : "";
      const key = `${generalPrefix}user_${user?.id ?? "api"}/sessions/${sessionID}/${safeName}`;
      try {
        const url = await getPresignedUrl(uploads.s3Bucket!, key, exuluConfig);
        const res = await fetch(url);
        if (!res.ok) {
          return { error: `Could not read session file "${safeName}" (status ${res.status}). Check the exact file name.` };
        }
        const textBody = await res.text();
        const lines = textBody.split("\n");
        const start = (offset ?? 1) - 1;
        const requested = limit ?? DEFAULT_LIMIT;
        let content = lines.slice(start, start + requested).join("\n");
        if (content.length > MAX_CONTENT_CHARS) {
          content = content.slice(0, MAX_CONTENT_CHARS) + "\n[slice truncated — request fewer lines]";
        }
        return {
          content,
          totalLines: lines.length,
          offset: start + 1,
          linesReturned: Math.max(0, Math.min(requested, lines.length - start)),
        };
      } catch (err) {
        return { error: `Failed to read session file "${safeName}": ${err instanceof Error ? err.message : "unknown error"}` };
      }
    },
  });
};
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npm test -- src/templates/tools/session-file-read-tool.test.ts
```
Expected: PASS. If the `ExuluTool.internal` constructor requires fields not provided here (check `src/exulu/tool.ts` constructor), add them exactly as `createSessionItemsRetrievalTool` (`src/templates/tools/session-items-retrieval-tool.ts:19`) does.

- [ ] **Step 5: Commit**

```bash
git add src/templates/tools/session-file-read-tool.ts src/templates/tools/session-file-read-tool.test.ts
git commit -m "feat(context): read_session_file tool for paging offloaded outputs and documents"
```

---

### Task 6: Wire the guard into tool conversion

**Files:**
- Modify: `src/templates/tools/convert-exulu-tools-to-ai-sdk-tools.ts`
- Modify: `src/exulu/provider.ts` (3 call sites), `src/exulu/openai-gateway.ts` (1 call site) — add the new final argument as `undefined` for now (properly threaded in Tasks 8/11).

**Interfaces:**
- Consumes: `guardToolOutput` (Task 4), `createSessionFileReadTool` (Task 5), `deriveContextBudget` (Task 1), `truncateToolOutput` (Task 3).
- Produces: `convertExuluToolsToAiSdkTools(...)` gains a 17th positional parameter `contextWindow?: number` (after `memoryItems`). Every generic tool's final output passes through `guardToolOutput`; sandbox readFile/bash outputs are truncated against the REAL window with the budget-aligned char limit; `read_session_file` is registered whenever a session + file uploads exist.

- [ ] **Step 1: Add the parameter and budget**

In `src/templates/tools/convert-exulu-tools-to-ai-sdk-tools.ts`:

Add imports at the top:
```ts
import { guardToolOutput } from "@SRC/exulu/tool-output-offload";
import { createSessionFileReadTool } from "./session-file-read-tool";
import { deriveContextBudget } from "@SRC/exulu/context-budget";
```

Extend the signature (line ~146, after `memoryItems?: VectorSearchChunkResult[]`):
```ts
  memoryItems?: VectorSearchChunkResult[],
  contextWindow?: number,
): Promise<Record<string, Tool>> => {
```

Immediately after the `if (!contexts) { contexts = []; }` block add:
```ts
  const budget = deriveContextBudget(contextWindow);
  const toolOutputCharLimit = budget.toolOutputCapTokens * 4;
```

- [ ] **Step 2: Register the read tool**

Directly after the `sessionItems` retrieval-tool block (`if (sessionItems) { ... }`, ends ~line 243) add:
```ts
  const sessionFileReadTool = createSessionFileReadTool({ sessionID, user, exuluConfig });
  if (sessionFileReadTool) {
    currentTools.push(sessionFileReadTool);
  }
```

- [ ] **Step 3: Fix the sandbox truncation window**

In the `sandboxTools` block replace the three `truncateToolOutput(...)` calls (currently passing `agent?.maxContextLength`, which is never populated at runtime):

```ts
content: truncateToolOutput(result.content, budget.contextWindow, 'readFile', 0.05, toolOutputCharLimit),
```
```ts
stdout: truncateToolOutput(result.stdout, budget.contextWindow, 'bash', 0.10, toolOutputCharLimit),
```
```ts
stderr: truncateToolOutput(result.stderr, budget.contextWindow, 'bash stderr', 0.40, toolOutputCharLimit),
```

- [ ] **Step 4: Guard the generic tool execute**

In the generic `async *execute(inputs, options)` generator, replace the final response handling (currently:
`if (response && typeof response === "object" && Symbol.asyncIterator in response) { let lastValue; for await (...) { yield value; lastValue = value; } return lastValue; } else { yield response; return response; }`)
with:

```ts
            const guardCtx = {
              toolName: cur.name,
              contextWindow,
              sessionID,
              user,
              exuluConfig,
            };

            // Check if response is an async generator
            if (response && typeof response === "object" && Symbol.asyncIterator in response) {
              let lastValue;
              // Iterate through all yielded values from the generator
              for await (const value of response) {
                yield value;
                lastValue = value;
              }
              // Cap + offload the FINAL value — that is what becomes the
              // persisted tool result and what every later turn re-sends.
              const guarded = await guardToolOutput(lastValue, guardCtx);
              if (guarded !== lastValue) {
                yield guarded;
              }
              return guarded;
            } else {
              const guarded = await guardToolOutput(response, guardCtx);
              yield guarded;
              return guarded;
            }
```

- [ ] **Step 5: Update the call sites to compile**

Add `undefined` (placeholder until Tasks 8/11 thread the real value) as the argument after `memoryItems` in the four existing calls:
- `src/exulu/provider.ts:536-553` (generateSync prompt path)
- `src/exulu/provider.ts:624-641` (generateSync messages path)
- `src/exulu/provider.ts:1099-1116` (generateStream)
- `src/exulu/openai-gateway.ts:434-450`

- [ ] **Step 6: Type-check and run the full backend test suite**

```bash
npm run type-check && npm test
```
Expected: type-check clean; all suites PASS (Tasks 1–5 tests included; no existing test covers this file directly).

- [ ] **Step 7: Commit**

```bash
git add src/templates/tools/convert-exulu-tools-to-ai-sdk-tools.ts src/exulu/provider.ts src/exulu/openai-gateway.ts
git commit -m "feat(context): guard every tool output at the conversion layer; register read_session_file"
```

---

### Task 7: Ordered, checkpoint-aware history loading

**Files:**
- Modify: `src/exulu/provider.ts` — `getAgentMessages` (line ~1156) + its two callers (generateSync line ~344, generateStream line ~851)

**Interfaces:**
- Consumes: `sliceHistoryAtCheckpoint` (Task 1).
- Produces: `export const getAgentMessages = async ({ session, user }: { session: string; user?: number }) => Promise<Array<{ content: string; [k: string]: unknown }>>` — EXPORTED (Task 10 needs it), full history in `createdAt ASC, id ASC` order, no limit. Both generate paths assemble the model view via `sliceHistoryAtCheckpoint` while keeping the CHRONOLOGICAL array around for occupancy (Task 8).

- [ ] **Step 1: Verify the timestamp column name**

```bash
grep -n 'table.timestamp' src/postgres/init-exulu-db.ts | head -3
```
Expected: `table.timestamp("createdAt").defaultTo(knex.fn.now());` — the column is `createdAt` (camelCase). If it differs, use the actual name below.

- [ ] **Step 2: Rewrite `getAgentMessages`**

Replace the function (provider.ts:1155-1185) with:

```ts
// Full ordered history. The previous version had `limit: 50` with NO ORDER BY
// — sessions past 50 messages sent an arbitrary heap-ordered subset to the
// model. Compaction (sliceHistoryAtCheckpoint) keeps the assembled prompt
// bounded, so loading the full session is safe.
export const getAgentMessages = async ({
  session,
  user,
}: {
  session: string;
  user?: number;
}) => {
  const { db } = await postgresClient();
  console.log("[EXULU] getting agent messages for session: " + session + " and user: " + user);
  const messages = await db
    .from("agent_messages")
    .where({ session, user: user || null })
    .orderBy([
      { column: "createdAt", order: "asc" },
      { column: "id", order: "asc" },
    ]);
  return messages;
};
```

- [ ] **Step 3: Update the generateStream caller** (provider.ts:851-857)

```ts
      const previousMessages = await getAgentMessages({
        session,
        user: user?.id,
      });
      previousMessagesContent = previousMessages.map((message) => JSON.parse(message.content));
```

Import `sliceHistoryAtCheckpoint` and `getCompaction` from `./context-budget` at the top of provider.ts. Then AFTER the existing dedupe/auto-decline/processFileParts pipeline (i.e. after `messages = await this.processFilePartsInMessages(messages);`, line ~944) add the model-view slice — keep a chronological copy first:

```ts
    // Keep the chronological view for occupancy accounting (Task 8 uses it);
    // the model view collapses everything a compaction checkpoint covers.
    const chronologicalMessages = messages;
    messages = sliceHistoryAtCheckpoint(chronologicalMessages);
```

(`chronologicalMessages` is unused until Task 8 — add `void chronologicalMessages;` on the next line to keep lint quiet, removed in Task 8.)

- [ ] **Step 4: Update the generateSync caller** (provider.ts:344-358)

```ts
      const previousMessages = await getAgentMessages({
        session,
        user: user.id,
      });

      const previousMessagesContent = previousMessages.map((message) =>
        JSON.parse(message.content),
      );
      // validate messages
      messages = await validateUIMessages({
        // append the new message to the previous messages:
        messages: [...previousMessagesContent, ...messages],
      });
      messages = sliceHistoryAtCheckpoint(messages);
```

- [ ] **Step 5: Type-check + full test run**

```bash
npm run type-check && npm test
```
Expected: clean/PASS.

- [ ] **Step 6: Commit**

```bash
git add src/exulu/provider.ts
git commit -m "feat(context): ordered full-history loading with checkpoint-aware model view"
```

---

### Task 8: Pre-flight budget gate + structured error surfaces + active-stream tracking

**Files:**
- Create: `src/exulu/active-streams.ts`
- Modify: `src/exulu/provider.ts` (gate in generateStream + generateSync; thread `contextWindow` param; thread into tool conversion)
- Modify: `src/exulu/routes.ts` (resolve window; 413 on gate error; map stream errors; mark/clear active streams)
- Test: `src/exulu/active-streams.test.ts`

**Interfaces:**
- Consumes: Task 1 (`deriveContextBudget`, `contextOccupancy`, `ContextCompactionRequiredError`, `mapStreamErrorMessage`), Task 2 (`resolveContextWindow`).
- Produces:
  - `markStreamActive(sessionID: string): void`, `clearStreamActive(sessionID: string): void`, `isStreamActive(sessionID: string): boolean` from `./active-streams` (in-memory, best-effort — used by the compact route in Task 11).
  - `generateStream` and `generateSync` accept a new optional param `contextWindow?: number` and throw `ContextCompactionRequiredError` when chronological occupancy ≥ `blockThreshold`.
  - The run route returns HTTP **413** with `err.message` (the JSON string) as the plain-text body for that error; mid-stream provider context errors reach the client as `mapStreamErrorMessage(...)` output.

- [ ] **Step 1: Write the failing test for active-streams**

Create `src/exulu/active-streams.test.ts`:

```ts
import { markStreamActive, clearStreamActive, isStreamActive } from "./active-streams";

describe("active-streams", () => {
  it("tracks per-session stream activity idempotently", () => {
    expect(isStreamActive("s1")).toBe(false);
    markStreamActive("s1");
    markStreamActive("s1");
    expect(isStreamActive("s1")).toBe(true);
    expect(isStreamActive("s2")).toBe(false);
    clearStreamActive("s1");
    clearStreamActive("s1");
    expect(isStreamActive("s1")).toBe(false);
  });
});
```

Run: `npm test -- src/exulu/active-streams.test.ts` — Expected: FAIL (module not found).

- [ ] **Step 2: Implement `src/exulu/active-streams.ts`**

```ts
/**
 * Best-effort in-memory registry of sessions with a response mid-stream.
 * Used to 409 compaction while streaming. Single-process only by design —
 * the frontend also disables the control while streaming.
 */
const active = new Set<string>();

export const markStreamActive = (sessionID: string): void => {
  active.add(sessionID);
};

export const clearStreamActive = (sessionID: string): void => {
  active.delete(sessionID);
};

export const isStreamActive = (sessionID: string): boolean => active.has(sessionID);
```

Run: `npm test -- src/exulu/active-streams.test.ts` — Expected: PASS.

- [ ] **Step 3: Gate in `generateStream`**

In `src/exulu/provider.ts`:
- Add to the imports from `./context-budget`: `deriveContextBudget, contextOccupancy, ContextCompactionRequiredError`.
- Add `contextWindow?: number;` to BOTH the `generateStream` and `generateSync` params types, and destructure it.
- In `generateStream`, replace the Task 7 placeholder (`void chronologicalMessages;`) so the block after `processFilePartsInMessages` reads:

```ts
    // Keep the chronological view for occupancy accounting; the model view
    // collapses everything a compaction checkpoint covers.
    const chronologicalMessages = messages;

    // Pre-flight budget gate (spec §3): never send a prompt past 95% of the
    // usable window — fail fast with the structured compaction-required error.
    const contextBudget = deriveContextBudget(contextWindow);
    const occupancy = contextOccupancy(chronologicalMessages);
    if (occupancy >= contextBudget.blockThreshold) {
      console.warn(
        `[EXULU] Blocking request: occupancy ${occupancy} >= blockThreshold ${contextBudget.blockThreshold} (window ${contextBudget.contextWindow}).`,
      );
      throw new ContextCompactionRequiredError(occupancy, contextBudget);
    }

    messages = sliceHistoryAtCheckpoint(chronologicalMessages);
```

- In `generateSync`, after the `messages = sliceHistoryAtCheckpoint(messages)` line from Task 7, insert the same gate BEFORE the slice (gate on the pre-slice chronological array):

```ts
      const contextBudget = deriveContextBudget(contextWindow);
      const occupancy = contextOccupancy(messages);
      if (occupancy >= contextBudget.blockThreshold) {
        throw new ContextCompactionRequiredError(occupancy, contextBudget);
      }
      messages = sliceHistoryAtCheckpoint(messages);
```

- Pass `contextWindow` as the new final argument to all three `convertExuluToolsToAiSdkTools(...)` calls in provider.ts (replacing the Task 6 `undefined` placeholders).

- [ ] **Step 4: Thread the window + handle the gate error in the run route**

In `src/exulu/routes.ts`:
- Imports: add
```ts
import { resolveContextWindow } from "./resolve-context-window";
import { ContextCompactionRequiredError, mapStreamErrorMessage } from "./context-budget";
import { markStreamActive, clearStreamActive } from "./active-streams";
```
- After the `resolveModel` try/catch in `registerAgentRunRoute` (after line ~772, `const resolvedModelId = resolved.model.id;`) add:
```ts
      const contextWindow = await resolveContextWindow({
        modelId: resolved.model.id,
        exuluProvider: isLiteLLMEnabled() ? undefined : resolved.exuluProvider,
      });
```
(`isLiteLLMEnabled` is already imported in routes.ts — verify with `grep -n "isLiteLLMEnabled" src/exulu/routes.ts`.)
- Wrap the `provider.generateStream({...})` call (line ~807) — same argument object as today plus `contextWindow`:
```ts
        if (headers.session) markStreamActive(headers.session);
        let result: Awaited<ReturnType<typeof provider.generateStream>>;
        try {
          result = await provider.generateStream({
            contexts: contexts,
            agent: agent,
            user,
            instructions: instructions,
            session: headers.session as string,
            message,
            previousMessages,
            currentTools: enabledTools,
            currentSkills: enabledSkills,
            approvedTools: approvedTools,
            allExuluTools: tools,
            languageModel: resolvedLanguageModel,
            providerapikey,
            toolConfigs: agent.tools,
            exuluConfig: config,
            req: req,
            contextWindow,
          });
        } catch (err) {
          if (headers.session) clearStreamActive(headers.session);
          if (err instanceof ContextCompactionRequiredError) {
            // Body is the JSON string; the AI SDK transport surfaces it as
            // err.message on the client.
            res.status(413).send(err.message);
            return;
          }
          throw err;
        }
```
- In the `pipeUIMessageStreamToResponse` options:
  - `onError`: wrap the final returned string: change the four `return ...` statements to build a `message` string and end with `return mapStreamErrorMessage(message);`:
```ts
          onError: (error) => {
            console.error("[EXULU] chat response error.", error);
            if (headers.session) clearStreamActive(headers.session);
            let message: string;
            if (error == null) message = "unknown error";
            else if (typeof error === "string") message = error;
            else if (error instanceof Error) message = error.message;
            else message = JSON.stringify(error);
            return mapStreamErrorMessage(message);
          },
```
  - `onFinish`: first line inside the callback: `if (headers.session) clearStreamActive(headers.session);`
- In the non-stream branch, wrap `provider.generateSync({...})` in try/catch → `res.status(413).send(err.message)` for `ContextCompactionRequiredError`; add `contextWindow,` to its args.

- [ ] **Step 5: Type-check + full tests**

```bash
npm run type-check && npm test
```
Expected: clean/PASS.

- [ ] **Step 6: Commit**

```bash
git add src/exulu/active-streams.ts src/exulu/active-streams.test.ts src/exulu/provider.ts src/exulu/routes.ts
git commit -m "feat(context): pre-flight budget gate with structured 413 + mid-stream error mapping"
```

---

### Task 9: In-flight `prepareStep` context guard

**Files:**
- Create: `src/exulu/context-guard.ts`
- Test: `src/exulu/context-guard.test.ts`
- Modify: `src/exulu/provider.ts` (3 `prepareStep:` sites)

**Interfaces:**
- Consumes: `deriveContextBudget`, `estimateTokens` (Task 1); `finalAnswerGuard` (existing, `src/exulu/resolve-max-steps.ts:79` — returns `{ toolChoice, activeTools, messages } | undefined`).
- Produces:
  - `type PrepareStepFn = (opts: { stepNumber: number; messages?: unknown[] }) => Promise<Record<string, unknown> | undefined> | Record<string, unknown> | undefined`
  - `composePrepareSteps(...guards: PrepareStepFn[]): PrepareStepFn` — runs guards in order, threading any returned `messages` into the next guard, shallow-merging the returned overrides.
  - `contextGuard(contextWindow?: number): PrepareStepFn` — when the serialized step messages exceed `usableWindow`, collapses tool-result outputs in all but the last 2 `role: "tool"` messages down to their first 400 chars + a collapse marker (the offload notice from Task 4 leads the object, so the session-file pointer survives).

- [ ] **Step 1: Write the failing test**

Create `src/exulu/context-guard.test.ts`:

```ts
import { contextGuard, composePrepareSteps } from "./context-guard";

const toolMsg = (text: string) => ({
  role: "tool",
  content: [{ type: "tool-result", toolCallId: "c1", toolName: "web_search", output: { type: "text", value: text } }],
});

describe("contextGuard", () => {
  it("returns undefined while the step messages fit", async () => {
    const guard = contextGuard(128_000);
    await expect(guard({ stepNumber: 1, messages: [toolMsg("small")] })).resolves.toBeUndefined();
  });

  it("collapses older tool results but keeps the last two tool messages intact", async () => {
    const guard = contextGuard(1_000); // usable 800 tokens → tiny
    const big = "x".repeat(5_000);
    const messages = [toolMsg(big), toolMsg(big), toolMsg(big), { role: "user", content: "q" }];
    const result = (await guard({ stepNumber: 2, messages })) as { messages: typeof messages };
    expect(result).toBeDefined();
    const outputs = result.messages
      .filter((m) => m.role === "tool")
      .map((m) => (m.content as Array<{ output: { value: string } }>)[0]!.output.value);
    expect(outputs[0]!.length).toBeLessThan(600);
    expect(outputs[0]).toContain("collapsed mid-response");
    expect(outputs[1]).toBe(big);
    expect(outputs[2]).toBe(big);
  });

  it("returns undefined when there is nothing collapsible", async () => {
    const guard = contextGuard(1_000);
    const messages = [toolMsg("x".repeat(5_000)), { role: "user", content: "q" }];
    await expect(guard({ stepNumber: 1, messages })).resolves.toBeUndefined();
  });
});

describe("composePrepareSteps", () => {
  it("threads messages between guards and merges overrides", async () => {
    const first = () => ({ messages: [{ role: "user", content: "rewritten" }] });
    const second = (opts: { messages?: unknown[] }) => ({
      toolChoice: "none",
      seen: (opts.messages as Array<{ content: string }>)[0]!.content,
    });
    const composed = composePrepareSteps(first, second);
    const result = (await composed({ stepNumber: 0, messages: [{ role: "user", content: "orig" }] })) as Record<string, unknown>;
    expect(result.toolChoice).toBe("none");
    expect(result.seen).toBe("rewritten");
    expect((result.messages as Array<{ content: string }>)[0]!.content).toBe("rewritten");
  });

  it("returns undefined when no guard fires", async () => {
    const composed = composePrepareSteps(() => undefined, () => undefined);
    await expect(composed({ stepNumber: 0, messages: [] })).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
npm test -- src/exulu/context-guard.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/exulu/context-guard.ts`**

```ts
import { deriveContextBudget, estimateTokens } from "./context-budget";

export type PrepareStepFn = (opts: {
  stepNumber: number;
  messages?: unknown[];
}) => Promise<Record<string, unknown> | undefined> | Record<string, unknown> | undefined;

const KEEP_RECENT_TOOL_MESSAGES = 2;
const COLLAPSE_KEEP_CHARS = 400;
const COLLAPSE_MARKER = " …[older tool output collapsed mid-response to fit the context window — the full output is in the session file named in the notice above, if one was saved]";

/**
 * In-flight microcompaction (spec §2, mid-response overflow): when a step's
 * accumulated messages approach the usable window, collapse tool results in
 * all but the most recent tool messages. Restorable — guarded outputs from
 * Task 4 lead with their session-file pointer, which survives the first
 * COLLAPSE_KEEP_CHARS characters.
 */
export function contextGuard(contextWindow?: number): PrepareStepFn {
  const budget = deriveContextBudget(contextWindow);
  return ({ messages }) => {
    if (!Array.isArray(messages) || messages.length === 0) return undefined;
    const tokens = estimateTokens(JSON.stringify(messages));
    if (tokens < budget.usableWindow) return undefined;

    const toolIndices = messages
      .map((m, i) => ((m as { role?: string })?.role === "tool" ? i : -1))
      .filter((i) => i !== -1);
    const collapsible = new Set(toolIndices.slice(0, Math.max(0, toolIndices.length - KEEP_RECENT_TOOL_MESSAGES)));
    if (collapsible.size === 0) return undefined;

    let changed = false;
    const next = messages.map((m, i) => {
      if (!collapsible.has(i)) return m;
      const msg = m as { content?: unknown };
      if (!Array.isArray(msg.content)) return m;
      const content = msg.content.map((part) => {
        const p = part as { type?: string; output?: { value?: unknown } };
        if (p?.type !== "tool-result") return part;
        const out = p.output?.value ?? p.output;
        const asText = typeof out === "string" ? out : JSON.stringify(out ?? "");
        if (asText.length <= COLLAPSE_KEEP_CHARS + COLLAPSE_MARKER.length) return part;
        changed = true;
        return { ...(part as object), output: { type: "text", value: asText.slice(0, COLLAPSE_KEEP_CHARS) + COLLAPSE_MARKER } };
      });
      return { ...(m as object), content };
    });
    return changed ? { messages: next as never } : undefined;
  };
}

/**
 * Compose prepareStep guards: each runs in order, sees the previous guard's
 * rewritten messages, and later overrides win on shallow-merged keys.
 */
export function composePrepareSteps(...guards: PrepareStepFn[]): PrepareStepFn {
  return async (opts) => {
    let merged: Record<string, unknown> | undefined;
    let messages = opts.messages;
    for (const guard of guards) {
      const result = await guard({ ...opts, messages });
      if (!result) continue;
      merged = { ...(merged ?? {}), ...result };
      if (Array.isArray((result as { messages?: unknown[] }).messages)) {
        messages = (result as { messages: unknown[] }).messages;
      }
    }
    if (merged && messages && !("messages" in merged)) {
      // preserve threading even if only an earlier guard rewrote messages
      merged.messages = messages;
    }
    return merged;
  };
}
```

- [ ] **Step 4: Run to verify pass**

```bash
npm test -- src/exulu/context-guard.test.ts
```
Expected: PASS.

- [ ] **Step 5: Wire into provider.ts**

Import in provider.ts: `import { contextGuard, composePrepareSteps } from "./context-guard";`

Replace the three `prepareStep:` values:
- generateSync prompt path (line ~557): `prepareStep: composePrepareSteps(contextGuard(contextWindow), finalAnswerGuard(maxStepCount ?? resolveMaxStepsFromToolConfigs(toolConfigs) ?? 5)) as never,`
- generateSync messages path (line ~642): same expression.
- generateStream (line ~1143): `prepareStep: composePrepareSteps(contextGuard(contextWindow), finalAnswerGuard(maxStepCount ?? resolveMaxStepsFromToolConfigs(toolConfigs) ?? (currentSkills?.length ? 10 : 5))) as never,`

(The `as never` matches the existing cast style if TS complains about the AI SDK's PrepareStepFunction type; drop it if it compiles without.)

- [ ] **Step 6: Type-check + tests, commit**

```bash
npm run type-check && npm test
git add src/exulu/context-guard.ts src/exulu/context-guard.test.ts src/exulu/provider.ts
git commit -m "feat(context): in-flight prepareStep guard collapses older tool results mid-response"
```

---

### Task 10: `compact-session.ts` — summarize + checkpoint

**Files:**
- Create: `src/exulu/compact-session.ts`
- Test: `src/exulu/compact-session.test.ts`

**Interfaces:**
- Consumes: `getAgentMessages`, `saveChat` (exported from `./provider` — Task 7 exported getAgentMessages; saveChat is already exported); Task 1 helpers; `truncateToolOutput` (Task 3); `generateText`, `validateUIMessages` from `ai`.
- Produces:
  - `class CompactionInsufficientError extends Error` (message = JSON string with `code: COMPACTION_INSUFFICIENT`)
  - `splitTail(messages: UIMessage[], tailTokenBudget: number): { head: UIMessage[]; tail: UIMessage[] }` — tail = longest suffix within budget, minimum 2 messages (or all if fewer).
  - `serializeForSummary(messages: UIMessage[]): string`
  - `compactSession(args: { sessionID: string; user: User; languageModel: LanguageModel; contextWindow: number; steer?: string; modelId?: string; summarize?: (a: { system: string; prompt: string; maxOutputTokens: number }) => Promise<string> }): Promise<{ checkpoint: UIMessage; occupancyEstimate: number; originalTokens: number; summaryTokens: number }>` — inserts the checkpoint row via `saveChat` before returning.

- [ ] **Step 1: Write the failing test**

Create `src/exulu/compact-session.test.ts`:

```ts
import type { UIMessage } from "ai";
import { splitTail, serializeForSummary, compactSession, CompactionInsufficientError } from "./compact-session";
import { getCompaction, COMPACTION_INSUFFICIENT } from "./context-budget";
import type { User } from "@EXULU_TYPES/models/user";
import type { LanguageModel } from "ai";

jest.mock("./provider", () => ({
  getAgentMessages: jest.fn(),
  saveChat: jest.fn().mockResolvedValue(undefined),
}));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const providerMock = require("./provider") as { getAgentMessages: jest.Mock; saveChat: jest.Mock };

const msg = (role: "user" | "assistant", body: string, metadata?: object): UIMessage =>
  ({ id: `m_${Math.random().toString(36).slice(2)}`, role, parts: [{ type: "text", text: body }], ...(metadata ? { metadata } : {}) }) as UIMessage;

const user = { id: 1 } as User;
const languageModel = {} as LanguageModel;

afterEach(() => jest.clearAllMocks());

describe("splitTail", () => {
  it("keeps the longest suffix under the budget, minimum 2 messages", () => {
    const messages = [msg("user", "a".repeat(4_000)), msg("assistant", "b".repeat(4_000)), msg("user", "c"), msg("assistant", "d")];
    const { head, tail } = splitTail(messages, 200);
    expect(tail.length).toBe(2);
    expect(tail.map((m) => m.id)).toEqual([messages[2]!.id, messages[3]!.id]);
    expect(head.length).toBe(2);
  });

  it("keeps everything as tail when the whole history fits", () => {
    const messages = [msg("user", "a"), msg("assistant", "b")];
    const { head, tail } = splitTail(messages, 100_000);
    expect(head).toEqual([]);
    expect(tail.length).toBe(2);
  });
});

describe("serializeForSummary", () => {
  it("renders roles, text, and sliced tool parts", () => {
    const withTool = {
      ...msg("assistant", ""),
      parts: [
        { type: "tool-web_search", input: { q: "elevators" }, output: { value: "r".repeat(5_000) } },
        { type: "text", text: "done" },
      ],
    } as unknown as UIMessage;
    const out = serializeForSummary([msg("user", "hi"), withTool]);
    expect(out).toContain("USER:\nhi");
    expect(out).toContain("ASSISTANT:");
    expect(out).toContain("[tool tool-web_search:");
    expect(out.length).toBeLessThan(3_000); // tool output sliced to 1500 chars
  });
});

describe("compactSession", () => {
  const bigHistory = () => {
    // 20 fat turns + 2 small recent ones; window 10K → tail budget ~800 tokens
    const rows: Array<{ content: string }> = [];
    for (let i = 0; i < 20; i++) {
      rows.push({ content: JSON.stringify(msg("user", `question ${i} ` + "x".repeat(2_000))) });
      rows.push({ content: JSON.stringify(msg("assistant", `answer ${i} ` + "y".repeat(2_000))) });
    }
    rows.push({ content: JSON.stringify(msg("user", "recent question")) });
    rows.push({ content: JSON.stringify(msg("assistant", "recent answer")) });
    return rows;
  };

  it("summarizes the head, saves and returns a checkpoint message", async () => {
    providerMock.getAgentMessages.mockResolvedValue(bigHistory());
    const summarize = jest.fn().mockResolvedValue("Dense summary of the work so far.");
    const result = await compactSession({
      sessionID: "s1",
      user,
      languageModel,
      contextWindow: 10_000,
      steer: "keep the exact figures",
      summarize,
    });
    expect(summarize).toHaveBeenCalledTimes(1);
    expect(summarize.mock.calls[0]![0].system).toContain("Focus especially on: keep the exact figures");
    const compaction = getCompaction(result.checkpoint)!;
    expect(compaction).toBeDefined();
    expect(compaction.occupancyEstimate).toBe(result.occupancyEstimate);
    expect(compaction.steer).toBe("keep the exact figures");
    expect(result.checkpoint.role).toBe("user");
    expect((result.checkpoint.parts![0] as { text: string }).text).toContain("[Conversation summary — earlier messages were compacted]");
    expect(providerMock.saveChat).toHaveBeenCalledWith(
      expect.objectContaining({ session: "s1", user: 1, messages: [result.checkpoint] }),
    );
    // coversUpTo marks the last HEAD message — never one of the tail messages.
    expect(compaction.coversUpTo).toBeTruthy();
    expect(compaction.coversUpTo).not.toBe(result.checkpoint.id);
  });

  it("throws CompactionInsufficientError when there is nothing to compact", async () => {
    providerMock.getAgentMessages.mockResolvedValue([
      { content: JSON.stringify(msg("user", "hi")) },
      { content: JSON.stringify(msg("assistant", "hello")) },
    ]);
    await expect(
      compactSession({ sessionID: "s1", user, languageModel, contextWindow: 200_000, summarize: jest.fn() }),
    ).rejects.toThrow(CompactionInsufficientError);
    expect(providerMock.saveChat).not.toHaveBeenCalled();
  });

  it("throws CompactionInsufficientError when the result still exceeds the block threshold", async () => {
    providerMock.getAgentMessages.mockResolvedValue(bigHistory());
    // Summary so large it cannot help (summarize stub ignores maxOutputTokens).
    const summarize = jest.fn().mockResolvedValue("s".repeat(80_000));
    await expect(
      compactSession({ sessionID: "s1", user, languageModel, contextWindow: 10_000, summarize }),
    ).rejects.toThrow(COMPACTION_INSUFFICIENT);
    expect(providerMock.saveChat).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
npm test -- src/exulu/compact-session.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/exulu/compact-session.ts`**

```ts
import { randomUUID } from "node:crypto";
import { generateText, validateUIMessages, type LanguageModel, type UIMessage } from "ai";
import type { User } from "@EXULU_TYPES/models/user";
import { truncateToolOutput } from "@SRC/utils/truncate-tool-output";
import { getAgentMessages, saveChat } from "./provider";
import {
  COMPACTION_INSUFFICIENT,
  deriveContextBudget,
  estimateMessageTokens,
  estimateTokens,
  sliceHistoryAtCheckpoint,
  type CompactionMetadata,
} from "./context-budget";

export class CompactionInsufficientError extends Error {
  constructor(reason: string) {
    super(JSON.stringify({ code: COMPACTION_INSUFFICIENT, message: reason }));
    this.name = "CompactionInsufficientError";
  }
}

const MIN_TAIL_MESSAGES = 2;
const SUMMARY_TOOL_OUTPUT_SLICE = 1_500;
const SUMMARY_TOOL_INPUT_SLICE = 200;

const SUMMARY_SYSTEM = `You compress chat histories for an AI assistant. Produce a dense, factual summary of the conversation below. Preserve:
- the user's intent and any outstanding requests
- key facts, decisions, and constraints
- files, artifacts, and session files touched — ALWAYS keep exact file and item names so they stay retrievable
- errors encountered and how they were resolved
- pending tasks and the current state of the work
Do not invent information. Do not include pleasantries. Write compact prose or bullet points.`;

/** Tail = the longest suffix that fits the budget; never fewer than MIN_TAIL_MESSAGES. */
export const splitTail = (
  messages: UIMessage[],
  tailTokenBudget: number,
): { head: UIMessage[]; tail: UIMessage[] } => {
  const minTail = Math.min(MIN_TAIL_MESSAGES, messages.length);
  let cut = messages.length;
  let tokens = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const t = estimateMessageTokens(messages[i]!);
    const tailCount = messages.length - i;
    if (tailCount > minTail && tokens + t > tailTokenBudget) break;
    tokens += t;
    cut = i;
  }
  return { head: messages.slice(0, cut), tail: messages.slice(cut) };
};

/** Plain-text rendering of UIMessages for the summarizer prompt. */
export const serializeForSummary = (messages: UIMessage[]): string =>
  messages
    .map((m) => {
      const parts = (m.parts ?? [])
        .map((part) => {
          const p = part as {
            type?: string;
            text?: string;
            input?: unknown;
            output?: { value?: unknown } | unknown;
            filename?: string;
            url?: string;
          };
          if (p.type === "text") return p.text ?? "";
          if (p.type === "file") return `[file: ${p.filename ?? p.url ?? "attachment"}]`;
          if (p.type === "reasoning" || p.type === "step-start") return "";
          if (p.type?.startsWith("tool-") || p.type === "dynamic-tool") {
            const out = (p.output as { value?: unknown } | undefined)?.value ?? p.output;
            const outText = typeof out === "string" ? out : JSON.stringify(out ?? "");
            return `[tool ${p.type}: ${JSON.stringify(p.input ?? {}).slice(0, SUMMARY_TOOL_INPUT_SLICE)}] → ${outText.slice(0, SUMMARY_TOOL_OUTPUT_SLICE)}`;
          }
          return "";
        })
        .filter(Boolean)
        .join("\n");
      return `${m.role.toUpperCase()}:\n${parts}`;
    })
    .join("\n\n");

/**
 * Compact a session (spec §4): summarize everything before the verbatim tail
 * into a checkpoint message row. The checkpoint's metadata.compaction marks
 * coversUpTo; sliceHistoryAtCheckpoint (context-budget.ts) assembles the model
 * view as [checkpoint, ...messages newer than coversUpTo].
 */
export const compactSession = async ({
  sessionID,
  user,
  languageModel,
  contextWindow,
  steer,
  modelId,
  summarize,
}: {
  sessionID: string;
  user: User;
  languageModel: LanguageModel;
  contextWindow: number;
  steer?: string;
  modelId?: string;
  summarize?: (args: { system: string; prompt: string; maxOutputTokens: number }) => Promise<string>;
}): Promise<{ checkpoint: UIMessage; occupancyEstimate: number; originalTokens: number; summaryTokens: number }> => {
  const budget = deriveContextBudget(contextWindow);
  const rows = await getAgentMessages({ session: sessionID, user: user.id });
  const all = await validateUIMessages({ messages: rows.map((r: { content: string }) => JSON.parse(r.content)) });
  // Only what the model currently sees is compactable — prior checkpoints
  // already collapsed everything before them.
  const history = sliceHistoryAtCheckpoint(all as UIMessage[]);
  const { head, tail } = splitTail(history, budget.compactionTailTokens);
  if (head.length === 0) {
    throw new CompactionInsufficientError(
      "There is nothing left to compact — the recent messages already form the whole context. Start a new chat instead.",
    );
  }

  let corpus = serializeForSummary(head);
  const originalTokens = estimateTokens(corpus);
  // The summarization call itself must fit the window: head+tail split keeps
  // the notice-bearing prefixes, hard head/tail-truncate the middle if needed.
  corpus = truncateToolOutput(corpus, contextWindow, "history", 0.3, Math.floor(budget.usableWindow * 0.8) * 4);

  const system = steer?.trim() ? `${SUMMARY_SYSTEM}\n\nFocus especially on: ${steer.trim()}` : SUMMARY_SYSTEM;
  const doSummarize =
    summarize ??
    (async ({ system: sys, prompt, maxOutputTokens }: { system: string; prompt: string; maxOutputTokens: number }) => {
      const { text } = await generateText({
        model: languageModel,
        system: sys,
        prompt,
        temperature: 0,
        maxRetries: 2,
        maxOutputTokens,
      });
      return text;
    });

  const summary = await doSummarize({ system, prompt: corpus, maxOutputTokens: budget.summaryBudgetTokens });
  const summaryTokens = estimateTokens(summary);
  let tailTokens = 0;
  for (const m of tail) tailTokens += estimateMessageTokens(m);
  const occupancyEstimate = summaryTokens + tailTokens;

  if (occupancyEstimate >= budget.blockThreshold) {
    throw new CompactionInsufficientError(
      "Compacting cannot shrink this conversation below the context limit — a recent message or output is too large by itself. Start a new chat.",
    );
  }

  const compaction: CompactionMetadata = {
    coversUpTo: head[head.length - 1]!.id,
    originalTokens,
    summaryTokens,
    occupancyEstimate,
    ...(steer?.trim() ? { steer: steer.trim() } : {}),
  };
  const checkpoint = {
    id: `compaction_${randomUUID()}`,
    role: "user",
    parts: [{ type: "text", text: `[Conversation summary — earlier messages were compacted]\n\n${summary}` }],
    metadata: { compaction },
  } as unknown as UIMessage;

  await saveChat({ session: sessionID, user: user.id, messages: [checkpoint], ...(modelId ? { model: modelId } : {}) });
  return { checkpoint, occupancyEstimate, originalTokens, summaryTokens };
};
```

- [ ] **Step 4: Run to verify pass**

```bash
npm test -- src/exulu/compact-session.test.ts
```
Expected: PASS. (If `validateUIMessages` rejects the minimal test messages, check its error and adjust the test factory — the shape `{ id, role, parts: [{type:"text",text}] }` matches what the app itself persists.)

- [ ] **Step 5: Commit**

```bash
git add src/exulu/compact-session.ts src/exulu/compact-session.test.ts
git commit -m "feat(context): steerable session compaction producing a checkpoint message"
```

---

### Task 11: Compact route, gateway window threading, system-prompt hint

**Files:**
- Modify: `src/exulu/routes.ts` (new `registerAgentCompactRoute` + registrations)
- Modify: `src/exulu/openai-gateway.ts` (resolve window; pre-check; pass to tool conversion)
- Modify: `src/exulu/provider.ts` (system-prompt hint about truncated outputs)

**Interfaces:**
- Consumes: `compactSession`, `CompactionInsufficientError` (Task 10); `isStreamActive` (Task 8); `resolveContextWindow` (Task 2); `deriveContextBudget`, `estimateTokens` (Task 1); existing route helpers (`requestValidators`, `checkRecordAccess`, `resolveModel`, `ResolveModelError`, `exuluApp`, `postgresClient`, `isLiteLLMEnabled`).
- Produces:
  - `POST /agents/<agent-name-slug>/compact/:instance` (per code-defined provider) and `POST /agents/litellm/compact/:instance` (LiteLLM mode). Headers: `session` (required), `user`, `Authorization`, optional `x-exulu-model-override`. Body: `{ steer?: string }`. Responses: `200 { checkpoint, occupancyEstimate, originalTokens, summaryTokens }`, `409` while streaming, `422` with the `COMPACTION_INSUFFICIENT` JSON string body, `4xx` auth/validation.
  - Gateway: `400` OpenAI-style error `code: "context_length_exceeded"` when the incoming messages exceed the block threshold.

- [ ] **Step 1: Add the compact route to routes.ts**

Imports (extend the Task 8 import lines):
```ts
import { compactSession, CompactionInsufficientError } from "./compact-session";
import { isStreamActive } from "./active-streams";
```

Insert after `registerAgentRunRoute`'s definition (after line ~966):

```ts
  // Compaction endpoint (spec §4) — sibling of the run route. Summarizes the
  // session's older history into a checkpoint message and returns it.
  const registerAgentCompactRoute = (slug: string) => {
    app.post(slug + "/:instance", async (req: Request, res: Response) => {
      const instance = req.params.instance;
      if (!instance) {
        res.status(400).json({ message: "Missing instance in request." });
        return;
      }
      const sessionID = (req.headers["session"] as string) || null;
      if (!sessionID) {
        res.status(400).json({ message: "Missing session header." });
        return;
      }
      const agent = await exuluApp.get().agent(instance);
      if (!agent) {
        res.status(404).json({ message: "Agent with id " + instance + " not found." });
        return;
      }
      const authenticationResult = await requestValidators.authenticate(req);
      if (!authenticationResult.user?.id) {
        res.status(authenticationResult.code || 401).json({ detail: `${authenticationResult.message}` });
        return;
      }
      const user = authenticationResult.user;
      const hasAccessToAgent = await checkRecordAccess(agent, "read", user);
      if (!hasAccessToAgent) {
        res.status(401).json({ message: "You don't have access to this agent." });
        return;
      }
      const { db } = await postgresClient();
      const sessionRow = await db.from("agent_sessions").where({ id: sessionID }).first();
      const hasAccessToSession = await checkRecordAccess(sessionRow, "write", user);
      if (!hasAccessToSession) {
        res.status(401).json({ message: "You don't have access to this session." });
        return;
      }
      if (isStreamActive(sessionID)) {
        res.status(409).json({ message: "A response is still streaming for this session — try again when it finishes." });
        return;
      }
      const overrideModelId = req.headers["x-exulu-model-override"] as string | undefined;
      const modelId = overrideModelId ?? agent.model;
      if (!modelId) {
        res.status(400).json({ message: `Agent ${agent.name} (${agent.id}) has no model configured.` });
        return;
      }
      let resolved: Awaited<ReturnType<typeof resolveModel>>;
      try {
        resolved = await resolveModel({ modelId, user, providers, agent });
      } catch (err) {
        if (err instanceof ResolveModelError) {
          const status = err.code === "MODEL_FORBIDDEN" ? 403 : 400;
          res.status(status).json({ message: err.message, code: err.code });
          return;
        }
        throw err;
      }
      const contextWindow = await resolveContextWindow({
        modelId: resolved.model.id,
        exuluProvider: isLiteLLMEnabled() ? undefined : resolved.exuluProvider,
      });
      const steer = typeof req.body?.steer === "string" ? req.body.steer : undefined;
      try {
        const result = await compactSession({
          sessionID,
          user,
          languageModel: resolved.languageModel,
          contextWindow,
          steer,
          modelId: resolved.model.id,
        });
        res.json(result);
      } catch (err) {
        if (err instanceof CompactionInsufficientError) {
          res.status(422).send(err.message);
          return;
        }
        console.error("[EXULU] compactSession failed.", err);
        res.status(500).json({ message: err instanceof Error ? err.message : "Compaction failed." });
      }
    });
  };
```

Register next to the run-route registrations (after line ~980):
```ts
  providers.forEach((provider) => {
    const slug = provider.slug as string;
    if (!slug) return;
    registerAgentCompactRoute(slug.replace(/\/run$/, "/compact"));
  });
  if (isLiteLLMEnabled() && providers.length > 0) {
    registerAgentCompactRoute("/agents/litellm/compact");
  }
```

- [ ] **Step 2: Gateway — resolve window, pre-check, thread to tools**

In `src/exulu/openai-gateway.ts`:
- Imports:
```ts
import { resolveContextWindow } from "./resolve-context-window";
import { deriveContextBudget, estimateTokens } from "./context-budget";
import { isLiteLLMEnabled } from "./litellm/supervisor";
```
(Verify the `isLiteLLMEnabled` import path with `grep -rn "export const isLiteLLMEnabled" src/`.)
- After the `resolveModel` try/catch (line ~420):
```ts
        const contextWindow = await resolveContextWindow({
          modelId: resolved.model.id,
          exuluProvider: isLiteLLMEnabled() ? undefined : resolved.exuluProvider,
        });
```
- Pass `contextWindow` as the new final argument (17th, after `agent` — insert `undefined` for `memoryItems` first) to the `convertExuluToolsToAiSdkTools(...)` call (line ~434): the call currently ends `..., languageModel, agent,)` — make it `..., languageModel, agent, undefined, contextWindow,)`.
- After `const { systemPrompt: requestSystemPrompt, coreMessages } = convertOpenAIMessagesToModelMessages(openaiMessages);` add the stateless pre-check (the gateway client owns its own history, so the correct behavior at overflow is an OpenAI-style 400, not a compaction offer):
```ts
        const gatewayBudget = deriveContextBudget(contextWindow);
        const promptTokens = estimateTokens(JSON.stringify(openaiMessages));
        if (promptTokens >= gatewayBudget.blockThreshold) {
          res.status(400).json({
            error: {
              message:
                `This request is ~${promptTokens.toLocaleString("en-US")} tokens, which exceeds the model's usable context ` +
                `window (${gatewayBudget.usableWindow.toLocaleString("en-US")} tokens). Reduce the conversation history.`,
              type: "invalid_request_error",
              code: "context_length_exceeded",
            },
          });
          return;
        }
```

- [ ] **Step 3: System-prompt hint in generateStream**

In `src/exulu/provider.ts` `generateStream`, extend the "Session files:" system block (line ~1084) — append inside the template string:
```
        Note on large outputs: oversized tool outputs and large uploaded documents are automatically
        truncated in the conversation; the FULL content is saved as a session file (named in the
        truncation notice, e.g. tool-output-*.txt). Use the read_session_file tool with offset/limit
        to page through it — do not ask the user to re-upload.
```

- [ ] **Step 4: Type-check + tests, commit**

```bash
npm run type-check && npm test
git add src/exulu/routes.ts src/exulu/openai-gateway.ts src/exulu/provider.ts
git commit -m "feat(context): compact endpoint, gateway context pre-check, prompt hint for offloaded outputs"
```

---

### Task 12: Cap + offload extracted document text

**Files:**
- Modify: `src/exulu/provider.ts` — `processFilePartsInMessages` (line ~703) and its call site (line ~944)

**Interfaces:**
- Consumes: `guardExtractedFileText` (Task 4).
- Produces: `processFilePartsInMessages(messages, offloadCtx: { contextWindow?: number; sessionID?: string; user?: User; exuluConfig?: ExuluConfig })` — document text over the tool cap becomes preview + session-file pointer instead of inline megabytes.

- [ ] **Step 1: Change the method signature**

```ts
  private async processFilePartsInMessages(
    messages: UIMessage[],
    offloadCtx: {
      contextWindow?: number;
      sessionID?: string;
      user?: User;
      exuluConfig?: ExuluConfig;
    },
  ): Promise<UIMessage[]> {
```
Import `guardExtractedFileText` from `./tool-output-offload` at the top of provider.ts.

- [ ] **Step 2: Guard the extraction** — replace the return after `parseOfficeAsync` (line ~757-766):

```ts
              const extractedText = await parseOfficeAsync(arrayBuffer, {
                outputErrorToConsole: false,
                newlineDelimiter: "\n",
              });

              // Cap + offload (spec §2): a 400-page manual becomes a session
              // file + preview instead of megabytes of inline prompt.
              const guardedText = await guardExtractedFileText(filename, String(extractedText), offloadCtx);

              // Return as text part with extracted content wrapped in XML-like tags
              return {
                type: "text",
                text: `<file file name = "${filename}" >\n${guardedText} \n </file>`,
              };
```

Also remove (or keep — reviewer's choice) the `console.log("[EXULU] Result: " + JSON.stringify(result, null, 2))` at line ~781: it prints the ENTIRE extracted document to the server log on every turn. Removing it is part of this fix.

- [ ] **Step 3: Update the call site** (generateStream, line ~944):

```ts
    messages = await this.processFilePartsInMessages(messages, {
      contextWindow,
      sessionID: session,
      user,
      exuluConfig,
    });
```

- [ ] **Step 4: Type-check + tests, commit**

```bash
npm run type-check && npm test
git add src/exulu/provider.ts
git commit -m "feat(context): cap + offload extracted document text from uploads"
```

---

## Frontend

### Task 13: Frontend budget/occupancy mirror

**Files:**
- Create: `app/(application)/chat/lib/context-budget.ts`
- Test: `app/(application)/chat/lib/context-budget.test.ts`

**Interfaces:**
- Consumes: `UIMessage` from `ai`.
- Produces (consumed by Tasks 14–16):
  - `type ContextBudget = { contextWindow: number; outputReserve: number; usableWindow: number; warnThreshold: number; blockThreshold: number }`
  - `deriveContextBudget(contextWindow: number): ContextBudget` (same formulas as backend; no default fallback — the UI hides the meter when the window is unknown)
  - `estimateTokens(text: string): number`
  - `type CompactionMetadata`, `getCompaction(message: UIMessage): CompactionMetadata | undefined` (same shapes as backend)
  - `computeContextOccupancy(messages: UIMessage[]): number` (sync mirror of backend `contextOccupancy`)
  - `type ContextState = "ok" | "warn" | "blocked"`
  - `deriveContextState(occupancy: number, budget: ContextBudget | null, serverBlocked: boolean): ContextState`
  - `CONTEXT_COMPACTION_REQUIRED`, `COMPACTION_INSUFFICIENT` string constants

- [ ] **Step 1: Create the branch**

```bash
cd /Users/daniel.claessen/Desktop/Projects/exulu/frontend
git checkout develop && git pull && git checkout -b feature/context-window-management
```

- [ ] **Step 2: Write the failing test**

Create `app/(application)/chat/lib/context-budget.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { UIMessage } from "ai";
import {
  deriveContextBudget,
  computeContextOccupancy,
  deriveContextState,
  getCompaction,
} from "./context-budget";

const msg = (role: "user" | "assistant", body: string, metadata?: object): UIMessage =>
  ({ id: `m_${Math.random().toString(36).slice(2)}`, role, parts: [{ type: "text", text: body }], ...(metadata ? { metadata } : {}) }) as UIMessage;

describe("deriveContextBudget", () => {
  it("matches the backend formulas for a 200K window", () => {
    const b = deriveContextBudget(200_000);
    expect(b.outputReserve).toBe(32_000);
    expect(b.usableWindow).toBe(168_000);
    expect(b.warnThreshold).toBe(134_400);
    expect(b.blockThreshold).toBe(159_600);
  });
});

describe("computeContextOccupancy", () => {
  it("anchors on the last assistant usage metadata", () => {
    const messages = [
      msg("user", "q"),
      msg("assistant", "a", { inputTokens: 50_000, outputTokens: 500, totalTokens: 50_500 }),
      msg("user", "x".repeat(4_000)),
    ];
    const occ = computeContextOccupancy(messages);
    expect(occ).toBeGreaterThan(50_500);
    expect(occ).toBeLessThan(53_000);
  });

  it("prefers a newer compaction checkpoint over stale usage", () => {
    const messages = [
      msg("assistant", "big", { inputTokens: 900_000, outputTokens: 100 }),
      msg("user", "[summary]", { compaction: { coversUpTo: "m", originalTokens: 900_000, summaryTokens: 2_000, occupancyEstimate: 9_000 } }),
    ];
    expect(computeContextOccupancy(messages)).toBe(9_000);
    expect(getCompaction(messages[1]!)).toBeDefined();
  });

  it("estimates chars/4 with no anchor", () => {
    expect(computeContextOccupancy([msg("user", "x".repeat(400))])).toBeGreaterThan(100);
  });
});

describe("deriveContextState", () => {
  const budget = deriveContextBudget(100_000); // usable 80K, warn 64K, block 76K
  it("maps occupancy to ok/warn/blocked", () => {
    expect(deriveContextState(10_000, budget, false)).toBe("ok");
    expect(deriveContextState(64_000, budget, false)).toBe("warn");
    expect(deriveContextState(76_000, budget, false)).toBe("blocked");
  });
  it("server block wins regardless of the estimate, and no budget means ok", () => {
    expect(deriveContextState(0, budget, true)).toBe("blocked");
    expect(deriveContextState(999_999, null, false)).toBe("ok");
  });
});
```

- [ ] **Step 3: Run to verify failure**

```bash
npm test -- app/\(application\)/chat/lib/context-budget.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 4: Implement `app/(application)/chat/lib/context-budget.ts`**

```ts
import type { UIMessage } from "ai";

/**
 * Frontend mirror of exulu/backend src/exulu/context-budget.ts — the formulas
 * MUST match byte-for-byte (spec: 2026-07-07-context-window-management).
 * chars/4 estimation; real per-turn usage metadata anchors the numbers.
 */

export type ContextBudget = {
  contextWindow: number;
  outputReserve: number;
  usableWindow: number;
  warnThreshold: number;
  blockThreshold: number;
};

export const deriveContextBudget = (contextWindow: number): ContextBudget => {
  const outputReserve = Math.min(32_000, Math.floor(contextWindow * 0.2));
  const usableWindow = contextWindow - outputReserve;
  return {
    contextWindow,
    outputReserve,
    usableWindow,
    warnThreshold: Math.floor(usableWindow * 0.8),
    blockThreshold: Math.floor(usableWindow * 0.95),
  };
};

export const estimateTokens = (text: string): number => (text ? Math.ceil(text.length / 4) : 0);

export type CompactionMetadata = {
  coversUpTo: string;
  originalTokens: number;
  summaryTokens: number;
  occupancyEstimate: number;
  steer?: string;
};

export const getCompaction = (message: UIMessage): CompactionMetadata | undefined =>
  (message.metadata as { compaction?: CompactionMetadata } | undefined)?.compaction;

export const computeContextOccupancy = (messages: UIMessage[]): number => {
  let anchorIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    const meta = m.metadata as { inputTokens?: number } | undefined;
    if (getCompaction(m) || (m.role === "assistant" && typeof meta?.inputTokens === "number")) {
      anchorIdx = i;
      break;
    }
  }
  let total = 0;
  let rest = messages;
  if (anchorIdx !== -1) {
    const anchor = messages[anchorIdx]!;
    const compaction = getCompaction(anchor);
    if (compaction) {
      total = compaction.occupancyEstimate;
    } else {
      const meta = anchor.metadata as { inputTokens?: number; outputTokens?: number };
      total = (meta.inputTokens ?? 0) + (meta.outputTokens ?? 0);
    }
    rest = messages.slice(anchorIdx + 1);
  }
  for (const m of rest) total += estimateTokens(JSON.stringify(m));
  return total;
};

export type ContextState = "ok" | "warn" | "blocked";

export const deriveContextState = (
  occupancy: number,
  budget: ContextBudget | null,
  serverBlocked: boolean,
): ContextState => {
  if (serverBlocked) return "blocked";
  if (!budget) return "ok";
  if (occupancy >= budget.blockThreshold) return "blocked";
  if (occupancy >= budget.warnThreshold) return "warn";
  return "ok";
};

export const CONTEXT_COMPACTION_REQUIRED = "CONTEXT_COMPACTION_REQUIRED";
export const COMPACTION_INSUFFICIENT = "COMPACTION_INSUFFICIENT";
```

- [ ] **Step 5: Run to verify pass, commit**

```bash
npm test -- app/\(application\)/chat/lib/context-budget.test.ts
git add app/\(application\)/chat/lib/context-budget.ts app/\(application\)/chat/lib/context-budget.test.ts
git commit -m "feat(chat): frontend context-budget mirror (occupancy, thresholds, states)"
```

---

### Task 14: Controller — window resolution, occupancy, compaction action, send-block

**Files:**
- Modify: `app/(application)/chat/hooks.ts`

**Interfaces:**
- Consumes: Task 13 exports; `GET_LITELLM_CATALOG` (already selects `max_input_tokens`/`max_tokens`, `queries.ts:410-431`); existing controller internals (`currentSessionRef`, `modelOverrideRef`, `setMessages`, `getToken`, `configContext`, `agent.slug`).
- Produces — additions to `ChatSessionController`:
  - `contextWindow: number | null` (override-aware)
  - `contextOccupancy: number`
  - `contextState: ContextState` (`"ok" | "warn" | "blocked"`)
  - `compacting: boolean`
  - `compactConversation: (steer?: string) => Promise<boolean>`

- [ ] **Step 1: Imports and interface**

Add to imports:
```ts
import {
  COMPACTION_INSUFFICIENT,
  CONTEXT_COMPACTION_REQUIRED,
  computeContextOccupancy,
  deriveContextBudget,
  deriveContextState,
  type ContextState,
} from "./lib/context-budget";
```
Extend `ChatSessionController` (after the `tokenCounts`/`maxInputLength` block):
```ts
  // context-window management (spec 2026-07-07)
  contextWindow: number | null;
  contextOccupancy: number;
  contextState: ContextState;
  compacting: boolean;
  compactConversation: (steer?: string) => Promise<boolean>;
```

- [ ] **Step 2: Window + occupancy + state inside `useChatSession`**

After the `managedContextEnabled` memo add:

```ts
  // --- context-window management -------------------------------------------
  const litellmCatalogQuery = useQuery(GET_LITELLM_CATALOG, {
    fetchPolicy: "cache-first",
  });

  const contextWindow = React.useMemo<number | null>(() => {
    if (modelOverride && modelOverride !== agent.model) {
      const entry = (litellmCatalogQuery.data?.litellmCatalog ?? []).find(
        (m: { model_name: string }) => m.model_name === modelOverride,
      );
      const w = entry?.max_input_tokens ?? entry?.max_tokens;
      if (typeof w === "number" && w > 0) return w;
    }
    return typeof agent.maxContextLength === "number" && agent.maxContextLength > 0
      ? agent.maxContextLength
      : null;
  }, [modelOverride, agent.model, agent.maxContextLength, litellmCatalogQuery.data]);

  const [serverContextBlocked, setServerContextBlocked] = React.useState(false);
  const [compacting, setCompacting] = React.useState(false);

  const contextOccupancy = React.useMemo(() => computeContextOccupancy(messages), [messages]);
  const contextBudget = contextWindow ? deriveContextBudget(contextWindow) : null;
  const contextState = deriveContextState(contextOccupancy, contextBudget, serverContextBlocked);
```

NOTE ON PLACEMENT: `messages` comes from the `useChat` call — place this block AFTER the `useChat` destructuring (i.e. after line ~345), not before. The two `useState` declarations must sit ABOVE the `useChat` call because its `onError` references `setServerContextBlocked` (Step 3).

Also update the composer input cap (spec §6 — it must derive from the real, override-aware window). Replace `hooks.ts:231-233`:
```ts
  // --- input budget (item 60): 80% of the REAL context window × ~4 chars/token
  const maxInputLength = contextWindow
    ? Math.floor(contextWindow * 0.8 * 4)
    : 50000;
```
(and move this line BELOW the `contextWindow` memo so it can reference it).

- [ ] **Step 3: Error-code mapping in `onError`**

In the existing `useChat` `onError` (line ~300), add as the FIRST statements:
```ts
      if (err?.message?.includes(CONTEXT_COMPACTION_REQUIRED)) {
        setServerContextBlocked(true);
        return; // dedicated blocked-composer state, not the generic alert
      }
```
(`setServerContextBlocked` is defined before `useChat`? No — state must be declared BEFORE the `useChat` call. Declare `const [serverContextBlocked, setServerContextBlocked] = React.useState(false);` and `const [compacting, setCompacting] = React.useState(false);` ABOVE the `useChat` call, and keep only the derived values below it.)

- [ ] **Step 4: Reset on session switch**

In the session-navigation reset effect (line ~348-361) add `setServerContextBlocked(false);` next to `clearError();`.

- [ ] **Step 5: Send-block**

At the top of `sendUserMessage` (after the `budgetExceeded` check):
```ts
    if (contextState === "blocked") {
      toast.error(t("context.blockedToastTitle"), {
        description: t("context.blockedToastDescription"),
      });
      return;
    }
```

- [ ] **Step 6: `compactConversation`**

Add after `sendQuestionAnswer`:

```ts
  // --- compaction (spec §4/§5) ------------------------------------------------
  const compactConversation = async (steer?: string): Promise<boolean> => {
    const session = currentSessionRef.current;
    if (!session || session.id === "new") return false;
    if (status === "streaming" || status === "submitted" || compacting) return false;
    setCompacting(true);
    try {
      const token = await getToken();
      if (!token) throw new Error("No valid session token available.");
      const compactPath = (agent.slug ?? "").replace(/\/run$/, "/compact");
      const res = await fetch(`${configContext?.backend}${compactPath}/${agent.id}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          User: user.id,
          Session: session.id,
          Authorization: `Bearer ${token}`,
          ...(modelOverrideRef.current && modelOverrideRef.current !== agent.model
            ? { "X-Exulu-Model-Override": modelOverrideRef.current }
            : {}),
        },
        body: JSON.stringify({ steer: steer?.trim() || undefined }),
      });
      const bodyText = await res.text();
      if (!res.ok) {
        if (bodyText.includes(COMPACTION_INSUFFICIENT)) {
          setError(t("context.insufficientError"));
        } else {
          let message = bodyText;
          try {
            message = JSON.parse(bodyText).message ?? bodyText;
          } catch {
            // plain-text error body
          }
          setError(message || t("errors.unexpected"));
        }
        return false;
      }
      const data = JSON.parse(bodyText) as { checkpoint: UIMessage };
      // Appending the checkpoint makes it the newest occupancy anchor — the
      // meter drops immediately; the divider renders from metadata.compaction.
      setMessages((prev) => [...prev, data.checkpoint]);
      setServerContextBlocked(false);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : t("errors.unexpected"));
      return false;
    } finally {
      setCompacting(false);
    }
  };
```

- [ ] **Step 7: Return the new fields**

Add to the returned controller object: `contextWindow, contextOccupancy, contextState, compacting, compactConversation,`.

- [ ] **Step 8: Verify**

```bash
npm test && npx tsc --noEmit 2>&1 | head -30
```
Expected: vitest suites PASS; no NEW type errors in `app/(application)/chat/hooks.ts` (pre-existing project-wide errors, if any, are out of scope — compare against `git stash && npx tsc --noEmit | wc -l` if unsure).

- [ ] **Step 9: Commit**

```bash
git add app/\(application\)/chat/hooks.ts
git commit -m "feat(chat): controller context state — occupancy, override-aware window, compaction action"
```

---

### Task 15: Context banner + blocked composer + i18n

**Files:**
- Create: `app/(application)/chat/components/context-banner.tsx`
- Modify: `app/(application)/chat/components/composer.tsx`
- Modify: `messages/en.json`, `messages/de.json`

**Interfaces:**
- Consumes: `controller.contextState/contextOccupancy/contextWindow/compacting/compactConversation` (Task 14); `deriveContextBudget` (Task 13); `CHAT_COLUMN` conventions; existing banner patterns (`composer.tsx:402-420` hint, `553-562` budget bar).
- Produces: `<ContextBanner controller={controller} />` rendered inside the Composer column above the form; the composer textarea + send button disable on `contextState === "blocked"`.

- [ ] **Step 1: i18n keys**

In `messages/en.json`, inside the `"chat"` object add a `"context"` section:

```json
"context": {
  "warnTitle": "Approaching the context limit",
  "warnBody": "This conversation uses {percent}% of the model's context window. Compact it to keep the agent fast and accurate.",
  "blockedTitle": "Context limit reached",
  "blockedBody": "This conversation no longer fits the model's context window. Compact it to continue.",
  "compact": "Compact conversation",
  "compacting": "Summarizing conversation…",
  "steerToggle": "Anything to preserve in detail?",
  "steerPlaceholder": "e.g. keep the exact figures from the service reports",
  "dismiss": "Dismiss",
  "insufficientError": "This conversation can't be compacted further — please start a new chat.",
  "blockedToastTitle": "Context limit reached",
  "blockedToastDescription": "Compact the conversation before sending new messages.",
  "placeholderBlocked": "Compact the conversation to continue…"
}
```

In `messages/de.json`, same keys:

```json
"context": {
  "warnTitle": "Kontextlimit fast erreicht",
  "warnBody": "Diese Unterhaltung nutzt {percent}% des Kontextfensters des Modells. Komprimiere sie, damit der Agent schnell und präzise bleibt.",
  "blockedTitle": "Kontextlimit erreicht",
  "blockedBody": "Diese Unterhaltung passt nicht mehr in das Kontextfenster des Modells. Komprimiere sie, um fortzufahren.",
  "compact": "Unterhaltung komprimieren",
  "compacting": "Unterhaltung wird zusammengefasst…",
  "steerToggle": "Etwas, das im Detail erhalten bleiben soll?",
  "steerPlaceholder": "z. B. die genauen Zahlen aus den Serviceberichten behalten",
  "dismiss": "Ausblenden",
  "insufficientError": "Diese Unterhaltung kann nicht weiter komprimiert werden — bitte starte einen neuen Chat.",
  "blockedToastTitle": "Kontextlimit erreicht",
  "blockedToastDescription": "Komprimiere die Unterhaltung, bevor du neue Nachrichten sendest.",
  "placeholderBlocked": "Komprimiere die Unterhaltung, um fortzufahren…"
}
```

Run: `npm run check-messages` — Expected: no missing-key errors.

- [ ] **Step 2: Create `app/(application)/chat/components/context-banner.tsx`**

```tsx
"use client";

/**
 * ContextBanner — the 80%-warn / 95%-block surface for context-window
 * management (spec 2026-07-07 §5b). Lives in the composer banner stack.
 * Warn: dismissible, reappears after a further 5-point climb. Blocked:
 * non-dismissible; the composer disables itself alongside.
 * Warning/amber tones only (no violet — design rule).
 */

import { Archive, Loader2, TriangleAlert, X } from "lucide-react";
import { useTranslations } from "next-intl";
import * as React from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import type { ChatSessionController } from "../hooks";
import { deriveContextBudget } from "../lib/context-budget";

export function ContextBanner({ controller }: { controller: ChatSessionController }) {
  const t = useTranslations("chat");
  const { contextState, contextWindow, contextOccupancy, compacting, session, status } = controller;

  const [steerOpen, setSteerOpen] = React.useState(false);
  const [steer, setSteer] = React.useState("");
  // Warn-dismissal: remember the percent at dismissal; reappear at +5 points.
  const [dismissedAtPct, setDismissedAtPct] = React.useState<number | null>(null);

  const budget = contextWindow ? deriveContextBudget(contextWindow) : null;
  const percent = budget ? Math.min(999, Math.round((contextOccupancy / budget.usableWindow) * 100)) : 0;

  if (contextState === "ok" || !session || session.id === "new") return null;
  const blocked = contextState === "blocked";
  if (!blocked && dismissedAtPct !== null && percent < dismissedAtPct + 5) return null;

  const streaming = status === "streaming" || status === "submitted";

  const onCompact = async () => {
    const ok = await controller.compactConversation(steer);
    if (ok) {
      setSteer("");
      setSteerOpen(false);
      setDismissedAtPct(null);
    }
  };

  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        "mb-2 rounded-md border px-3 py-2 text-xs",
        "border-warning/50 bg-warning/10",
        blocked ? "text-foreground" : "text-muted-foreground",
      )}
    >
      <div className="flex items-start gap-2">
        <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-warning" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <span className="font-medium text-foreground">
            {blocked ? t("context.blockedTitle") : t("context.warnTitle")}
          </span>{" "}
          — {blocked ? t("context.blockedBody") : t("context.warnBody", { percent })}
          {steerOpen && (
            <input
              type="text"
              value={steer}
              onChange={(e) => setSteer(e.target.value)}
              placeholder={t("context.steerPlaceholder")}
              aria-label={t("context.steerToggle")}
              className="mt-2 w-full rounded-md border bg-background px-2 py-1.5 text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
          )}
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-7 border-warning/50 text-xs"
              disabled={compacting || streaming}
              onClick={() => void onCompact()}
            >
              {compacting ? (
                <>
                  <Loader2 className="mr-1 size-3 animate-spin" aria-hidden="true" />
                  {t("context.compacting")}
                </>
              ) : (
                <>
                  <Archive className="mr-1 size-3" aria-hidden="true" />
                  {t("context.compact")}
                </>
              )}
            </Button>
            {!steerOpen && !compacting && (
              <button
                type="button"
                onClick={() => setSteerOpen(true)}
                className="text-xs underline underline-offset-2 hover:text-foreground"
              >
                {t("context.steerToggle")}
              </button>
            )}
          </div>
        </div>
        {!blocked && (
          <button
            type="button"
            onClick={() => setDismissedAtPct(percent)}
            aria-label={t("context.dismiss")}
            className="-my-1 -mr-1 flex size-6 shrink-0 items-center justify-center rounded-md transition-colors duration-150 hover:bg-accent"
          >
            <X className="size-3.5" aria-hidden="true" />
          </button>
        )}
      </div>
    </div>
  );
}
```

NOTE: verify the `warning` color token exists (`grep -rn "border-warning" app/ | head -3` — the header chip already uses `border-warning text-warning`, chat-header.tsx:332). If `bg-warning/10` has no effect (token not defined for backgrounds), fall back to `bg-muted/50`.

- [ ] **Step 3: Wire into the Composer**

In `app/(application)/chat/components/composer.tsx`:
- Import: `import { ContextBanner } from "./context-banner";`
- Destructure `contextState` from the controller: add `contextState,` to the `const { agent, status, budgetExceeded, ... } = controller;` block, and `const contextBlocked = contextState === "blocked";`
- Render `<ContextBanner controller={controller} />` inside `<div className={CHAT_COLUMN}>` directly BEFORE the managed-context hint block (line ~401).
- Disable inputs when blocked:
  - Textarea (line ~441-460): `disabled={budgetExceeded || contextBlocked}` and placeholder:
    ```tsx
    placeholder={
      contextBlocked
        ? t("context.placeholderBlocked")
        : budgetExceeded
          ? t("composer.placeholderBudgetReached")
          : t("composer.placeholder")
    }
    ```
  - Send button (line ~498-512): add `|| contextBlocked` to its `disabled` expression.
- Block in `submit` as well (before `if (!input.trim())`):
  ```ts
    if (contextBlocked) {
      toast.error(t("context.blockedToastTitle"), {
        description: t("context.blockedToastDescription"),
      });
      return;
    }
  ```

- [ ] **Step 4: Verify + commit**

```bash
npm run check-messages && npm test && npm run lint 2>&1 | tail -5
git add app/\(application\)/chat/components/context-banner.tsx app/\(application\)/chat/components/composer.tsx messages/en.json messages/de.json
git commit -m "feat(chat): context banner with steerable compaction; composer blocks at the hard limit"
```

---

### Task 16: Accurate header meter + usage popover rework

**Files:**
- Modify: `app/(application)/chat/components/chat-header.tsx`
- Modify: `app/(application)/chat/components/usage-popover.tsx`
- Modify: `messages/en.json`, `messages/de.json` (two `usage.*` keys)

**Interfaces:**
- Consumes: `controller.contextOccupancy/contextWindow/contextState` (Task 14), `deriveContextBudget` (Task 13); existing `UsagePopover`/`UsageDialog` and `tokenCounts` (kept for the cumulative section).
- Produces: `UsagePopoverProps`/`UsageDialogProps` gain `contextOccupancy?: number | null` and `contextWindow?: number | null`; the chip shows real occupancy percent.

- [ ] **Step 1: i18n** — add to `chat.usage` in `messages/en.json`:

```json
"contextTitle": "Context window",
"cumulativeTitle": "Session usage (cumulative)"
```
and in `messages/de.json`:
```json
"contextTitle": "Kontextfenster",
"cumulativeTitle": "Sitzungsverbrauch (kumuliert)"
```

- [ ] **Step 2: chat-header.tsx** — replace the usage-chip computation (lines ~147-159):

```ts
  // ── Usage chip — REAL context occupancy (spec §5a), not the cumulative sum.
  // maxContext kept: the popover still receives it as its no-context fallback.
  const maxContext =
    typeof agent.maxContextLength === "number" && agent.maxContextLength > 0
      ? agent.maxContextLength
      : null;
  const contextWindow = controller.contextWindow;
  const contextBudget = contextWindow ? deriveContextBudget(contextWindow) : null;
  const usagePct = contextBudget
    ? Math.round((controller.contextOccupancy / contextBudget.usableWindow) * 100)
    : null;
  const usageWarning = controller.contextState !== "ok";
  const compactTokens = new Intl.NumberFormat("en-US", {
    notation: "compact",
  }).format(controller.contextOccupancy);
  const showUsageChip = usagePct !== null && controller.contextOccupancy > 0;
```
Import `deriveContextBudget` from `../lib/context-budget`. Pass the new props everywhere `UsagePopover`/`UsageDialog` render (chip wrapper line ~320-337 and the dialog near line ~425-431):
```tsx
            <UsagePopover
              tokenCounts={tokenCounts}
              maxContextLength={maxContext}
              contextOccupancy={controller.contextOccupancy}
              contextWindow={controller.contextWindow}
              budget={budget}
            >
```
(keep `maxContext` for backwards compatibility inside the popover). The chip label (`{usagePct}% · {compactTokens}`) and the ≥-warning class stay as-is — they now read the new values.

- [ ] **Step 3: usage-popover.tsx** — surface both numbers:

- Extend both prop types:
```ts
  contextOccupancy?: number | null;
  contextWindow?: number | null;
```
- In `UsageBreakdown`, accept the new props and change the `Context` provider block: the top header becomes the REAL context row and the token breakdown gets the "cumulative" label:
```tsx
  const hasContext =
    typeof contextOccupancy === "number" && typeof contextWindow === "number" && contextWindow > 0;

  return (
    <Context
      usedTokens={hasContext ? contextOccupancy : tokenCounts.totalTokens}
      maxTokens={hasContext ? contextWindow : hasMax ? (maxContextLength as number) : 0}
      usage={{ /* unchanged */ }}
    >
      <div className="divide-y">
        {hasContext ? (
          <div className="space-y-1 p-3">
            <p className="text-xs font-medium text-muted-foreground">{t("usage.contextTitle")}</p>
            <ContextContentHeader />
          </div>
        ) : hasMax ? (
          <ContextContentHeader />
        ) : null}
        <ContextContentBody className="space-y-2">
          <p className="text-xs font-medium text-muted-foreground">{t("usage.cumulativeTitle")}</p>
          {/* existing Total row + Input/Output/Reasoning/Cache rows unchanged */}
```
- Thread the new props through `UsagePopover` and `UsageDialog` into `UsageBreakdown`.

- [ ] **Step 4: Verify + commit**

```bash
npm run check-messages && npm test && npm run lint 2>&1 | tail -5
git add app/\(application\)/chat/components/chat-header.tsx app/\(application\)/chat/components/usage-popover.tsx messages/en.json messages/de.json
git commit -m "feat(chat): header meter shows real context occupancy; popover separates context vs cumulative usage"
```

---

### Task 17: Compaction divider in the message renderer

**Files:**
- Modify: `components/message-renderer.tsx`

**Interfaces:**
- Consumes: checkpoint messages with `metadata.compaction` (shape from Task 1/13: `{ coversUpTo, originalTokens, summaryTokens, occupancyEstimate }`); the message map in `messagesToRender?.map(...)` (line ~480).
- Produces: checkpoint messages render as a full-width divider with an expandable summary — never as a chat bubble, never with message actions (edit/remove/retry). Hardcoded English strings (file convention).

- [ ] **Step 1: Add the early return**

Inside `messagesToRender?.map((message, messageIndex) => {` (line ~480), immediately after `const messageMetadata = message.metadata as any` add:

```tsx
        // Compaction checkpoint (context-window management spec §5c): render
        // as a divider, not a bubble. Deliberately outside <Message> so none
        // of the actions (edit/remove/retry) apply — removing a checkpoint
        // would silently restore an oversized model view.
        if (messageMetadata?.compaction) {
          const compaction = messageMetadata.compaction as {
            originalTokens?: number;
            summaryTokens?: number;
          };
          const fmt = (n?: number) =>
            typeof n === "number" ? Intl.NumberFormat("en-US", { notation: "compact" }).format(n) : "?";
          const summaryText = message.parts
            ?.filter((part: any) => part.type === "text")
            .map((part: any) => part.text)
            .join("\n")
            .replace(/^\[Conversation summary — earlier messages were compacted\]\n*/, "");
          return (
            <div key={message.id} className="my-6 w-full" role="note" aria-label="Conversation compacted">
              <div className="flex items-center gap-3 text-xs text-muted-foreground">
                <div className="h-px flex-1 bg-border" aria-hidden="true" />
                <span className="shrink-0">Conversation compacted — older messages summarized</span>
                <div className="h-px flex-1 bg-border" aria-hidden="true" />
              </div>
              <details className="mx-auto mt-2 max-w-xl rounded-md border bg-muted/30 px-3 py-2 text-xs">
                <summary className="cursor-pointer text-muted-foreground">
                  Summary ({fmt(compaction.originalTokens)} → {fmt(compaction.summaryTokens)} tokens)
                </summary>
                <div className="mt-2 whitespace-pre-wrap text-foreground">{summaryText}</div>
              </details>
            </div>
          );
        }
```

- [ ] **Step 2: Verify + commit**

```bash
npm run lint 2>&1 | tail -3 && npm test
git add components/message-renderer.tsx
git commit -m "feat(chat): render compaction checkpoints as an expandable divider"
```

---

### Task 18: End-to-end verification

**Files:** none (verification only; fix-forward commits allowed in either repo).

- [ ] **Step 1: Backend full validation**

```bash
cd /Users/daniel.claessen/Desktop/Projects/exulu/backend
npm run validate
```
Expected: type-check clean, lint clean (no NEW errors vs develop), all jest suites PASS.

- [ ] **Step 2: Frontend full validation**

```bash
cd /Users/daniel.claessen/Desktop/Projects/exulu/frontend
npm test && npm run lint && npm run check-messages && npm run build
```
Expected: vitest PASS, lint clean (no NEW errors), i18n keys complete, production build succeeds.

- [ ] **Step 3: Manual E2E walk (requires local stack with LiteLLM)**

Start backend + frontend dev servers as usual. Then, in a chat session with a small-window model (pick the smallest `max_input_tokens` entry in the LiteLLM catalog, or temporarily add one to `config.litellm.yaml`):

1. **Meter**: send a message → header chip shows a small realistic percent (NOT a cumulative sum that grows super-linearly). Popover shows "Context window" row + "Session usage (cumulative)" section.
2. **Warn**: paste large texts until occupancy crosses 80% of usable → amber banner appears with "Compact conversation" + steer input; dismiss works; it returns after +5 points.
3. **Compact**: click Compact with a steer note → "Summarizing conversation…" → divider appears with expandable summary; meter drops; sending still works; reload the page → divider persists, meter still low.
4. **Block**: fill again past 95% → composer disables with the blocked bar; sending via Enter shows the toast; Compact re-enables it.
5. **Tool offload**: enable a tool that returns big output (or upload a large .odt/.docx document) → the assistant's tool result / document is truncated with a notice naming a `tool-output-*.txt` (or upload) session file; the file appears in the Session-files side panel; asking the agent about content beyond the preview makes it call `read_session_file`.
6. **Overflow backstop**: with a session just under the block threshold, send a message that pushes the provider over (if reachable) → the dedicated blocked state appears instead of a raw red alert.

Record any deviation as a bug, fix, and re-run the affected step.

- [ ] **Step 4: Final commits + branch state**

```bash
cd /Users/daniel.claessen/Desktop/Projects/exulu/backend && git status && git log --oneline develop..HEAD
cd /Users/daniel.claessen/Desktop/Projects/exulu/frontend && git status && git log --oneline develop..HEAD
```
Expected: clean trees, one commit per task. Do NOT merge or push — hand back to the user per superpowers:finishing-a-development-branch.
