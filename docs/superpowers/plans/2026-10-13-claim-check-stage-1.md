# Claim Check — Stage 1 (engine + endpoint + config) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the claim-check engine and its HTTP endpoint, so that posting a question, an answer and its sources returns per-claim grounding verdicts and a score — with no UI and no chat wiring yet.

**Architecture:** A new license-gated EE module `ee/claim-check/` with one file per stage (split → select → disambiguate → decompose → evidence → verify → score), each a pure function over plain data, orchestrated by `run.ts` (batching, bounded concurrency, bisect-on-failure, circuit breaker, caps, Redis result cache). Every LLM hop goes through the existing `ee/agentic-retrieval/pipeline/micro-call.ts` wrapper. The endpoint is a route registrar with injected dependencies, tested over HTTP with supertest and no Postgres.

**Tech Stack:** TypeScript (Node v22.18.0), zod 4, `ai` SDK 6 via `microCall`, `natural` 8 + `franc` 6 (already used by `src/utils/query-preprocessing.ts`) for stemming and language detection, `Intl.Segmenter` for sentence segmentation, express 5, jest + ts-jest, supertest.

**Spec:** `docs/superpowers/specs/2026-10-13-claim-check-design.md`

## Global Constraints

- Branch: `feature/claim-check` in `/Users/daniel.claessen/Desktop/Projects/exulu/backend`. Conventional-commit messages (commitlint is installed); scope `claim-check`.
- Tests: `npm test -- <path>`; path aliases `@SRC/*` → `src/*`, `@EE/*` → `ee/*`, `@EXULU_TYPES/*` → `types/*`. Jest roots are `src` and `ee`, `testMatch` is `**/*.test.ts`.
- **Stage 1 scope ends at the endpoint.** No `claim_checks` table, no `claimCheckMetadata`, no frontend wizard entry — those are Stage 3 in the spec's §9 delivery order.
- Every LLM call goes through `microCall` with `temperature: 0`, and `maxOutputTokens: CLAIM_CHECK_MAX_OUTPUT_TOKENS` (8000). Temperature becomes 0.2 only when `completions > 1`.
- **Prompts must be our own text.** The paper's appendix prompts are a behaviour reference, never text to copy (spec §1).
- Scoring invariants (spec §2.4): dropped sentences are excluded from the denominator; `contradicted` and `unsupported` are counted separately; no checkable claims → `label: "n/a"`, never `0`.
- Resilience (spec §6): max 6 calls in flight per check; a failed batch is bisected once; a stage aborts above 40% call failure; `status: "partial"` with notes instead of throwing.
- The LiteLLM message `"Not allowed to access model due to tags configuration"` after a 429 is a cooldown aftershock and must be treated as **retryable**, never reported as a config error.
- The request's `model` resolves **without** `rbacBypass`. Unlicensed deployments get **404**.
- Config parse failures never throw into retrieval: reuse `jsonVal` in `pipeline/config.ts`, which warns and falls back to defaults.
- Prompts are written in English; content may be any language. Language detection comes from `preprocessQuery(text).language` (ISO 639-3, e.g. `deu`).
- `npm run type-check` must report the **same** error count and the same error identities as the pre-task baseline (8 errors across `auth/flow.ts`, `auth/validate.ts`, `openai-transformer.ts` and `convert-exulu-tools-to-ai-sdk-tools.ts` as of 2026-10-13). Capture and compare the FULL error list — never `tail`, which silently shrinks the baseline and would hide a regression. A drop is as suspicious as a rise.

## Review Focus

Five input classes the spec implies but whose tests are easy to omit. Each line's test is assigned to the task that owns the code.

1. **Markdown tables, fenced code blocks and heading lines in the answer** — segmentation must not emit code or table pipes as "sentences", and offsets must stay exact (Task 3).
2. **Unicode offset integrity** — umlauts, emoji and combining characters must keep `answer.slice(start, end) === sentence.text` (JS indices are UTF-16 units) (Task 3).
3. **Degenerate sources** — empty/whitespace `content`, and duplicate `sources[].id`, must neither crash evidence selection nor silently merge two sources into one (Task 4).
4. **An answer where every sentence is dropped** (pure pleasantries) — `claims: 0`, `label: "n/a"`, no division by zero (Task 10).
5. **A model returning a `sentenceIndex` that does not exist, or more claims than the cap** — the orchestrator drops the orphan and caps the rest without corrupting claim ids (Task 11).

---

### Task 1: Shared types, constants, and usage passthrough in `microCall`

**Files:**
- Create: `ee/claim-check/types.ts`
- Modify: `ee/agentic-retrieval/pipeline/micro-call.ts` (add `usage` to the return value)
- Test: `ee/agentic-retrieval/pipeline/micro-call.test.ts` (add one test)

**Interfaces:**
- Consumes: nothing.
- Produces: every type below, plus `CLAIM_CHECK_MAX_OUTPUT_TOKENS = 8000`; `microCall` now resolves `{ output, text, usage: { inputTokens: number; outputTokens: number } }`.

- [ ] **Step 1: Record the typecheck baseline**

```bash
cd /Users/daniel.claessen/Desktop/Projects/exulu/backend
git branch --show-current   # must print feature/claim-check
npm run type-check 2>&1 | grep -E "error TS" | sort > /tmp/typecheck-baseline.txt
wc -l < /tmp/typecheck-baseline.txt   # 8 on this branch as of 2026-10-13
cat /tmp/typecheck-baseline.txt
```

Keep this file. Every later task compares against it.

- [ ] **Step 2: Write the failing test for `microCall` usage**

Append to `ee/agentic-retrieval/pipeline/micro-call.test.ts`, inside the existing `describe("microCall", ...)`:

```typescript
  it("returns provider token usage, defaulting to zeros when absent", async () => {
    (generateText as jest.Mock).mockResolvedValue({
      output: { ok: true },
      text: "{}",
      usage: { inputTokens: 1234, outputTokens: 56 },
    });
    const withUsage = await microCall({ model: {} as any, prompt: "p", schema });
    expect(withUsage.usage).toEqual({ inputTokens: 1234, outputTokens: 56 });

    (generateText as jest.Mock).mockResolvedValue({ output: { ok: true }, text: "{}" });
    const withoutUsage = await microCall({ model: {} as any, prompt: "p", schema });
    expect(withoutUsage.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
  });
```

- [ ] **Step 3: Run it and watch it fail**

Run: `npm test -- ee/agentic-retrieval/pipeline/micro-call.test.ts`
Expected: FAIL — `usage` is `undefined` on the resolved value.

- [ ] **Step 4: Add the passthrough**

In `micro-call.ts`, change the return inside the retried closure and the function's declared return type:

```typescript
export async function microCall<OUTPUT = undefined>(
  args: MicroCallArgs<OUTPUT>,
): Promise<{ output: OUTPUT; text: string; usage: { inputTokens: number; outputTokens: number } }> {
```

```typescript
      // Token usage rides along so callers that fan out many micro-calls
      // (claim check) can report what a check cost without re-deriving it.
      const usage = (result as { usage?: { inputTokens?: number; outputTokens?: number } }).usage;
      return {
        output: (schema ? (result as { output: OUTPUT }).output : undefined) as OUTPUT,
        text: result.text,
        usage: {
          inputTokens: usage?.inputTokens ?? 0,
          outputTokens: usage?.outputTokens ?? 0,
        },
      };
```

- [ ] **Step 5: Pin the tag-configuration error as retryable**

This is the Global Constraint with no other owner: after a 429 cooldown LiteLLM can answer
*"Not allowed to access model due to tags configuration"*, which reads like a misconfiguration
but is a rate-limit aftershock. `microCall`'s classifier retries everything except
`NoOutputGeneratedError`, so the behaviour is already correct — this test stops a future
"fail fast on config errors" change from silently breaking it. Append to the same describe:

```typescript
  it("retries a LiteLLM tag-configuration error, which is a 429 aftershock and not a config fault", async () => {
    (generateText as jest.Mock)
      .mockRejectedValueOnce(new Error("Not allowed to access model due to tags configuration"))
      .mockResolvedValueOnce({ output: { ok: true }, text: "{}", usage: { inputTokens: 5, outputTokens: 1 } });

    const { output } = await microCall({
      model: {} as any,
      prompt: "p",
      schema,
      retryBaseDelayMs: 1,
    });

    expect(output).toEqual({ ok: true });
    expect((generateText as jest.Mock).mock.calls.length).toBe(2);
  });
```

- [ ] **Step 6: Run the test and the pipeline suite**

Run: `npm test -- ee/agentic-retrieval/pipeline`
Expected: PASS, every pre-existing pipeline test included (the change is additive).

- [ ] **Step 7: Create `ee/claim-check/types.ts`**

```typescript
// ee/claim-check/types.ts
//
// The whole data contract of the claim-check engine. Every stage is a pure
// function over these types, so a stage can be tested without a provider and
// without the orchestrator.

/** Raised output cap: the staged prompts reason before answering, and the
 *  shared MICRO_CALL_MAX_OUTPUT_TOKENS (2000) truncates a batch of sentences. */
export const CLAIM_CHECK_MAX_OUTPUT_TOKENS = 8000;

export type ClaimCheckSource = { id: string; name?: string; content: string };

export type Sentence = {
  index: number;
  /** Char offsets into the ORIGINAL answer string; answer.slice(start, end) === text. */
  start: number;
  end: number;
  text: string;
  /** Markdown heading hierarchy above this sentence, outermost first. */
  headingPath: string[];
};

export type SentenceWindow = {
  sentence: Sentence;
  preceding: Sentence[];
  following: Sentence[];
};

export type SelectionOutcome = {
  index: number;
  verifiable: boolean;
  /** Rewritten verifiable-only sentence, or null when unchanged. */
  rewritten: string | null;
  reason: string;
};

export type DisambiguationOutcome = {
  index: number;
  resolvable: boolean;
  /** Clarified sentence, or null when no change was needed. */
  clarified: string | null;
  reason: string;
};

export type DecompositionOutcome = {
  index: number;
  claims: { text: string; inferred: boolean }[];
};

export type EvidenceSnippet = {
  sourceId: string;
  sourceName?: string;
  text: string;
  score: number;
};

export type Verdict = "supported" | "contradicted" | "unsupported";

export type VerifyOutcome = {
  claimId: string;
  verdict: Verdict;
  evidence: { sourceId: string; quote: string }[];
  rationale: string;
};

export type Claim = {
  /** Stable within one result: "c1", "c2", … in extraction order. */
  id: string;
  sentenceIndex: number;
  text: string;
  inferred: boolean;
  verdict: Verdict;
  evidence: { sourceId: string; quote: string }[];
  rationale: string;
  /** True when a second-chance retrieval supplied the evidence. */
  rechecked: boolean;
};

export type SentenceState =
  | "checked"
  | "no_verifiable_content"
  | "cannot_disambiguate"
  | "not_checked";

export type SentenceResult = {
  index: number;
  start: number;
  end: number;
  state: SentenceState;
  reason?: string;
  claimIds: string[];
};

export type ScoreLabel = "ok" | "warn" | "alert" | "n/a";

export type ClaimCheckScore = {
  /** Checked claims only — the denominator. */
  claims: number;
  supported: number;
  contradicted: number;
  unsupported: number;
  /** (contradicted + unsupported) / claims; 0 when claims === 0. */
  unsupportedShare: number;
  label: ScoreLabel;
};

export type ClaimCheckResult = {
  status: "ok" | "partial";
  score: ClaimCheckScore;
  sentences: SentenceResult[];
  claims: Claim[];
  usage: { calls: number; inputTokens: number; outputTokens: number };
  timings: Record<string, number>;
  limits: { truncated: boolean; sentencesSkipped: number };
  notes: string[];
};

export type ClaimCheckOptions = {
  fidelity: "fast" | "paper";
  completions: number;
  reRetrieve: boolean;
  thresholds: { warn: number; alert: number };
  caps: { maxSentences: number; maxClaims: number; maxReRetrievals: number };
};

export const CLAIM_CHECK_DEFAULTS: ClaimCheckOptions = {
  fidelity: "fast",
  completions: 1,
  reRetrieve: true,
  thresholds: { warn: 0.1, alert: 0.3 },
  caps: { maxSentences: 120, maxClaims: 200, maxReRetrievals: 10 },
};
```

- [ ] **Step 8: Commit**

```bash
git add ee/claim-check/types.ts ee/agentic-retrieval/pipeline/micro-call.ts ee/agentic-retrieval/pipeline/micro-call.test.ts
git commit -m "feat(claim-check): add engine data contract and micro-call usage passthrough"
```

---

### Task 2: `claim_check` config option on the retrieval tool

**Files:**
- Modify: `ee/agentic-retrieval/pipeline/config.ts`
- Modify: `ee/agentic-retrieval/pipeline/index.ts` (the tool's `config[]` array, after the `show_sources_to_external_users` entry)
- Test: `ee/agentic-retrieval/pipeline/config.test.ts`

**Interfaces:**
- Consumes: `ClaimCheckOptions`, `CLAIM_CHECK_DEFAULTS` (Task 1).
- Produces: `PipelineConfig.claimCheck: ClaimCheckConfig`, where `ClaimCheckConfig = ClaimCheckOptions & { enabled: boolean; model: string; showToExternalUsers: boolean }`; parsed from the tool config key `claim_check`.

- [ ] **Step 1: Write the failing tests**

Append to `ee/agentic-retrieval/pipeline/config.test.ts`:

```typescript
describe("parsePipelineConfig — claim_check", () => {
  it("defaults to disabled with the spec's thresholds and caps when the key is absent", () => {
    const cfg = parsePipelineConfig({});
    expect(cfg.claimCheck).toEqual({
      enabled: false,
      model: "",
      fidelity: "fast",
      completions: 1,
      reRetrieve: true,
      thresholds: { warn: 0.1, alert: 0.3 },
      showToExternalUsers: false,
      caps: { maxSentences: 120, maxClaims: 200, maxReRetrievals: 10 },
    });
  });

  it("parses a JSON string and keeps unspecified keys at their defaults", () => {
    const cfg = parsePipelineConfig({
      claim_check: '{"enabled":true,"model":"vertex-gemini-3.5-flash","thresholds":{"warn":0.2,"alert":0.5}}',
    });
    expect(cfg.claimCheck.enabled).toBe(true);
    expect(cfg.claimCheck.model).toBe("vertex-gemini-3.5-flash");
    expect(cfg.claimCheck.thresholds).toEqual({ warn: 0.2, alert: 0.5 });
    expect(cfg.claimCheck.fidelity).toBe("fast");
    expect(cfg.claimCheck.caps.maxClaims).toBe(200);
  });

  it("falls back to defaults on malformed JSON and on a schema violation", () => {
    expect(parsePipelineConfig({ claim_check: "{not json" }).claimCheck.enabled).toBe(false);
    expect(parsePipelineConfig({ claim_check: { fidelity: "turbo" } }).claimCheck.fidelity).toBe("fast");
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npm test -- ee/agentic-retrieval/pipeline/config.test.ts`
Expected: FAIL — `cfg.claimCheck` is `undefined`.

- [ ] **Step 3: Add the schema and the parse**

In `config.ts`, after `tuningSchema`:

```typescript
const claimCheckSchema = z.object({
  enabled: z.boolean().default(false),
  /** Empty = fall back to the agent's utility model, then the agent's model. */
  model: z.string().default(""),
  fidelity: z.enum(["fast", "paper"]).default("fast"),
  completions: z.number().int().min(1).max(3).default(1),
  reRetrieve: z.boolean().default(true),
  thresholds: z
    .object({ warn: z.number().min(0).max(1).default(0.1), alert: z.number().min(0).max(1).default(0.3) })
    // zod's .default() returns the value as-is (inner defaults are not applied), so spell it out.
    .default({ warn: 0.1, alert: 0.3 }),
  showToExternalUsers: z.boolean().default(false),
  caps: z
    .object({
      maxSentences: z.number().int().positive().default(120),
      maxClaims: z.number().int().positive().default(200),
      maxReRetrievals: z.number().int().min(0).default(10),
    })
    .default({ maxSentences: 120, maxClaims: 200, maxReRetrievals: 10 }),
});

export type ClaimCheckConfig = z.infer<typeof claimCheckSchema>;
```

Add to the `PipelineConfig` type:

```typescript
  /** Post-answer claim verification (spec 2026-10-13). Off unless an admin enables it. */
  claimCheck: ClaimCheckConfig;
```

Add to the object `parsePipelineConfig` returns:

```typescript
    claimCheck: jsonVal("claim_check", claimCheckSchema, r["claim_check"]),
```

Add to `defaultFor`'s switch, above `default`:

```typescript
    case "claim_check": return {};
```

- [ ] **Step 4: Add the tool's config entry**

In `ee/agentic-retrieval/pipeline/index.ts`, append to the `config` array after the `show_sources_to_external_users` entry:

```typescript
      {
        name: "claim_check",
        description:
          "Post-answer claim verification: extracts the factual claims the answer makes and reports, " +
          "per claim, whether the retrieved passages support it, contradict it, or say nothing about it. " +
          "Runs AFTER the answer has streamed and never delays or changes it. Keys: enabled, model " +
          "(a fast, cheap model is the right choice), fidelity (fast | paper), completions, reRetrieve, " +
          "thresholds {warn, alert}, showToExternalUsers, caps {maxSentences, maxClaims, maxReRetrievals}.",
        type: "json",
        default: '{"enabled":false,"model":"","fidelity":"fast","thresholds":{"warn":0.1,"alert":0.3}}',
      },
```

- [ ] **Step 5: Run the tests and the typecheck**

Run: `npm test -- ee/agentic-retrieval/pipeline/config.test.ts`
Expected: PASS.
Run: `npm run type-check 2>&1 | grep -E "error TS" | sort | diff - /tmp/typecheck-baseline.txt`
Expected: no output — the pre-existing error set is unchanged in both count and identity.

- [ ] **Step 6: Commit**

```bash
git add ee/agentic-retrieval/pipeline/config.ts ee/agentic-retrieval/pipeline/config.test.ts ee/agentic-retrieval/pipeline/index.ts
git commit -m "feat(claim-check): add the claim_check config option to the retrieval tool"
```

> **Note for the Stage 3 plan, not this one:** `serializeWizardConfig` in the frontend emits a fixed entry list, so this key is wiped whenever an admin saves the knowledge-search wizard until the wizard learns about it (spec §3).

---

### Task 3: `split.ts` — sentences, offsets, heading paths, context windows

**Files:**
- Create: `ee/claim-check/split.ts`
- Test: `ee/claim-check/split.test.ts`

**Interfaces:**
- Consumes: `Sentence`, `SentenceWindow` (Task 1).
- Produces:
  - `splitIntoSentences(answer: string, locale?: string): Sentence[]`
  - `buildWindows(sentences: Sentence[], preceding: number, following: number): SentenceWindow[]`
  - `localeFromText(text: string): string` (ISO 639-1 for `Intl.Segmenter`, derived from `preprocessQuery().language`)

- [ ] **Step 1: Write the failing tests**

```typescript
// ee/claim-check/split.test.ts
import { splitIntoSentences, buildWindows, localeFromText } from "./split";

const offsetsAreExact = (answer: string) =>
  splitIntoSentences(answer).every((s) => answer.slice(s.start, s.end) === s.text);

describe("splitIntoSentences", () => {
  it("splits plain German prose and keeps offsets exact", () => {
    const answer = "Die FST-2XT ist eine Steuerung. Sie wird im Schaltschrank montiert.";
    const sentences = splitIntoSentences(answer, "de");
    expect(sentences.map((s) => s.text)).toEqual([
      "Die FST-2XT ist eine Steuerung.",
      "Sie wird im Schaltschrank montiert.",
    ]);
    expect(offsetsAreExact(answer)).toBe(true);
    expect(sentences[0]!.index).toBe(0);
    expect(sentences[1]!.index).toBe(1);
  });

  it("does not split on German abbreviations", () => {
    const answer = "Die Ursache ist z. B. ein defekter Schalter. Nr. 7 ist betroffen, ca. 3 Stück.";
    expect(splitIntoSentences(answer, "de").map((s) => s.text)).toEqual([
      "Die Ursache ist z. B. ein defekter Schalter.",
      "Nr. 7 ist betroffen, ca. 3 Stück.",
    ]);
  });

  // Review Focus 1
  it("skips heading lines and fenced code blocks, recording the heading path", () => {
    const answer = [
      "# Fehlerbehebung",
      "",
      "## FERNABSCHALTUNG",
      "Der Kabinenlichtschalter ist eine Ursache.",
      "",
      "```bash",
      "systemctl restart lift. Nicht als Satz zählen.",
      "```",
      "",
      "Weitere Ursachen sind dokumentiert.",
    ].join("\n");
    const sentences = splitIntoSentences(answer, "de");
    expect(sentences.map((s) => s.text)).toEqual([
      "Der Kabinenlichtschalter ist eine Ursache.",
      "Weitere Ursachen sind dokumentiert.",
    ]);
    expect(sentences[0]!.headingPath).toEqual(["Fehlerbehebung", "FERNABSCHALTUNG"]);
    expect(offsetsAreExact(answer)).toBe(true);
  });

  // Review Focus 1
  it("does not emit markdown table rows or list bullets as sentences", () => {
    const answer = [
      "Übersicht:",
      "",
      "| Teil | Nr. |",
      "| --- | --- |",
      "| Schalter | 7 |",
      "",
      "- Punkt eins",
      "- Punkt zwei",
    ].join("\n");
    expect(splitIntoSentences(answer, "de").map((s) => s.text)).toEqual(["Übersicht:"]);
  });

  // Review Focus 2
  it("keeps offsets exact across umlauts, emoji and combining characters", () => {
    const answer = "Grüße aus Köln 🎉. Der Aufzug läuft wieder. Schön! 👍🏽";
    expect(offsetsAreExact(answer)).toBe(true);
    expect(splitIntoSentences(answer, "de").length).toBeGreaterThanOrEqual(2);
  });

  it("returns an empty array for empty or whitespace-only input", () => {
    expect(splitIntoSentences("")).toEqual([]);
    expect(splitIntoSentences("   \n\n  ")).toEqual([]);
  });
});

describe("buildWindows", () => {
  it("clamps the window at both ends of the answer", () => {
    const answer = "Eins. Zwei. Drei. Vier.";
    const sentences = splitIntoSentences(answer, "de");
    const windows = buildWindows(sentences, 5, 5);
    expect(windows[0]!.preceding).toEqual([]);
    expect(windows[0]!.following.map((s) => s.text)).toEqual(["Zwei.", "Drei.", "Vier."]);
    expect(windows[3]!.following).toEqual([]);
    expect(windows[3]!.preceding.map((s) => s.text)).toEqual(["Eins.", "Zwei.", "Drei."]);
  });

  it("honours a following window of 0 (the later stages' setting)", () => {
    const sentences = splitIntoSentences("Eins. Zwei. Drei.", "de");
    expect(buildWindows(sentences, 5, 0).every((w) => w.following.length === 0)).toBe(true);
  });
});

describe("localeFromText", () => {
  it("maps detected German to de and unknown input to en", () => {
    expect(localeFromText("Der Aufzug steht still und zeigt eine Fernabschaltung an.")).toBe("de");
    expect(localeFromText("")).toBe("en");
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npm test -- ee/claim-check/split.test.ts`
Expected: FAIL — `Cannot find module './split'`.

- [ ] **Step 3: Implement `split.ts`**

```typescript
// ee/claim-check/split.ts
//
// Sentence segmentation for claim extraction. Two jobs the paper's NLTK
// splitter does not have to do: keep character offsets into the ORIGINAL
// answer (the UI highlights by offset), and ignore the parts of a Markdown
// answer that are not prose (headings, fences, tables, bullets).
import { preprocessQuery } from "@SRC/utils/query-preprocessing";
import type { Sentence, SentenceWindow } from "./types";

/** ISO 639-3 (franc) -> ISO 639-1 (Intl.Segmenter). */
const LOCALE_BY_LANGUAGE: Record<string, string> = {
  eng: "en", deu: "de", fra: "fr", spa: "es", ita: "it",
  por: "pt", rus: "ru", nld: "nl", swe: "sv", nor: "no", dan: "da",
};

/**
 * Abbreviations that ICU's sentence-break suppressions do not reliably cover
 * across ICU builds. A segment ending with one of these is glued back onto
 * the next one, so "z. B." never ends a sentence.
 */
const ABBREVIATIONS = [
  "z. b.", "z.b.", "u. a.", "u.a.", "d. h.", "d.h.", "bzw.", "ggf.", "ca.",
  "nr.", "abs.", "art.", "abb.", "tab.", "evtl.", "inkl.", "exkl.", "max.",
  "min.", "vgl.", "sog.", "bspw.", "etc.", "e.g.", "i.e.", "fig.", "no.",
];

type Block = { start: number; end: number; headingPath: string[] };

export function localeFromText(text: string): string {
  if (!text.trim()) return "en";
  const { language } = preprocessQuery(text, { enableStemming: false, detectLanguage: true });
  return LOCALE_BY_LANGUAGE[language] ?? "en";
}

/** True for lines that are structure, not prose: bullets, numbered items, table rows, rules, quotes. */
function isNonProseLine(line: string): boolean {
  const t = line.trim();
  if (!t) return true;
  if (t.startsWith("|")) return true;
  if (/^[-*+]\s/.test(t)) return true;
  if (/^\d+[.)]\s/.test(t)) return true;
  if (/^(-{3,}|_{3,}|\*{3,})$/.test(t)) return true;
  if (t.startsWith(">")) return true;
  return false;
}

/**
 * Walk the answer line by line and collect maximal runs of prose lines. A run
 * is segmented as one unit, so a sentence may span a soft line break; offsets
 * stay absolute because a run is addressed by slice bounds into the answer.
 */
function collectBlocks(answer: string): Block[] {
  const blocks: Block[] = [];
  const headingPath: string[] = [];
  let inFence = false;
  let offset = 0;
  let runStart: number | null = null;
  let runEnd = 0;
  let runHeadings: string[] = [];

  const closeRun = () => {
    if (runStart !== null && runEnd > runStart) {
      blocks.push({ start: runStart, end: runEnd, headingPath: [...runHeadings] });
    }
    runStart = null;
  };

  for (const line of answer.split("\n")) {
    const lineStart = offset;
    const lineEnd = offset + line.length;
    offset = lineEnd + 1; // the "\n" that split consumed
    const trimmed = line.trim();

    if (/^(```|~~~)/.test(trimmed)) {
      closeRun();
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (heading) {
      closeRun();
      const depth = heading[1]!.length;
      headingPath.length = depth - 1;
      headingPath[depth - 1] = heading[2]!.trim();
      continue;
    }

    if (isNonProseLine(line)) {
      closeRun();
      continue;
    }

    if (runStart === null) {
      runStart = lineStart;
      runHeadings = headingPath.filter((h): h is string => Boolean(h));
    }
    runEnd = lineEnd;
  }

  closeRun();
  return blocks;
}

export function splitIntoSentences(answer: string, locale?: string): Sentence[] {
  if (!answer.trim()) return [];
  const resolved = locale ?? localeFromText(answer);
  const segmenter = new Intl.Segmenter(resolved, { granularity: "sentence" });
  const sentences: Sentence[] = [];

  for (const block of collectBlocks(answer)) {
    const raw = answer.slice(block.start, block.end);
    const pieces: { text: string; start: number }[] = [];

    for (const seg of segmenter.segment(raw)) {
      const previous = pieces[pieces.length - 1];
      const previousEndsWithAbbreviation =
        previous !== undefined &&
        ABBREVIATIONS.some((a) => previous.text.trimEnd().toLowerCase().endsWith(a));
      if (previous && previousEndsWithAbbreviation) {
        previous.text += seg.segment;
      } else {
        pieces.push({ text: seg.segment, start: block.start + seg.index });
      }
    }

    for (const piece of pieces) {
      const leading = piece.text.length - piece.text.trimStart().length;
      const trimmed = piece.text.trim();
      if (!trimmed) continue;
      const start = piece.start + leading;
      sentences.push({
        index: sentences.length,
        start,
        end: start + trimmed.length,
        text: trimmed,
        headingPath: block.headingPath,
      });
    }
  }

  return sentences;
}

export function buildWindows(
  sentences: Sentence[],
  preceding: number,
  following: number,
): SentenceWindow[] {
  return sentences.map((sentence, i) => ({
    sentence,
    preceding: sentences.slice(Math.max(0, i - preceding), i),
    following: sentences.slice(i + 1, i + 1 + following),
  }));
}
```

- [ ] **Step 4: Check the abbreviation list against this ICU build**

ICU's sentence-break suppression lists vary by build, which is why `ABBREVIATIONS` exists. Run:

```bash
node -e 'const seg=new Intl.Segmenter("de",{granularity:"sentence"});console.log([...seg.segment("Die Ursache ist z. B. ein Schalter. Nr. 7 ist betroffen.")].map(s=>s.segment))'
```

If a German abbreviation other than the listed ones splits a sentence in the tests, add it to `ABBREVIATIONS` — never loosen the segmenter.

- [ ] **Step 5: Run the tests**

Run: `npm test -- ee/claim-check/split.test.ts`
Expected: PASS, all nine tests.

If the abbreviation test fails on a different abbreviation than the ones listed, add it to `ABBREVIATIONS` rather than changing the segmenter — ICU suppression lists vary by build, which is exactly why that list exists.

- [ ] **Step 6: Commit**

```bash
git add ee/claim-check/split.ts ee/claim-check/split.test.ts
git commit -m "feat(claim-check): add markdown-aware sentence splitting with exact offsets"
```

---

### Task 4: `evidence.ts` — slice sources into passages and select per claim

**Files:**
- Create: `ee/claim-check/evidence.ts`
- Test: `ee/claim-check/evidence.test.ts`

**Interfaces:**
- Consumes: `ClaimCheckSource`, `EvidenceSnippet` (Task 1).
- Produces:
  - `indexSources(sources: ClaimCheckSource[], opts?: { passageChars?: number; overlapChars?: number; maxCharsPerSource?: number }): IndexedPassage[]`
  - `selectEvidence(claimTexts: string[], passages: IndexedPassage[], topK?: number): EvidenceSnippet[]`
  - `type IndexedPassage = { sourceId: string; sourceName?: string; text: string; tokens: string[] }`

- [ ] **Step 1: Write the failing tests**

```typescript
// ee/claim-check/evidence.test.ts
import { indexSources, selectEvidence } from "./evidence";

const SOURCES = [
  {
    id: "s1",
    name: "handbuch.pdf",
    content:
      "Der Kabinenlichtschalter im Schaltschrank kann eine Fernabschaltung auslösen. " +
      "Die Spannung beträgt 230 Volt.",
  },
  {
    id: "s2",
    name: "ticket-1735.txt",
    content: "Der Kunde meldet eine defekte Tür. Die Tür wurde am 3. März getauscht.",
  },
];

describe("indexSources", () => {
  it("produces passages tagged with their source id and name", () => {
    const passages = indexSources(SOURCES);
    expect(passages.length).toBeGreaterThanOrEqual(2);
    expect(new Set(passages.map((p) => p.sourceId))).toEqual(new Set(["s1", "s2"]));
    expect(passages[0]!.tokens.length).toBeGreaterThan(0);
  });

  it("slices long content into overlapping passages and truncates per source", () => {
    const long = { id: "big", content: "Satz eins. ".repeat(500) };
    const passages = indexSources([long], { passageChars: 400, overlapChars: 50, maxCharsPerSource: 2000 });
    expect(passages.length).toBeGreaterThan(1);
    expect(passages.reduce((n, p) => n + p.text.length, 0)).toBeLessThanOrEqual(2000 + 400);
  });

  // Review Focus 3
  it("ignores empty and whitespace-only sources without crashing", () => {
    expect(indexSources([{ id: "e1", content: "" }, { id: "e2", content: "   \n " }])).toEqual([]);
  });

  // Review Focus 3
  it("keeps duplicate source ids distinguishable by passage, never merging them", () => {
    const passages = indexSources([
      { id: "dup", name: "a.pdf", content: "Inhalt A über Schalter." },
      { id: "dup", name: "b.pdf", content: "Inhalt B über Türen." },
    ]);
    expect(passages.map((p) => p.sourceName).sort()).toEqual(["a.pdf", "b.pdf"]);
    expect(passages.every((p) => p.sourceId === "dup")).toBe(true);
  });
});

describe("selectEvidence", () => {
  it("ranks the passage that shares the claim's terms first", () => {
    const passages = indexSources(SOURCES);
    const [top] = selectEvidence(["Der Kabinenlichtschalter löst eine Fernabschaltung aus"], passages, 2);
    expect(top!.sourceId).toBe("s1");
    expect(top!.text).toContain("Fernabschaltung");
    expect(top!.score).toBeGreaterThan(0);
  });

  it("returns at most topK snippets and none for an empty passage set", () => {
    const passages = indexSources(SOURCES);
    expect(selectEvidence(["Spannung"], passages, 1)).toHaveLength(1);
    expect(selectEvidence(["Spannung"], [], 3)).toEqual([]);
  });

  it("scores a claim with no lexical overlap at zero but still returns a fallback snippet", () => {
    const passages = indexSources(SOURCES);
    const picked = selectEvidence(["Völlig unverwandtes Thema Zebrastreifen"], passages, 2);
    expect(picked).toHaveLength(2);
    expect(picked.every((p) => p.score === 0)).toBe(true);
  });

  it("pools the terms of several claims when they share a sentence neighbourhood", () => {
    const passages = indexSources(SOURCES);
    const picked = selectEvidence(["Die Tür wurde getauscht", "Die Spannung beträgt 230 Volt"], passages, 2);
    expect(new Set(picked.map((p) => p.sourceId))).toEqual(new Set(["s1", "s2"]));
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npm test -- ee/claim-check/evidence.test.ts`
Expected: FAIL — `Cannot find module './evidence'`.

- [ ] **Step 3: Implement `evidence.ts`**

```typescript
// ee/claim-check/evidence.ts
//
// Why this exists: measured on NEWLIFT's live data, one turn's evidence
// averages ~89k chars (max ~600k). Sending all of it into every verification
// call would cost more than every extraction stage combined. So sources are
// sliced into overlapping passages and scored per claim with a lexical
// IDF-weighted overlap — deliberately no embedder, so a client that brings its
// own sources gets identical behaviour with no embedding spend.
import { preprocessQuery } from "@SRC/utils/query-preprocessing";
import type { ClaimCheckSource, EvidenceSnippet } from "./types";

export type IndexedPassage = {
  sourceId: string;
  sourceName?: string;
  text: string;
  tokens: string[];
};

const DEFAULTS = { passageChars: 1200, overlapChars: 200, maxCharsPerSource: 60000 };

/** Stemmed, deduplicated content tokens. Language is detected per text. */
function tokenize(text: string): string[] {
  if (!text.trim()) return [];
  const { processed } = preprocessQuery(text, { enableStemming: true, detectLanguage: true });
  return processed
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length >= 3);
}

export function indexSources(
  sources: ClaimCheckSource[],
  opts: { passageChars?: number; overlapChars?: number; maxCharsPerSource?: number } = {},
): IndexedPassage[] {
  const { passageChars, overlapChars, maxCharsPerSource } = { ...DEFAULTS, ...opts };
  const passages: IndexedPassage[] = [];

  for (const source of sources) {
    const content = (source.content ?? "").slice(0, maxCharsPerSource);
    if (!content.trim()) continue;

    const step = Math.max(1, passageChars - overlapChars);
    for (let start = 0; start < content.length; start += step) {
      const text = content.slice(start, start + passageChars).trim();
      if (!text) continue;
      passages.push({
        sourceId: source.id,
        sourceName: source.name,
        text,
        tokens: tokenize(text),
      });
      if (start + passageChars >= content.length) break;
    }
  }

  return passages;
}

export function selectEvidence(
  claimTexts: string[],
  passages: IndexedPassage[],
  topK = 4,
): EvidenceSnippet[] {
  if (passages.length === 0) return [];

  const queryTokens = new Set(claimTexts.flatMap((t) => tokenize(t)));

  // IDF over passages, so a term that appears everywhere ("aufzug" in a lift
  // manual) cannot outvote the one distinguishing term in the claim.
  const documentFrequency = new Map<string, number>();
  for (const passage of passages) {
    for (const token of new Set(passage.tokens)) {
      documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
    }
  }

  const scored = passages.map((passage, position) => {
    const present = new Set(passage.tokens);
    let score = 0;
    for (const token of queryTokens) {
      if (!present.has(token)) continue;
      const df = documentFrequency.get(token) ?? passages.length;
      score += Math.log(1 + passages.length / df);
    }
    return { passage, score, position };
  });

  // Stable: score desc, then original order, so an all-zero set still returns
  // a deterministic fallback rather than nothing to check against.
  scored.sort((a, b) => (b.score - a.score) || (a.position - b.position));

  return scored.slice(0, topK).map(({ passage, score }) => ({
    sourceId: passage.sourceId,
    sourceName: passage.sourceName,
    text: passage.text,
    score: Number(score.toFixed(4)),
  }));
}
```

- [ ] **Step 4: Run the tests**

Run: `npm test -- ee/claim-check/evidence.test.ts`
Expected: PASS, all nine tests.

- [ ] **Step 5: Commit**

```bash
git add ee/claim-check/evidence.ts ee/claim-check/evidence.test.ts
git commit -m "feat(claim-check): add lexical evidence indexing and per-claim selection"
```

---

### Task 5: `stages/select.ts` — the Selection stage (one call per batch)

**Files:**
- Create: `ee/claim-check/prompts/select.ts`
- Create: `ee/claim-check/stages/select.ts`
- Test: `ee/claim-check/stages/select.test.ts`

**Interfaces:**
- Consumes: `SentenceWindow`, `SelectionOutcome`, `CLAIM_CHECK_MAX_OUTPUT_TOKENS` (Task 1); `microCall` (Task 1's extended return).
- Produces: `runSelection(args: { windows: SentenceWindow[]; question: string; model: LanguageModel; temperature?: number }): Promise<{ outcomes: SelectionOutcome[]; usage: StageUsage }>` and `type StageUsage = { calls: number; inputTokens: number; outputTokens: number }` exported from `ee/claim-check/stages/usage.ts`.

- [ ] **Step 1: Write the failing tests**

```typescript
// ee/claim-check/stages/select.test.ts
jest.mock("@EE/agentic-retrieval/pipeline/micro-call", () => ({
  microCall: jest.fn(),
  microCallProviderOptions: jest.fn(),
}));
import { microCall } from "@EE/agentic-retrieval/pipeline/micro-call";
import { splitIntoSentences, buildWindows } from "../split";
import { runSelection } from "./select";
import { CLAIM_CHECK_MAX_OUTPUT_TOKENS } from "../types";

const ANSWER =
  "Die FST-2XT ist eine Steuerung. Das zeigt, wie wichtig gute Technik ist. " +
  "Sie arbeitet mit 230 Volt und ist dabei beeindruckend zuverlässig.";

const windows = () => buildWindows(splitIntoSentences(ANSWER, "de"), 5, 5);

beforeEach(() => (microCall as jest.Mock).mockReset());

describe("runSelection", () => {
  it("sends one call for the batch and maps outcomes back by sentence index", async () => {
    (microCall as jest.Mock).mockResolvedValue({
      output: {
        sentences: [
          { index: 0, verifiable: true, rewritten: null, reason: "fact about a controller" },
          { index: 1, verifiable: false, rewritten: null, reason: "opinion" },
          { index: 2, verifiable: true, rewritten: "Sie arbeitet mit 230 Volt.", reason: "mixed" },
        ],
      },
      text: "",
      usage: { inputTokens: 900, outputTokens: 120 },
    });

    const { outcomes, usage } = await runSelection({
      windows: windows(),
      question: "Womit arbeitet die FST-2XT?",
      model: {} as any,
    });

    expect((microCall as jest.Mock)).toHaveBeenCalledTimes(1);
    expect(usage).toEqual({ calls: 1, inputTokens: 900, outputTokens: 120 });
    expect(outcomes).toEqual([
      { index: 0, verifiable: true, rewritten: null, reason: "fact about a controller" },
      { index: 1, verifiable: false, rewritten: null, reason: "opinion" },
      { index: 2, verifiable: true, rewritten: "Sie arbeitet mit 230 Volt.", reason: "mixed" },
    ]);
  });

  it("passes the raised output cap and the requested temperature", async () => {
    (microCall as jest.Mock).mockResolvedValue({ output: { sentences: [] }, text: "", usage: { inputTokens: 1, outputTokens: 1 } });
    await runSelection({ windows: windows(), question: "q", model: {} as any, temperature: 0.2 });
    const args = (microCall as jest.Mock).mock.calls[0][0];
    expect(args.maxOutputTokens).toBe(CLAIM_CHECK_MAX_OUTPUT_TOKENS);
    expect(args.temperature).toBe(0.2);
  });

  it("includes the question, the target sentences and their surrounding context in the prompt", async () => {
    (microCall as jest.Mock).mockResolvedValue({ output: { sentences: [] }, text: "", usage: { inputTokens: 1, outputTokens: 1 } });
    await runSelection({ windows: windows(), question: "Womit arbeitet die FST-2XT?", model: {} as any });
    const prompt = String((microCall as jest.Mock).mock.calls[0][0].prompt);
    expect(prompt).toContain("Womit arbeitet die FST-2XT?");
    expect(prompt).toContain("Die FST-2XT ist eine Steuerung.");
    expect(prompt).toContain("[0]");
  });

  it("treats a sentence the model omitted as unverifiable rather than silently checked", async () => {
    (microCall as jest.Mock).mockResolvedValue({
      output: { sentences: [{ index: 0, verifiable: true, rewritten: null, reason: "ok" }] },
      text: "",
      usage: { inputTokens: 10, outputTokens: 5 },
    });
    const { outcomes } = await runSelection({ windows: windows(), question: "q", model: {} as any });
    expect(outcomes).toHaveLength(3);
    expect(outcomes[1]).toEqual({ index: 1, verifiable: false, rewritten: null, reason: "no selection returned for this sentence" });
  });

  it("ignores an outcome whose index is not in the batch", async () => {
    (microCall as jest.Mock).mockResolvedValue({
      output: { sentences: [{ index: 99, verifiable: true, rewritten: null, reason: "hallucinated index" }] },
      text: "",
      usage: { inputTokens: 10, outputTokens: 5 },
    });
    const { outcomes } = await runSelection({ windows: windows(), question: "q", model: {} as any });
    expect(outcomes.map((o) => o.index)).toEqual([0, 1, 2]);
    expect(outcomes.every((o) => o.verifiable === false)).toBe(true);
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npm test -- ee/claim-check/stages/select.test.ts`
Expected: FAIL — `Cannot find module './select'`.

- [ ] **Step 3: Write the prompt**

```typescript
// ee/claim-check/prompts/select.ts
//
// Our wording of the paper's Selection stage (arXiv 2502.10855 §3.2). The
// paper's appendix prompt is a behaviour reference, not a source text.

export const SELECT_SYSTEM = `You support a fact-checking pipeline.

You receive a QUESTION, an EXCERPT from an answer to that question, and a numbered list of
TARGET SENTENCES taken from that excerpt. For each target sentence, decide whether it contains
at least one specific, verifiable proposition — a statement that a fact-checker could confirm or
refute against source documents.

Rules:
- Whether the proposition is true or false does not matter.
- Whether it is relevant to the question does not matter.
- Unresolved pronouns or vague references do not matter: assume the fact-checker can resolve
  them. Judge only whether something specific is being asserted.
- A statement that information is missing or unavailable is NOT verifiable.
- A sentence that only introduces what the following sentences say, or only restates preceding
  sentences as a conclusion, is NOT verifiable.
- Opinions, recommendations, value judgements, generic statements and speculation are NOT
  verifiable.
- Citations, formatting and markup are irrelevant to the decision.
- Use the surrounding sentences to decide: a short sentence can be verifiable because the
  preceding sentence supplies its subject.

If a sentence mixes verifiable and unverifiable content, return a rewritten version that keeps
only the verifiable content, staying as close to the original wording as possible. If the whole
sentence is already verifiable, return null for the rewrite.

Answer for EVERY target sentence index you were given, and for no other index. Keep each reason
under 15 words.`;

export function selectUserPrompt(args: {
  question: string;
  excerpt: string;
  targets: { index: number; text: string }[];
}): string {
  return [
    "QUESTION:",
    args.question,
    "",
    "EXCERPT:",
    args.excerpt,
    "",
    "TARGET SENTENCES:",
    ...args.targets.map((t) => `[${t.index}] ${t.text}`),
  ].join("\n");
}
```

- [ ] **Step 4: Implement the stage**

```typescript
// ee/claim-check/stages/usage.ts
export type StageUsage = { calls: number; inputTokens: number; outputTokens: number };

export const EMPTY_USAGE: StageUsage = { calls: 0, inputTokens: 0, outputTokens: 0 };

export function addUsage(a: StageUsage, b: StageUsage): StageUsage {
  return {
    calls: a.calls + b.calls,
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
  };
}
```

```typescript
// ee/claim-check/stages/select.ts
import { z } from "zod";
import type { LanguageModel } from "ai";
import { microCall } from "@EE/agentic-retrieval/pipeline/micro-call";
import { CLAIM_CHECK_MAX_OUTPUT_TOKENS, type SelectionOutcome, type SentenceWindow } from "../types";
import { SELECT_SYSTEM, selectUserPrompt } from "../prompts/select";
import type { StageUsage } from "./usage";

const schema = z.object({
  sentences: z.array(
    z.object({
      index: z.number().int(),
      verifiable: z.boolean(),
      rewritten: z.string().nullable(),
      reason: z.string(),
    }),
  ),
});

/** The excerpt shown to the model: the batch's sentences plus their windows, in answer order. */
export function excerptFor(windows: SentenceWindow[]): string {
  const byIndex = new Map<number, string>();
  for (const w of windows) {
    for (const s of [...w.preceding, w.sentence, ...w.following]) byIndex.set(s.index, s.text);
  }
  return [...byIndex.entries()].sort((a, b) => a[0] - b[0]).map(([, text]) => text).join(" ");
}

export async function runSelection(args: {
  windows: SentenceWindow[];
  question: string;
  model: LanguageModel;
  temperature?: number;
}): Promise<{ outcomes: SelectionOutcome[]; usage: StageUsage }> {
  const targets = args.windows.map((w) => ({ index: w.sentence.index, text: w.sentence.text }));

  const { output, usage } = await microCall({
    model: args.model,
    system: SELECT_SYSTEM,
    prompt: selectUserPrompt({ question: args.question, excerpt: excerptFor(args.windows), targets }),
    schema,
    temperature: args.temperature ?? 0,
    maxOutputTokens: CLAIM_CHECK_MAX_OUTPUT_TOKENS,
  });

  const returned = new Map((output?.sentences ?? []).map((s) => [s.index, s]));

  // A sentence the model skipped is NOT silently promoted to "checked": an
  // unanswered sentence contributes nothing to the score instead of a verdict
  // nobody produced.
  const outcomes = targets.map(({ index }) => {
    const hit = returned.get(index);
    if (!hit) {
      return { index, verifiable: false, rewritten: null, reason: "no selection returned for this sentence" };
    }
    return {
      index,
      verifiable: hit.verifiable,
      rewritten: hit.rewritten && hit.rewritten.trim() ? hit.rewritten.trim() : null,
      reason: hit.reason,
    };
  });

  return { outcomes, usage: { calls: 1, ...usage } };
}
```

- [ ] **Step 5: Run the tests**

Run: `npm test -- ee/claim-check/stages/select.test.ts`
Expected: PASS, all five tests.

- [ ] **Step 6: Commit**

```bash
git add ee/claim-check/prompts/select.ts ee/claim-check/stages/select.ts ee/claim-check/stages/usage.ts ee/claim-check/stages/select.test.ts
git commit -m "feat(claim-check): add the Selection stage"
```

---

*(Tasks 6–13 continue in `2026-10-13-claim-check-stage-1-part-2.md`: Disambiguation, the merged fast-path call, Decomposition, Verification, scoring, the orchestrator, the HTTP endpoint, and the second-chance retrieval wiring.)*
