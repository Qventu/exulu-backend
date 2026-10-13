# Claim Check — Stage 1, Part 2 (Tasks 6–13)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Continue from `2026-10-13-claim-check-stage-1.md` (Tasks 1–5), whose **Global Constraints** and **Review Focus** sections apply to every task here.

**Spec:** `docs/superpowers/specs/2026-10-13-claim-check-design.md`
**Part 1:** `docs/superpowers/plans/2026-10-13-claim-check-stage-1.md`

---

### Task 6: `stages/disambiguate.ts` — the Disambiguation stage

**Files:**
- Create: `ee/claim-check/prompts/disambiguate.ts`
- Create: `ee/claim-check/stages/disambiguate.ts`
- Test: `ee/claim-check/stages/disambiguate.test.ts`

**Interfaces:**
- Consumes: `SentenceWindow`, `DisambiguationOutcome`, `CLAIM_CHECK_MAX_OUTPUT_TOKENS` (Task 1); `excerptFor` (Task 5, `stages/select.ts`); `StageUsage` (Task 5, `stages/usage.ts`).
- Produces: `runDisambiguation(args: { windows: SentenceWindow[]; question: string; sentenceTexts: Map<number, string>; model: LanguageModel; temperature?: number }): Promise<{ outcomes: DisambiguationOutcome[]; usage: StageUsage }>`.
  `sentenceTexts` carries Selection's rewrites, so this stage judges the text Selection kept, not the original.

- [ ] **Step 1: Write the failing tests**

```typescript
// ee/claim-check/stages/disambiguate.test.ts
jest.mock("@EE/agentic-retrieval/pipeline/micro-call", () => ({
  microCall: jest.fn(),
  microCallProviderOptions: jest.fn(),
}));
import { microCall } from "@EE/agentic-retrieval/pipeline/micro-call";
import { splitIntoSentences, buildWindows } from "../split";
import { runDisambiguation } from "./disambiguate";
import { CLAIM_CHECK_MAX_OUTPUT_TOKENS } from "../types";

const ANSWER = "Die FST-2XT meldet einen Fehler. Sie wurde dort getauscht.";
const windows = () => buildWindows(splitIntoSentences(ANSWER, "de"), 5, 0);

beforeEach(() => (microCall as jest.Mock).mockReset());

describe("runDisambiguation", () => {
  it("returns the clarified sentence when every ambiguity resolves", async () => {
    (microCall as jest.Mock).mockResolvedValue({
      output: {
        sentences: [
          { index: 0, resolvable: true, clarified: null, reason: "no ambiguity" },
          { index: 1, resolvable: true, clarified: "Die FST-2XT wurde im Schaltschrank getauscht.", reason: "'Sie' and 'dort' resolved from context" },
        ],
      },
      text: "",
      usage: { inputTokens: 800, outputTokens: 90 },
    });

    const { outcomes, usage } = await runDisambiguation({
      windows: windows(),
      question: "Was wurde getauscht?",
      sentenceTexts: new Map(),
      model: {} as any,
    });

    expect(usage).toEqual({ calls: 1, inputTokens: 800, outputTokens: 90 });
    expect(outcomes[1]).toEqual({
      index: 1,
      resolvable: true,
      clarified: "Die FST-2XT wurde im Schaltschrank getauscht.",
      reason: "'Sie' and 'dort' resolved from context",
    });
  });

  it("marks a sentence unresolvable when readers would not reach consensus", async () => {
    (microCall as jest.Mock).mockResolvedValue({
      output: {
        sentences: [{ index: 0, resolvable: false, clarified: null, reason: "two mutually exclusive readings" }],
      },
      text: "",
      usage: { inputTokens: 10, outputTokens: 10 },
    });
    const { outcomes } = await runDisambiguation({
      windows: windows().slice(0, 1),
      question: "q",
      sentenceTexts: new Map(),
      model: {} as any,
    });
    expect(outcomes[0]!.resolvable).toBe(false);
    expect(outcomes[0]!.clarified).toBeNull();
  });

  it("judges Selection's rewrite rather than the original sentence", async () => {
    (microCall as jest.Mock).mockResolvedValue({ output: { sentences: [] }, text: "", usage: { inputTokens: 1, outputTokens: 1 } });
    await runDisambiguation({
      windows: windows(),
      question: "q",
      sentenceTexts: new Map([[0, "Die FST-2XT meldet einen Fehler."], [1, "Sie wurde getauscht."]]),
      model: {} as any,
    });
    const prompt = String((microCall as jest.Mock).mock.calls[0][0].prompt);
    expect(prompt).toContain("[1] Sie wurde getauscht.");
    expect(prompt).not.toContain("Sie wurde dort getauscht.");
  });

  it("treats an omitted sentence as unresolvable and passes the raised output cap", async () => {
    (microCall as jest.Mock).mockResolvedValue({ output: { sentences: [] }, text: "", usage: { inputTokens: 1, outputTokens: 1 } });
    const { outcomes } = await runDisambiguation({
      windows: windows(),
      question: "q",
      sentenceTexts: new Map(),
      model: {} as any,
    });
    expect(outcomes).toHaveLength(2);
    expect(outcomes.every((o) => o.resolvable === false)).toBe(true);
    expect(outcomes[0]!.reason).toBe("no disambiguation returned for this sentence");
    expect((microCall as jest.Mock).mock.calls[0][0].maxOutputTokens).toBe(CLAIM_CHECK_MAX_OUTPUT_TOKENS);
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npm test -- ee/claim-check/stages/disambiguate.test.ts`
Expected: FAIL — `Cannot find module './disambiguate'`.

- [ ] **Step 3: Write the prompt**

```typescript
// ee/claim-check/prompts/disambiguate.ts
//
// Our wording of the paper's Disambiguation stage (arXiv 2502.10855 §3.3).
// This stage is the paper's distinctive contribution: it refuses to guess.

export const DISAMBIGUATE_SYSTEM = `You support a fact-checking pipeline.

You receive a QUESTION, an EXCERPT from an answer to it, and a numbered list of TARGET SENTENCES
from that excerpt. For each target sentence, find the linguistic ambiguity in it and decide
whether the question and the excerpt resolve that ambiguity.

Two kinds of ambiguity count:
1. REFERENTIAL — it is unclear what a word or phrase refers to ("they", "the policy", "there",
   "next year", "these differences"). Temporal references count. Vague or general wording
   ("some experts", "several") is NOT referential ambiguity.
2. STRUCTURAL — the grammar allows more than one reading. State the readings explicitly as
   "The sentence could be interpreted as: (1) ... (2) ...". A special case: whether a trailing
   clause is something an actor did, or an interpretation the author added.

Partial names, acronyms and abbreviations are NOT linguistic ambiguity. If the question or the
excerpt gives the full form, use it in the clarified sentence; if not, leave it exactly as it is
and do not count it as ambiguity.

The standard for resolution is consensus: would a group of readers shown the question and the
excerpt agree on one interpretation? If yes for every ambiguity in the sentence, return a
clarified sentence that resolves all of them (or null if nothing needed changing). If any single
ambiguity would leave readers split, the sentence cannot be used: return resolvable=false, even
when other parts of it are perfectly clear.

Never add information that the question and excerpt do not support. Answer for EVERY target index
you were given and for no other index. Keep each reason under 20 words.`;

export function disambiguateUserPrompt(args: {
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
// ee/claim-check/stages/disambiguate.ts
import { z } from "zod";
import type { LanguageModel } from "ai";
import { microCall } from "@EE/agentic-retrieval/pipeline/micro-call";
import { CLAIM_CHECK_MAX_OUTPUT_TOKENS, type DisambiguationOutcome, type SentenceWindow } from "../types";
import { DISAMBIGUATE_SYSTEM, disambiguateUserPrompt } from "../prompts/disambiguate";
import { excerptFor } from "./select";
import type { StageUsage } from "./usage";

const schema = z.object({
  sentences: z.array(
    z.object({
      index: z.number().int(),
      resolvable: z.boolean(),
      clarified: z.string().nullable(),
      reason: z.string(),
    }),
  ),
});

export async function runDisambiguation(args: {
  windows: SentenceWindow[];
  question: string;
  /** Selection's rewrites by sentence index; falls back to the original text. */
  sentenceTexts: Map<number, string>;
  model: LanguageModel;
  temperature?: number;
}): Promise<{ outcomes: DisambiguationOutcome[]; usage: StageUsage }> {
  const targets = args.windows.map((w) => ({
    index: w.sentence.index,
    text: args.sentenceTexts.get(w.sentence.index) ?? w.sentence.text,
  }));

  const { output, usage } = await microCall({
    model: args.model,
    system: DISAMBIGUATE_SYSTEM,
    prompt: disambiguateUserPrompt({
      question: args.question,
      excerpt: excerptFor(args.windows),
      targets,
    }),
    schema,
    temperature: args.temperature ?? 0,
    maxOutputTokens: CLAIM_CHECK_MAX_OUTPUT_TOKENS,
  });

  const returned = new Map((output?.sentences ?? []).map((s) => [s.index, s]));

  // An unanswered sentence is excluded, not assumed clear: this stage exists
  // to refuse rather than guess, and a missing answer is not a resolution.
  const outcomes = targets.map(({ index }) => {
    const hit = returned.get(index);
    if (!hit) {
      return { index, resolvable: false, clarified: null, reason: "no disambiguation returned for this sentence" };
    }
    return {
      index,
      resolvable: hit.resolvable,
      clarified: hit.resolvable && hit.clarified && hit.clarified.trim() ? hit.clarified.trim() : null,
      reason: hit.reason,
    };
  });

  return { outcomes, usage: { calls: 1, ...usage } };
}
```

- [ ] **Step 5: Run the tests**

Run: `npm test -- ee/claim-check/stages/disambiguate.test.ts`
Expected: PASS, all four tests.

- [ ] **Step 6: Commit**

```bash
git add ee/claim-check/prompts/disambiguate.ts ee/claim-check/stages/disambiguate.ts ee/claim-check/stages/disambiguate.test.ts
git commit -m "feat(claim-check): add the Disambiguation stage"
```

---

### Task 7: `stages/select-disambiguate.ts` — the merged fast-path call

**Files:**
- Create: `ee/claim-check/prompts/select-disambiguate.ts`
- Create: `ee/claim-check/stages/select-disambiguate.ts`
- Test: `ee/claim-check/stages/select-disambiguate.test.ts`

**Interfaces:**
- Consumes: the same types as Tasks 5–6, plus `excerptFor`.
- Produces: `runSelectAndDisambiguate(args: { windows: SentenceWindow[]; question: string; model: LanguageModel; temperature?: number }): Promise<{ selection: SelectionOutcome[]; disambiguation: DisambiguationOutcome[]; usage: StageUsage }>` — one LLM call returning both stages' outcomes. This is the `fidelity: "fast"` default; `fidelity: "paper"` calls Tasks 5 and 6 separately.

- [ ] **Step 1: Write the failing tests**

```typescript
// ee/claim-check/stages/select-disambiguate.test.ts
jest.mock("@EE/agentic-retrieval/pipeline/micro-call", () => ({
  microCall: jest.fn(),
  microCallProviderOptions: jest.fn(),
}));
import { microCall } from "@EE/agentic-retrieval/pipeline/micro-call";
import { splitIntoSentences, buildWindows } from "../split";
import { runSelectAndDisambiguate } from "./select-disambiguate";

const ANSWER =
  "Die FST-2XT ist eine Steuerung. Das zeigt, wie wichtig gute Technik ist. Sie wurde dort getauscht.";
const windows = () => buildWindows(splitIntoSentences(ANSWER, "de"), 5, 5);

beforeEach(() => (microCall as jest.Mock).mockReset());

describe("runSelectAndDisambiguate", () => {
  it("derives both stages' outcomes from a single call", async () => {
    (microCall as jest.Mock).mockResolvedValue({
      output: {
        sentences: [
          { index: 0, verifiable: true, rewritten: null, resolvable: true, clarified: null, reason: "clear fact" },
          { index: 1, verifiable: false, rewritten: null, resolvable: true, clarified: null, reason: "opinion" },
          { index: 2, verifiable: true, rewritten: "Sie wurde dort getauscht.", resolvable: false, clarified: null, reason: "'dort' is unresolvable" },
        ],
      },
      text: "",
      usage: { inputTokens: 1500, outputTokens: 300 },
    });

    const { selection, disambiguation, usage } = await runSelectAndDisambiguate({
      windows: windows(),
      question: "Was wurde getauscht?",
      model: {} as any,
    });

    expect((microCall as jest.Mock)).toHaveBeenCalledTimes(1);
    expect(usage).toEqual({ calls: 1, inputTokens: 1500, outputTokens: 300 });
    expect(selection.map((s) => s.verifiable)).toEqual([true, false, true]);
    expect(selection[2]!.rewritten).toBe("Sie wurde dort getauscht.");
    expect(disambiguation.map((d) => d.resolvable)).toEqual([true, true, false]);
  });

  it("forces resolvable=false for a sentence that failed selection, so it can never reach decomposition", async () => {
    (microCall as jest.Mock).mockResolvedValue({
      output: {
        sentences: [
          { index: 0, verifiable: false, rewritten: null, resolvable: true, clarified: "irrelevant", reason: "opinion" },
          { index: 1, verifiable: false, rewritten: null, resolvable: true, clarified: null, reason: "opinion" },
          { index: 2, verifiable: false, rewritten: null, resolvable: true, clarified: null, reason: "opinion" },
        ],
      },
      text: "",
      usage: { inputTokens: 10, outputTokens: 10 },
    });
    const { disambiguation } = await runSelectAndDisambiguate({ windows: windows(), question: "q", model: {} as any });
    expect(disambiguation.every((d) => d.resolvable === false)).toBe(true);
    expect(disambiguation[0]!.clarified).toBeNull();
  });

  it("treats an omitted sentence as neither verifiable nor resolvable", async () => {
    (microCall as jest.Mock).mockResolvedValue({ output: { sentences: [] }, text: "", usage: { inputTokens: 1, outputTokens: 1 } });
    const { selection, disambiguation } = await runSelectAndDisambiguate({ windows: windows(), question: "q", model: {} as any });
    expect(selection.every((s) => s.verifiable === false)).toBe(true);
    expect(disambiguation.every((d) => d.resolvable === false)).toBe(true);
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npm test -- ee/claim-check/stages/select-disambiguate.test.ts`
Expected: FAIL — `Cannot find module './select-disambiguate'`.

- [ ] **Step 3: Write the merged prompt**

```typescript
// ee/claim-check/prompts/select-disambiguate.ts
//
// The fast path merges the paper's Selection (§3.2) and Disambiguation (§3.3)
// stages into one call, the way the retrieval pipeline's engine v2 merges its
// memory and routing hops. Same rules, one hop.
import { SELECT_SYSTEM } from "./select";
import { DISAMBIGUATE_SYSTEM } from "./disambiguate";

export const SELECT_DISAMBIGUATE_SYSTEM = `${SELECT_SYSTEM}

AFTER deciding verifiability, perform a second judgement on the same sentence.

${DISAMBIGUATE_SYSTEM.replace("You support a fact-checking pipeline.\n\n", "")}

Return both judgements per sentence in one object: verifiable, rewritten, resolvable, clarified,
reason. If a sentence is not verifiable, the ambiguity judgement is irrelevant — return
resolvable=false and clarified=null for it.`;

export { selectUserPrompt as selectDisambiguateUserPrompt } from "./select";
```

- [ ] **Step 4: Implement the merged stage**

```typescript
// ee/claim-check/stages/select-disambiguate.ts
import { z } from "zod";
import type { LanguageModel } from "ai";
import { microCall } from "@EE/agentic-retrieval/pipeline/micro-call";
import {
  CLAIM_CHECK_MAX_OUTPUT_TOKENS,
  type DisambiguationOutcome,
  type SelectionOutcome,
  type SentenceWindow,
} from "../types";
import {
  SELECT_DISAMBIGUATE_SYSTEM,
  selectDisambiguateUserPrompt,
} from "../prompts/select-disambiguate";
import { excerptFor } from "./select";
import type { StageUsage } from "./usage";

const schema = z.object({
  sentences: z.array(
    z.object({
      index: z.number().int(),
      verifiable: z.boolean(),
      rewritten: z.string().nullable(),
      resolvable: z.boolean(),
      clarified: z.string().nullable(),
      reason: z.string(),
    }),
  ),
});

export async function runSelectAndDisambiguate(args: {
  windows: SentenceWindow[];
  question: string;
  model: LanguageModel;
  temperature?: number;
}): Promise<{
  selection: SelectionOutcome[];
  disambiguation: DisambiguationOutcome[];
  usage: StageUsage;
}> {
  const targets = args.windows.map((w) => ({ index: w.sentence.index, text: w.sentence.text }));

  const { output, usage } = await microCall({
    model: args.model,
    system: SELECT_DISAMBIGUATE_SYSTEM,
    prompt: selectDisambiguateUserPrompt({
      question: args.question,
      excerpt: excerptFor(args.windows),
      targets,
    }),
    schema,
    temperature: args.temperature ?? 0,
    maxOutputTokens: CLAIM_CHECK_MAX_OUTPUT_TOKENS,
  });

  const returned = new Map((output?.sentences ?? []).map((s) => [s.index, s]));
  const selection: SelectionOutcome[] = [];
  const disambiguation: DisambiguationOutcome[] = [];

  for (const { index } of targets) {
    const hit = returned.get(index);
    if (!hit) {
      selection.push({ index, verifiable: false, rewritten: null, reason: "no outcome returned for this sentence" });
      disambiguation.push({ index, resolvable: false, clarified: null, reason: "no outcome returned for this sentence" });
      continue;
    }
    selection.push({
      index,
      verifiable: hit.verifiable,
      rewritten: hit.rewritten && hit.rewritten.trim() ? hit.rewritten.trim() : null,
      reason: hit.reason,
    });
    // A sentence that failed selection must never reach decomposition, whatever
    // the model said about its ambiguity.
    const resolvable = hit.verifiable && hit.resolvable;
    disambiguation.push({
      index,
      resolvable,
      clarified: resolvable && hit.clarified && hit.clarified.trim() ? hit.clarified.trim() : null,
      reason: hit.reason,
    });
  }

  return { selection, disambiguation, usage: { calls: 1, ...usage } };
}
```

- [ ] **Step 5: Run the tests**

Run: `npm test -- ee/claim-check/stages/select-disambiguate.test.ts`
Expected: PASS, all three tests.

- [ ] **Step 6: Commit**

```bash
git add ee/claim-check/prompts/select-disambiguate.ts ee/claim-check/stages/select-disambiguate.ts ee/claim-check/stages/select-disambiguate.test.ts
git commit -m "feat(claim-check): add the merged selection+disambiguation fast path"
```

---

### Task 8: `stages/decompose.ts` — the Decomposition stage

**Files:**
- Create: `ee/claim-check/prompts/decompose.ts`
- Create: `ee/claim-check/stages/decompose.ts`
- Test: `ee/claim-check/stages/decompose.test.ts`

**Interfaces:**
- Consumes: `SentenceWindow`, `DecompositionOutcome`, `excerptFor`, `StageUsage`.
- Produces: `runDecomposition(args: { windows: SentenceWindow[]; question: string; sentenceTexts: Map<number, string>; model: LanguageModel; temperature?: number }): Promise<{ outcomes: DecompositionOutcome[]; usage: StageUsage }>`.

- [ ] **Step 1: Write the failing tests**

```typescript
// ee/claim-check/stages/decompose.test.ts
jest.mock("@EE/agentic-retrieval/pipeline/micro-call", () => ({
  microCall: jest.fn(),
  microCallProviderOptions: jest.fn(),
}));
import { microCall } from "@EE/agentic-retrieval/pipeline/micro-call";
import { splitIntoSentences, buildWindows } from "../split";
import { runDecomposition } from "./decompose";

const ANSWER = "Die FST-2XT arbeitet mit 230 Volt und wird im Schaltschrank montiert.";
const windows = () => buildWindows(splitIntoSentences(ANSWER, "de"), 5, 0);

beforeEach(() => (microCall as jest.Mock).mockReset());

describe("runDecomposition", () => {
  it("splits a conjunction into independently checkable claims", async () => {
    (microCall as jest.Mock).mockResolvedValue({
      output: {
        sentences: [
          {
            index: 0,
            claims: [
              { text: "Die FST-2XT arbeitet mit 230 Volt.", inferred: false },
              { text: "Die FST-2XT wird im Schaltschrank montiert.", inferred: false },
            ],
          },
        ],
      },
      text: "",
      usage: { inputTokens: 700, outputTokens: 150 },
    });

    const { outcomes, usage } = await runDecomposition({
      windows: windows(),
      question: "Womit arbeitet die FST-2XT?",
      sentenceTexts: new Map(),
      model: {} as any,
    });

    expect(usage).toEqual({ calls: 1, inputTokens: 700, outputTokens: 150 });
    expect(outcomes[0]!.claims).toHaveLength(2);
    expect(outcomes[0]!.claims[0]!.inferred).toBe(false);
  });

  it("keeps bracketed context and its inferred flag", async () => {
    (microCall as jest.Mock).mockResolvedValue({
      output: {
        sentences: [{ index: 0, claims: [{ text: "Die FST-2XT [eine Aufzugssteuerung] arbeitet mit 230 Volt.", inferred: true }] }],
      },
      text: "",
      usage: { inputTokens: 10, outputTokens: 10 },
    });
    const { outcomes } = await runDecomposition({ windows: windows(), question: "q", sentenceTexts: new Map(), model: {} as any });
    expect(outcomes[0]!.claims[0]!.text).toContain("[eine Aufzugssteuerung]");
    expect(outcomes[0]!.claims[0]!.inferred).toBe(true);
  });

  it("returns an empty claim list when the model extracts nothing, without inventing one", async () => {
    (microCall as jest.Mock).mockResolvedValue({
      output: { sentences: [{ index: 0, claims: [] }] },
      text: "",
      usage: { inputTokens: 10, outputTokens: 10 },
    });
    const { outcomes } = await runDecomposition({ windows: windows(), question: "q", sentenceTexts: new Map(), model: {} as any });
    expect(outcomes[0]!.claims).toEqual([]);
  });

  it("drops blank claim texts and claims for indexes not in the batch", async () => {
    (microCall as jest.Mock).mockResolvedValue({
      output: {
        sentences: [
          { index: 0, claims: [{ text: "   ", inferred: false }, { text: "Gültige Aussage.", inferred: false }] },
          { index: 77, claims: [{ text: "Fremder Index.", inferred: false }] },
        ],
      },
      text: "",
      usage: { inputTokens: 10, outputTokens: 10 },
    });
    const { outcomes } = await runDecomposition({ windows: windows(), question: "q", sentenceTexts: new Map(), model: {} as any });
    expect(outcomes.map((o) => o.index)).toEqual([0]);
    expect(outcomes[0]!.claims.map((c) => c.text)).toEqual(["Gültige Aussage."]);
  });

  it("decomposes the disambiguated text when one was supplied", async () => {
    (microCall as jest.Mock).mockResolvedValue({ output: { sentences: [] }, text: "", usage: { inputTokens: 1, outputTokens: 1 } });
    await runDecomposition({
      windows: windows(),
      question: "q",
      sentenceTexts: new Map([[0, "Die FST-2XT arbeitet mit 230 Volt."]]),
      model: {} as any,
    });
    const prompt = String((microCall as jest.Mock).mock.calls[0][0].prompt);
    expect(prompt).toContain("[0] Die FST-2XT arbeitet mit 230 Volt.");
    expect(prompt).not.toContain("im Schaltschrank montiert");
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npm test -- ee/claim-check/stages/decompose.test.ts`
Expected: FAIL — `Cannot find module './decompose'`.

- [ ] **Step 3: Write the prompt**

```typescript
// ee/claim-check/prompts/decompose.ts
//
// Our wording of the paper's Decomposition stage (arXiv 2502.10855 §3.4).

export const DECOMPOSE_SYSTEM = `You support a fact-checking pipeline.

You receive a QUESTION, an EXCERPT from an answer to it, and a numbered list of TARGET SENTENCES.
For each target sentence, produce the list of factual claims it makes.

Every claim must satisfy all of the following:
- SPECIFIC and VERIFIABLE: a fact-checker could confirm or refute it against source documents.
- ENTAILED by the target sentence: the sentence (read with its excerpt) must fully support the
  claim. Never add, strengthen or generalise anything. If the sentence attributes a property to
  two things jointly, do not split it into two claims that each assert it individually.
- STANDALONE: understandable by someone who sees only this one claim — not the question, not the
  excerpt, not the other claims. Resolve pronouns and references.
- MINIMAL in risk: keep the qualifying context that changes the verdict. A claim stripped of the
  condition it depended on ("… when member states fail to comply") is wrong even if its words
  are accurate.

Put context that the sentence itself does not state, but that the question or excerpt supplies,
in square brackets: "The [Boston] city council expects its law [banning plastic bags] to pass."
Set inferred=true for any claim that relies on such bracketed context, false otherwise.

Split a sentence into as many claims as it genuinely makes, and no more. If a sentence makes no
verifiable claim after all, return an empty list for it — never invent one. Answer for EVERY
target index you were given and for no other index.`;

export function decomposeUserPrompt(args: {
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
// ee/claim-check/stages/decompose.ts
import { z } from "zod";
import type { LanguageModel } from "ai";
import { microCall } from "@EE/agentic-retrieval/pipeline/micro-call";
import { CLAIM_CHECK_MAX_OUTPUT_TOKENS, type DecompositionOutcome, type SentenceWindow } from "../types";
import { DECOMPOSE_SYSTEM, decomposeUserPrompt } from "../prompts/decompose";
import { excerptFor } from "./select";
import type { StageUsage } from "./usage";

const schema = z.object({
  sentences: z.array(
    z.object({
      index: z.number().int(),
      claims: z.array(z.object({ text: z.string(), inferred: z.boolean() })),
    }),
  ),
});

export async function runDecomposition(args: {
  windows: SentenceWindow[];
  question: string;
  /** Disambiguated (or selection-rewritten) text by index; falls back to the original. */
  sentenceTexts: Map<number, string>;
  model: LanguageModel;
  temperature?: number;
}): Promise<{ outcomes: DecompositionOutcome[]; usage: StageUsage }> {
  const targets = args.windows.map((w) => ({
    index: w.sentence.index,
    text: args.sentenceTexts.get(w.sentence.index) ?? w.sentence.text,
  }));
  const allowed = new Set(targets.map((t) => t.index));

  const { output, usage } = await microCall({
    model: args.model,
    system: DECOMPOSE_SYSTEM,
    prompt: decomposeUserPrompt({
      question: args.question,
      excerpt: excerptFor(args.windows),
      targets,
    }),
    schema,
    temperature: args.temperature ?? 0,
    maxOutputTokens: CLAIM_CHECK_MAX_OUTPUT_TOKENS,
  });

  const outcomes: DecompositionOutcome[] = [];
  for (const sentence of output?.sentences ?? []) {
    // A hallucinated index has no sentence to highlight, so it cannot be scored.
    if (!allowed.has(sentence.index)) continue;
    outcomes.push({
      index: sentence.index,
      claims: sentence.claims
        .filter((c) => c.text.trim().length > 0)
        .map((c) => ({ text: c.text.trim(), inferred: c.inferred })),
    });
  }

  return { outcomes, usage: { calls: 1, ...usage } };
}
```

- [ ] **Step 5: Run the tests**

Run: `npm test -- ee/claim-check/stages/decompose.test.ts`
Expected: PASS, all five tests.

- [ ] **Step 6: Commit**

```bash
git add ee/claim-check/prompts/decompose.ts ee/claim-check/stages/decompose.ts ee/claim-check/stages/decompose.test.ts
git commit -m "feat(claim-check): add the Decomposition stage"
```

---

### Task 9: `stages/verify.ts` — grounding verdicts against the selected evidence

**Files:**
- Create: `ee/claim-check/prompts/verify.ts`
- Create: `ee/claim-check/stages/verify.ts`
- Test: `ee/claim-check/stages/verify.test.ts`

**Interfaces:**
- Consumes: `EvidenceSnippet`, `VerifyOutcome`, `Verdict`, `StageUsage`.
- Produces: `runVerification(args: { claims: { id: string; text: string }[]; evidence: EvidenceSnippet[]; model: LanguageModel; temperature?: number }): Promise<{ outcomes: VerifyOutcome[]; usage: StageUsage }>`.
  Claims arriving here already share an evidence neighbourhood — the orchestrator groups them (Task 11). With an empty evidence set every claim is `unsupported` **without** an LLM call.

- [ ] **Step 1: Write the failing tests**

```typescript
// ee/claim-check/stages/verify.test.ts
jest.mock("@EE/agentic-retrieval/pipeline/micro-call", () => ({
  microCall: jest.fn(),
  microCallProviderOptions: jest.fn(),
}));
import { microCall } from "@EE/agentic-retrieval/pipeline/micro-call";
import { runVerification } from "./verify";
import type { EvidenceSnippet } from "../types";

const EVIDENCE: EvidenceSnippet[] = [
  { sourceId: "s1", sourceName: "handbuch.pdf", text: "Die FST-2XT arbeitet mit 230 Volt.", score: 3 },
  { sourceId: "s2", sourceName: "ticket.txt", text: "Die Tür wurde am 3. März getauscht.", score: 1 },
];

const CLAIMS = [
  { id: "c1", text: "Die FST-2XT arbeitet mit 230 Volt." },
  { id: "c2", text: "Die FST-2XT arbeitet mit 400 Volt." },
  { id: "c3", text: "Die FST-2XT wiegt 12 Kilogramm." },
];

beforeEach(() => (microCall as jest.Mock).mockReset());

describe("runVerification", () => {
  it("maps the three verdicts and echoes the evidence source ids", async () => {
    (microCall as jest.Mock).mockResolvedValue({
      output: {
        claims: [
          { claimId: "c1", verdict: "supported", evidence: [{ sourceId: "s1", quote: "arbeitet mit 230 Volt" }], rationale: "snippet states it" },
          { claimId: "c2", verdict: "contradicted", evidence: [{ sourceId: "s1", quote: "arbeitet mit 230 Volt" }], rationale: "snippet says 230 V" },
          { claimId: "c3", verdict: "unsupported", evidence: [], rationale: "no snippet mentions weight" },
        ],
      },
      text: "",
      usage: { inputTokens: 1100, outputTokens: 200 },
    });

    const { outcomes, usage } = await runVerification({ claims: CLAIMS, evidence: EVIDENCE, model: {} as any });

    expect(usage).toEqual({ calls: 1, inputTokens: 1100, outputTokens: 200 });
    expect(outcomes.map((o) => o.verdict)).toEqual(["supported", "contradicted", "unsupported"]);
    expect(outcomes[0]!.evidence).toEqual([{ sourceId: "s1", quote: "arbeitet mit 230 Volt" }]);
  });

  it("returns unsupported for every claim WITHOUT calling the model when there is no evidence", async () => {
    const { outcomes, usage } = await runVerification({ claims: CLAIMS, evidence: [], model: {} as any });
    expect(microCall).not.toHaveBeenCalled();
    expect(usage).toEqual({ calls: 0, inputTokens: 0, outputTokens: 0 });
    expect(outcomes.every((o) => o.verdict === "unsupported")).toBe(true);
    expect(outcomes[0]!.rationale).toBe("no evidence was available for this claim");
  });

  it("treats an omitted claim as unsupported rather than supported", async () => {
    (microCall as jest.Mock).mockResolvedValue({
      output: { claims: [{ claimId: "c1", verdict: "supported", evidence: [], rationale: "ok" }] },
      text: "",
      usage: { inputTokens: 10, outputTokens: 10 },
    });
    const { outcomes } = await runVerification({ claims: CLAIMS, evidence: EVIDENCE, model: {} as any });
    expect(outcomes).toHaveLength(3);
    expect(outcomes[1]).toEqual({
      claimId: "c2",
      verdict: "unsupported",
      evidence: [],
      rationale: "no verdict returned for this claim",
    });
  });

  it("drops evidence citations for source ids that were not in the prompt", async () => {
    (microCall as jest.Mock).mockResolvedValue({
      output: {
        claims: [{ claimId: "c1", verdict: "supported", evidence: [{ sourceId: "s9", quote: "erfunden" }], rationale: "cites a source that was never shown" }],
      },
      text: "",
      usage: { inputTokens: 10, outputTokens: 10 },
    });
    const { outcomes } = await runVerification({ claims: [CLAIMS[0]!], evidence: EVIDENCE, model: {} as any });
    expect(outcomes[0]!.evidence).toEqual([]);
    expect(outcomes[0]!.verdict).toBe("supported");
  });

  it("numbers the snippets and names their sources in the prompt", async () => {
    (microCall as jest.Mock).mockResolvedValue({ output: { claims: [] }, text: "", usage: { inputTokens: 1, outputTokens: 1 } });
    await runVerification({ claims: CLAIMS, evidence: EVIDENCE, model: {} as any });
    const prompt = String((microCall as jest.Mock).mock.calls[0][0].prompt);
    expect(prompt).toContain("s1");
    expect(prompt).toContain("handbuch.pdf");
    expect(prompt).toContain("c1");
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npm test -- ee/claim-check/stages/verify.test.ts`
Expected: FAIL — `Cannot find module './verify'`.

- [ ] **Step 3: Write the prompt**

```typescript
// ee/claim-check/prompts/verify.ts
//
// This stage is NOT from the paper: Claimify stops at extraction. The verdict
// vocabulary is ours (spec §2.4) and the distinction between "the sources say
// otherwise" and "the sources are silent" is the whole point of it.

export const VERIFY_SYSTEM = `You are a strict fact-checker.

You receive numbered EVIDENCE snippets, each tagged with the id of the source it came from, and a
list of CLAIMS. For each claim, return exactly one verdict:

- "supported" — the evidence entails the claim. Everything the claim asserts follows from the
  snippets. Partial support is not support.
- "contradicted" — a snippet states something incompatible with the claim (a different value,
  date, cause or outcome; a denial of what the claim asserts).
- "unsupported" — the evidence neither entails nor contradicts the claim; it is silent on it.

Rules:
- Use ONLY the evidence. Your own knowledge of the world is irrelevant, however certain you are.
- Text in square brackets inside a claim is context added by an earlier stage. Judge the claim as
  a whole, including that context.
- "supported" requires a quote: cite the source ids whose text carried the verdict, with the
  shortest quote that does so. Cite source ids for "contradicted" too.
- Cite only source ids that appear in the evidence you were given.
- Write the rationale in the language of the claim, in one sentence.

Answer for EVERY claim id you were given and for no other id.`;

export function verifyUserPrompt(args: {
  claims: { id: string; text: string }[];
  evidence: { sourceId: string; sourceName?: string; text: string }[];
}): string {
  return [
    "EVIDENCE:",
    ...args.evidence.map(
      (e, i) => `[${i + 1}] (sourceId: ${e.sourceId}${e.sourceName ? `, source: ${e.sourceName}` : ""})\n${e.text}`,
    ),
    "",
    "CLAIMS:",
    ...args.claims.map((c) => `(${c.id}) ${c.text}`),
  ].join("\n");
}
```

- [ ] **Step 4: Implement the stage**

```typescript
// ee/claim-check/stages/verify.ts
import { z } from "zod";
import type { LanguageModel } from "ai";
import { microCall } from "@EE/agentic-retrieval/pipeline/micro-call";
import { CLAIM_CHECK_MAX_OUTPUT_TOKENS, type EvidenceSnippet, type VerifyOutcome } from "../types";
import { VERIFY_SYSTEM, verifyUserPrompt } from "../prompts/verify";
import { EMPTY_USAGE, type StageUsage } from "./usage";

const schema = z.object({
  claims: z.array(
    z.object({
      claimId: z.string(),
      verdict: z.enum(["supported", "contradicted", "unsupported"]),
      evidence: z.array(z.object({ sourceId: z.string(), quote: z.string() })),
      rationale: z.string(),
    }),
  ),
});

export async function runVerification(args: {
  claims: { id: string; text: string }[];
  evidence: EvidenceSnippet[];
  model: LanguageModel;
  temperature?: number;
}): Promise<{ outcomes: VerifyOutcome[]; usage: StageUsage }> {
  if (args.claims.length === 0) return { outcomes: [], usage: { ...EMPTY_USAGE } };

  // No evidence means nothing to check against. Asking a model anyway would
  // invite it to answer from its own knowledge, which is exactly the failure
  // this feature exists to detect.
  if (args.evidence.length === 0) {
    return {
      outcomes: args.claims.map((c) => ({
        claimId: c.id,
        verdict: "unsupported" as const,
        evidence: [],
        rationale: "no evidence was available for this claim",
      })),
      usage: { ...EMPTY_USAGE },
    };
  }

  const { output, usage } = await microCall({
    model: args.model,
    system: VERIFY_SYSTEM,
    prompt: verifyUserPrompt({ claims: args.claims, evidence: args.evidence }),
    schema,
    temperature: args.temperature ?? 0,
    maxOutputTokens: CLAIM_CHECK_MAX_OUTPUT_TOKENS,
  });

  const knownSourceIds = new Set(args.evidence.map((e) => e.sourceId));
  const returned = new Map((output?.claims ?? []).map((c) => [c.claimId, c]));

  const outcomes = args.claims.map(({ id }) => {
    const hit = returned.get(id);
    if (!hit) {
      return { claimId: id, verdict: "unsupported" as const, evidence: [], rationale: "no verdict returned for this claim" };
    }
    return {
      claimId: id,
      verdict: hit.verdict,
      // A citation to a source that was never shown is not traceable, so it is
      // dropped; the verdict itself stands with its rationale.
      evidence: hit.evidence.filter((e) => knownSourceIds.has(e.sourceId)),
      rationale: hit.rationale,
    };
  });

  return { outcomes, usage: { calls: 1, ...usage } };
}
```

- [ ] **Step 5: Run the tests**

Run: `npm test -- ee/claim-check/stages/verify.test.ts`
Expected: PASS, all five tests.

- [ ] **Step 6: Commit**

```bash
git add ee/claim-check/prompts/verify.ts ee/claim-check/stages/verify.ts ee/claim-check/stages/verify.test.ts
git commit -m "feat(claim-check): add the grounding verification stage"
```

---

### Task 10: `score.ts` — aggregation, labels, sentence results

**Files:**
- Create: `ee/claim-check/score.ts`
- Test: `ee/claim-check/score.test.ts`

**Interfaces:**
- Consumes: `Claim`, `ClaimCheckScore`, `ScoreLabel`, `Sentence`, `SentenceResult`, `SentenceState` (Task 1).
- Produces:
  - `scoreClaims(claims: Claim[], thresholds: { warn: number; alert: number }): ClaimCheckScore`
  - `buildSentenceResults(sentences: Sentence[], states: Map<number, { state: SentenceState; reason?: string }>, claims: Claim[]): SentenceResult[]`

- [ ] **Step 1: Write the failing tests**

```typescript
// ee/claim-check/score.test.ts
import { scoreClaims, buildSentenceResults } from "./score";
import type { Claim, Sentence, SentenceState } from "./types";

const THRESHOLDS = { warn: 0.1, alert: 0.3 };

const claim = (id: string, verdict: Claim["verdict"], sentenceIndex = 0): Claim => ({
  id,
  sentenceIndex,
  text: `claim ${id}`,
  inferred: false,
  verdict,
  evidence: [],
  rationale: "",
  rechecked: false,
});

describe("scoreClaims", () => {
  it("counts the three verdicts separately and derives the combined share", () => {
    const score = scoreClaims(
      [
        claim("c1", "supported"),
        claim("c2", "supported"),
        claim("c3", "contradicted"),
        claim("c4", "unsupported"),
      ],
      THRESHOLDS,
    );
    expect(score).toEqual({
      claims: 4,
      supported: 2,
      contradicted: 1,
      unsupported: 1,
      unsupportedShare: 0.5,
      label: "alert",
    });
  });

  it("labels on inclusive lower bounds: below warn is ok, warn is warn, alert is alert", () => {
    const supported = (n: number) => Array.from({ length: n }, (_, i) => claim(`s${i}`, "supported"));
    // 0/10 => 0 => ok
    expect(scoreClaims(supported(10), THRESHOLDS).label).toBe("ok");
    // 1/10 => 0.1 => exactly warn
    expect(scoreClaims([...supported(9), claim("x", "unsupported")], THRESHOLDS).label).toBe("warn");
    // 2/10 => 0.2 => still warn
    expect(
      scoreClaims([...supported(8), claim("x", "unsupported"), claim("y", "unsupported")], THRESHOLDS).label,
    ).toBe("warn");
    // 3/10 => 0.3 => exactly alert
    expect(
      scoreClaims(
        [...supported(7), claim("x", "unsupported"), claim("y", "unsupported"), claim("z", "contradicted")],
        THRESHOLDS,
      ).label,
    ).toBe("alert");
  });

  // Review Focus 4
  it("returns label n/a and share 0 when there are no checkable claims — never 0 as a verdict", () => {
    const score = scoreClaims([], THRESHOLDS);
    expect(score).toEqual({
      claims: 0,
      supported: 0,
      contradicted: 0,
      unsupported: 0,
      unsupportedShare: 0,
      label: "n/a",
    });
    expect(Number.isNaN(score.unsupportedShare)).toBe(false);
  });

  it("rounds the share to four decimals rather than emitting a repeating float", () => {
    const score = scoreClaims([claim("a", "supported"), claim("b", "supported"), claim("c", "unsupported")], THRESHOLDS);
    expect(score.unsupportedShare).toBe(0.3333);
  });

  it("respects custom thresholds", () => {
    const strict = scoreClaims([claim("a", "supported"), claim("b", "unsupported")], { warn: 0.6, alert: 0.9 });
    expect(strict.unsupportedShare).toBe(0.5);
    expect(strict.label).toBe("ok");
  });
});

describe("buildSentenceResults", () => {
  const sentences: Sentence[] = [
    { index: 0, start: 0, end: 10, text: "Satz eins.", headingPath: [] },
    { index: 1, start: 11, end: 21, text: "Satz zwei.", headingPath: [] },
    { index: 2, start: 22, end: 32, text: "Satz drei.", headingPath: [] },
  ];

  it("carries offsets, state, reason and the claim ids of each sentence", () => {
    const states = new Map<number, { state: SentenceState; reason?: string }>([
      [0, { state: "checked" }],
      [1, { state: "no_verifiable_content", reason: "opinion" }],
      [2, { state: "cannot_disambiguate", reason: "'dort' unresolvable" }],
    ]);
    const results = buildSentenceResults(sentences, states, [claim("c1", "supported", 0), claim("c2", "unsupported", 0)]);

    expect(results[0]).toEqual({ index: 0, start: 0, end: 10, state: "checked", claimIds: ["c1", "c2"] });
    expect(results[1]).toEqual({ index: 1, start: 11, end: 21, state: "no_verifiable_content", reason: "opinion", claimIds: [] });
    expect(results[2]!.state).toBe("cannot_disambiguate");
  });

  it("defaults a sentence with no recorded state to not_checked", () => {
    const results = buildSentenceResults(sentences, new Map(), []);
    expect(results.every((r) => r.state === "not_checked")).toBe(true);
    expect(results[0]!.reason).toBe("stage did not report an outcome for this sentence");
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npm test -- ee/claim-check/score.test.ts`
Expected: FAIL — `Cannot find module './score'`.

- [ ] **Step 3: Implement `score.ts`**

```typescript
// ee/claim-check/score.ts
//
// The honesty rules of the whole feature live here (spec §2.4):
//  1. only CHECKED claims are in the denominator — dropped sentences never
//     drag the number down;
//  2. "contradicted" and "unsupported" stay separate, because "the sources say
//     otherwise" and "the sources are silent" are different problems;
//  3. no checkable claims => "n/a", never 0, which would read as a failure.
import type {
  Claim,
  ClaimCheckScore,
  ScoreLabel,
  Sentence,
  SentenceResult,
  SentenceState,
} from "./types";

function labelFor(share: number, thresholds: { warn: number; alert: number }): ScoreLabel {
  if (share >= thresholds.alert) return "alert";
  if (share >= thresholds.warn) return "warn";
  return "ok";
}

export function scoreClaims(
  claims: Claim[],
  thresholds: { warn: number; alert: number },
): ClaimCheckScore {
  const supported = claims.filter((c) => c.verdict === "supported").length;
  const contradicted = claims.filter((c) => c.verdict === "contradicted").length;
  const unsupported = claims.filter((c) => c.verdict === "unsupported").length;
  const total = claims.length;

  if (total === 0) {
    return { claims: 0, supported: 0, contradicted: 0, unsupported: 0, unsupportedShare: 0, label: "n/a" };
  }

  const share = Number(((contradicted + unsupported) / total).toFixed(4));
  return {
    claims: total,
    supported,
    contradicted,
    unsupported,
    unsupportedShare: share,
    label: labelFor(share, thresholds),
  };
}

export function buildSentenceResults(
  sentences: Sentence[],
  states: Map<number, { state: SentenceState; reason?: string }>,
  claims: Claim[],
): SentenceResult[] {
  const claimIdsBySentence = new Map<number, string[]>();
  for (const claim of claims) {
    const list = claimIdsBySentence.get(claim.sentenceIndex) ?? [];
    list.push(claim.id);
    claimIdsBySentence.set(claim.sentenceIndex, list);
  }

  return sentences.map((sentence) => {
    const recorded = states.get(sentence.index) ?? {
      state: "not_checked" as SentenceState,
      reason: "stage did not report an outcome for this sentence",
    };
    const result: SentenceResult = {
      index: sentence.index,
      start: sentence.start,
      end: sentence.end,
      state: recorded.state,
      claimIds: claimIdsBySentence.get(sentence.index) ?? [],
    };
    if (recorded.reason) result.reason = recorded.reason;
    return result;
  });
}
```

- [ ] **Step 4: Run the tests**

Run: `npm test -- ee/claim-check/score.test.ts`
Expected: PASS, all seven tests.

- [ ] **Step 5: Commit**

```bash
git add ee/claim-check/score.ts ee/claim-check/score.test.ts
git commit -m "feat(claim-check): add scoring with separate contradicted and unsupported counts"
```

---

### Task 11: `concurrency.ts` + `run.ts` — the orchestrator

**Files:**
- Create: `ee/claim-check/concurrency.ts`
- Create: `ee/claim-check/run.ts`
- Test: `ee/claim-check/concurrency.test.ts`
- Test: `ee/claim-check/run.test.ts`

**Interfaces:**
- Consumes: `splitIntoSentences`, `buildWindows`, `localeFromText` (Task 3); `indexSources`, `selectEvidence` (Task 4); `runSelection` (Task 5); `runDisambiguation` (Task 6); `runSelectAndDisambiguate` (Task 7); `runDecomposition` (Task 8); `runVerification` (Task 9); `scoreClaims`, `buildSentenceResults` (Task 10); `addUsage`, `EMPTY_USAGE` (Task 5).
- Produces:
  - `mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<PromiseSettledResult<R>[]>`
  - `runClaimCheck(args: { question: string; answer: string; sources: ClaimCheckSource[]; model: LanguageModel; options?: ClaimCheckOptions; locale?: string; secondChance?: (claimText: string) => Promise<EvidenceSnippet[]> }): Promise<ClaimCheckResult>` — `options` omitted means `CLAIM_CHECK_DEFAULTS`
  - constants `BATCH = { selectDisambiguate: 10, decompose: 5, verifySentences: 3 }`, `MAX_IN_FLIGHT = 6`, `STAGE_FAILURE_ABORT = 0.4`

- [ ] **Step 1: Write the failing concurrency tests**

```typescript
// ee/claim-check/concurrency.test.ts
import { mapWithConcurrency } from "./concurrency";

describe("mapWithConcurrency", () => {
  it("never exceeds the limit and preserves input order in the results", async () => {
    let inFlight = 0;
    let peak = 0;
    const items = [1, 2, 3, 4, 5, 6, 7, 8];
    const results = await mapWithConcurrency(items, 3, async (n) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return n * 2;
    });
    expect(peak).toBeLessThanOrEqual(3);
    expect(results.map((r) => (r.status === "fulfilled" ? r.value : null))).toEqual([2, 4, 6, 8, 10, 12, 14, 16]);
  });

  it("reports a rejection per item instead of failing the whole batch", async () => {
    const results = await mapWithConcurrency([1, 2, 3], 2, async (n) => {
      if (n === 2) throw new Error("boom");
      return n;
    });
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "rejected", "fulfilled"]);
  });

  it("returns an empty array for no items and treats a limit below 1 as 1", async () => {
    expect(await mapWithConcurrency([], 4, async (n) => n)).toEqual([]);
    const results = await mapWithConcurrency([1, 2], 0, async (n) => n);
    expect(results).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npm test -- ee/claim-check/concurrency.test.ts`
Expected: FAIL — `Cannot find module './concurrency'`.

- [ ] **Step 3: Implement `concurrency.ts`**

```typescript
// ee/claim-check/concurrency.ts
//
// Bounded fan-out. A check is a few dozen provider calls; letting them all go
// at once manufactures the 429s the retry logic then has to absorb.

export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  const bound = Math.max(1, Math.floor(limit));
  let next = 0;

  const worker = async (): Promise<void> => {
    while (true) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      try {
        results[index] = { status: "fulfilled", value: await fn(items[index]!, index) };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(bound, items.length) }, () => worker()));
  return results;
}
```

- [ ] **Step 4: Run the concurrency tests**

Run: `npm test -- ee/claim-check/concurrency.test.ts`
Expected: PASS, all three tests.

- [ ] **Step 5: Write the failing orchestrator tests**

```typescript
// ee/claim-check/run.test.ts
jest.mock("./stages/select-disambiguate", () => ({ runSelectAndDisambiguate: jest.fn() }));
jest.mock("./stages/select", () => ({ runSelection: jest.fn(), excerptFor: jest.fn(() => "excerpt") }));
jest.mock("./stages/disambiguate", () => ({ runDisambiguation: jest.fn() }));
jest.mock("./stages/decompose", () => ({ runDecomposition: jest.fn() }));
jest.mock("./stages/verify", () => ({ runVerification: jest.fn() }));

import { runSelectAndDisambiguate } from "./stages/select-disambiguate";
import { runSelection } from "./stages/select";
import { runDisambiguation } from "./stages/disambiguate";
import { runDecomposition } from "./stages/decompose";
import { runVerification } from "./stages/verify";
import { runClaimCheck } from "./run";
import { CLAIM_CHECK_DEFAULTS, type ClaimCheckOptions } from "./types";

const USAGE = { calls: 1, inputTokens: 100, outputTokens: 10 };
const options = (over: Partial<ClaimCheckOptions> = {}): ClaimCheckOptions => ({
  ...CLAIM_CHECK_DEFAULTS,
  ...over,
  thresholds: { ...CLAIM_CHECK_DEFAULTS.thresholds, ...(over.thresholds ?? {}) },
  caps: { ...CLAIM_CHECK_DEFAULTS.caps, ...(over.caps ?? {}) },
});

const SOURCES = [{ id: "s1", content: "Die FST-2XT arbeitet mit 230 Volt im Schaltschrank." }];
const ANSWER = "Die FST-2XT arbeitet mit 230 Volt. Das ist beeindruckend. Sie sitzt im Schaltschrank.";

/** All three sentences verifiable and resolvable. */
const allClear = (indexes: number[]) => ({
  selection: indexes.map((index) => ({ index, verifiable: true, rewritten: null, reason: "fact" })),
  disambiguation: indexes.map((index) => ({ index, resolvable: true, clarified: null, reason: "clear" })),
  usage: USAGE,
});

beforeEach(() => {
  [runSelectAndDisambiguate, runSelection, runDisambiguation, runDecomposition, runVerification].forEach((m) =>
    (m as jest.Mock).mockReset(),
  );
});

describe("runClaimCheck — fast path", () => {
  it("uses the merged call, then decomposition, then verification, and assembles a scored result", async () => {
    (runSelectAndDisambiguate as jest.Mock).mockImplementation(async ({ windows }) =>
      allClear(windows.map((w: any) => w.sentence.index)),
    );
    (runDecomposition as jest.Mock).mockImplementation(async ({ windows }) => ({
      outcomes: windows.map((w: any) => ({
        index: w.sentence.index,
        claims: [{ text: `claim for ${w.sentence.index}`, inferred: false }],
      })),
      usage: USAGE,
    }));
    (runVerification as jest.Mock).mockImplementation(async ({ claims }) => ({
      outcomes: claims.map((c: any, i: number) => ({
        claimId: c.id,
        verdict: i === 0 ? "supported" : "unsupported",
        evidence: [],
        rationale: "r",
      })),
      usage: USAGE,
    }));

    const result = await runClaimCheck({
      question: "Womit arbeitet die FST-2XT?",
      answer: ANSWER,
      sources: SOURCES,
      model: {} as any,
      options: options(),
      locale: "de",
    });

    expect(runSelection).not.toHaveBeenCalled();
    expect(runDisambiguation).not.toHaveBeenCalled();
    expect(result.status).toBe("ok");
    expect(result.claims).toHaveLength(3);
    expect(result.claims.map((c) => c.id)).toEqual(["c1", "c2", "c3"]);
    expect(result.score.claims).toBe(3);
    expect(result.sentences.every((s) => s.state === "checked")).toBe(true);
    expect(result.usage.calls).toBeGreaterThanOrEqual(3);
    expect(result.timings.totalMs).toBeGreaterThanOrEqual(0);
  });

  it("records dropped sentences with their reason and keeps them out of the score", async () => {
    (runSelectAndDisambiguate as jest.Mock).mockImplementation(async ({ windows }) => ({
      selection: windows.map((w: any) => ({
        index: w.sentence.index,
        verifiable: w.sentence.index !== 1,
        rewritten: null,
        reason: w.sentence.index === 1 ? "opinion" : "fact",
      })),
      disambiguation: windows.map((w: any) => ({
        index: w.sentence.index,
        resolvable: w.sentence.index === 0,
        clarified: null,
        reason: w.sentence.index === 2 ? "'Sie' unresolvable" : "clear",
      })),
      usage: USAGE,
    }));
    (runDecomposition as jest.Mock).mockResolvedValue({
      outcomes: [{ index: 0, claims: [{ text: "c", inferred: false }] }],
      usage: USAGE,
    });
    (runVerification as jest.Mock).mockImplementation(async ({ claims }) => ({
      outcomes: claims.map((c: any) => ({ claimId: c.id, verdict: "supported", evidence: [], rationale: "r" })),
      usage: USAGE,
    }));

    const result = await runClaimCheck({
      question: "q", answer: ANSWER, sources: SOURCES, model: {} as any, options: options(), locale: "de",
    });

    expect(result.sentences.map((s) => s.state)).toEqual(["checked", "no_verifiable_content", "cannot_disambiguate"]);
    expect(result.sentences[1]!.reason).toBe("opinion");
    expect(result.score.claims).toBe(1);
    // Decomposition only ever saw the surviving sentence.
    expect((runDecomposition as jest.Mock).mock.calls[0][0].windows).toHaveLength(1);
  });

  // Review Focus 4
  it("returns label n/a with no claims when every sentence is dropped, and never calls verification", async () => {
    (runSelectAndDisambiguate as jest.Mock).mockImplementation(async ({ windows }) => ({
      selection: windows.map((w: any) => ({ index: w.sentence.index, verifiable: false, rewritten: null, reason: "pleasantry" })),
      disambiguation: windows.map((w: any) => ({ index: w.sentence.index, resolvable: false, clarified: null, reason: "pleasantry" })),
      usage: USAGE,
    }));

    const result = await runClaimCheck({
      question: "q", answer: "Gern! Immer wieder.", sources: SOURCES, model: {} as any, options: options(), locale: "de",
    });

    expect(runDecomposition).not.toHaveBeenCalled();
    expect(runVerification).not.toHaveBeenCalled();
    expect(result.claims).toEqual([]);
    expect(result.score.label).toBe("n/a");
    expect(result.status).toBe("ok");
  });
});

describe("runClaimCheck — resilience", () => {
  it("bisects a failed batch once and only marks the still-failing half not_checked", async () => {
    const seen: number[][] = [];
    (runSelectAndDisambiguate as jest.Mock).mockImplementation(async ({ windows }) => {
      const indexes = windows.map((w: any) => w.sentence.index);
      seen.push(indexes);
      if (indexes.length > 1) throw new Error("batch too big for the provider today");
      if (indexes[0] === 2) throw new Error("still failing");
      return allClear(indexes);
    });
    (runDecomposition as jest.Mock).mockResolvedValue({ outcomes: [], usage: USAGE });

    const result = await runClaimCheck({
      question: "q", answer: ANSWER, sources: SOURCES, model: {} as any, options: options(), locale: "de",
    });

    // One full batch, then its halves.
    expect(seen[0]).toEqual([0, 1, 2]);
    expect(seen.length).toBeGreaterThan(1);
    expect(result.status).toBe("partial");
    expect(result.sentences.find((s) => s.index === 2)!.state).toBe("not_checked");
    expect(result.notes.join(" ")).toContain("not_checked");
  });

  it("aborts a stage above the failure ratio and returns a partial result", async () => {
    (runSelectAndDisambiguate as jest.Mock).mockRejectedValue(new Error("provider down"));

    const result = await runClaimCheck({
      question: "q", answer: ANSWER, sources: SOURCES, model: {} as any, options: options(), locale: "de",
    });

    expect(result.status).toBe("partial");
    expect(result.claims).toEqual([]);
    expect(result.sentences.every((s) => s.state === "not_checked")).toBe(true);
    expect(result.notes.some((n) => n.includes("selection+disambiguation"))).toBe(true);
  });

  // Review Focus 5
  it("caps sentences and claims, flags the result partial, and keeps claim ids contiguous", async () => {
    (runSelectAndDisambiguate as jest.Mock).mockImplementation(async ({ windows }) =>
      allClear(windows.map((w: any) => w.sentence.index)),
    );
    (runDecomposition as jest.Mock).mockImplementation(async ({ windows }) => ({
      outcomes: windows.map((w: any) => ({
        index: w.sentence.index,
        claims: [
          { text: `a${w.sentence.index}`, inferred: false },
          { text: `b${w.sentence.index}`, inferred: false },
        ],
      })),
      usage: USAGE,
    }));
    (runVerification as jest.Mock).mockImplementation(async ({ claims }) => ({
      outcomes: claims.map((c: any) => ({ claimId: c.id, verdict: "supported", evidence: [], rationale: "r" })),
      usage: USAGE,
    }));

    const result = await runClaimCheck({
      question: "q",
      answer: ANSWER,
      sources: SOURCES,
      model: {} as any,
      options: options({ caps: { maxSentences: 2, maxClaims: 3, maxReRetrievals: 0 } }),
      locale: "de",
    });

    expect(result.status).toBe("partial");
    expect(result.limits.sentencesSkipped).toBe(1);
    expect(result.sentences.find((s) => s.index === 2)!.reason).toBe("cap_exceeded");
    expect(result.claims.map((c) => c.id)).toEqual(["c1", "c2", "c3"]);
    expect(result.notes.some((n) => n.includes("maxClaims"))).toBe(true);
  });

  // Review Focus 5
  it("drops a decomposition outcome whose sentence index was never in the batch", async () => {
    (runSelectAndDisambiguate as jest.Mock).mockImplementation(async ({ windows }) =>
      allClear(windows.map((w: any) => w.sentence.index)),
    );
    (runDecomposition as jest.Mock).mockResolvedValue({
      outcomes: [
        { index: 0, claims: [{ text: "echt", inferred: false }] },
        { index: 42, claims: [{ text: "erfunden", inferred: false }] },
      ],
      usage: USAGE,
    });
    (runVerification as jest.Mock).mockImplementation(async ({ claims }) => ({
      outcomes: claims.map((c: any) => ({ claimId: c.id, verdict: "supported", evidence: [], rationale: "r" })),
      usage: USAGE,
    }));

    const result = await runClaimCheck({
      question: "q", answer: ANSWER, sources: SOURCES, model: {} as any, options: options(), locale: "de",
    });

    expect(result.claims).toHaveLength(1);
    expect(result.claims[0]!.text).toBe("echt");
    expect(result.claims[0]!.sentenceIndex).toBe(0);
  });
});

describe("runClaimCheck — paper fidelity and second chance", () => {
  it("runs selection and disambiguation as separate stages with majority voting", async () => {
    (runSelection as jest.Mock).mockImplementation(async ({ windows }) => ({
      outcomes: windows.map((w: any) => ({ index: w.sentence.index, verifiable: true, rewritten: null, reason: "fact" })),
      usage: USAGE,
    }));
    // Two of three completions say resolvable, so min_successes=2 passes.
    const resolvableSequence = [true, true, false];
    let call = 0;
    (runDisambiguation as jest.Mock).mockImplementation(async ({ windows }) => {
      const resolvable = resolvableSequence[call % resolvableSequence.length]!;
      call += 1;
      return {
        outcomes: windows.map((w: any) => ({ index: w.sentence.index, resolvable, clarified: null, reason: "r" })),
        usage: USAGE,
      };
    });
    (runDecomposition as jest.Mock).mockResolvedValue({
      outcomes: [{ index: 0, claims: [{ text: "c", inferred: false }] }],
      usage: USAGE,
    });
    (runVerification as jest.Mock).mockImplementation(async ({ claims }) => ({
      outcomes: claims.map((c: any) => ({ claimId: c.id, verdict: "supported", evidence: [], rationale: "r" })),
      usage: USAGE,
    }));

    const result = await runClaimCheck({
      question: "q",
      answer: "Die FST-2XT arbeitet mit 230 Volt.",
      sources: SOURCES,
      model: {} as any,
      options: options({ fidelity: "paper", completions: 3 }),
      locale: "de",
    });

    expect(runSelectAndDisambiguate).not.toHaveBeenCalled();
    expect((runSelection as jest.Mock).mock.calls.length).toBe(3);
    expect((runSelection as jest.Mock).mock.calls[0][0].temperature).toBe(0.2);
    expect(result.sentences[0]!.state).toBe("checked");
  });

  it("re-retrieves only unsupported claims, up to the cap, and marks the flipped ones rechecked", async () => {
    (runSelectAndDisambiguate as jest.Mock).mockImplementation(async ({ windows }) =>
      allClear(windows.map((w: any) => w.sentence.index)),
    );
    (runDecomposition as jest.Mock).mockImplementation(async ({ windows }) => ({
      outcomes: windows.map((w: any) => ({ index: w.sentence.index, claims: [{ text: `claim ${w.sentence.index}`, inferred: false }] })),
      usage: USAGE,
    }));
    let verifyCall = 0;
    (runVerification as jest.Mock).mockImplementation(async ({ claims }) => {
      verifyCall += 1;
      // First pass: everything unsupported. Second pass (second chance): supported.
      return {
        outcomes: claims.map((c: any) => ({
          claimId: c.id,
          verdict: verifyCall === 1 ? "unsupported" : "supported",
          evidence: [],
          rationale: "r",
        })),
        usage: USAGE,
      };
    });

    const secondChance = jest
      .fn()
      .mockResolvedValue([{ sourceId: "deep", text: "Die FST-2XT arbeitet mit 230 Volt.", score: 2 }]);

    const result = await runClaimCheck({
      question: "q",
      answer: ANSWER,
      sources: SOURCES,
      model: {} as any,
      options: options({ caps: { maxSentences: 120, maxClaims: 200, maxReRetrievals: 2 } }),
      locale: "de",
      secondChance,
    });

    expect(secondChance).toHaveBeenCalledTimes(2);
    expect(result.claims.filter((c) => c.rechecked)).toHaveLength(2);
    expect(result.claims.filter((c) => c.verdict === "supported")).toHaveLength(2);
    expect(result.notes.some((n) => n.includes("maxReRetrievals"))).toBe(true);
  });

  it("skips the second chance entirely when reRetrieve is off", async () => {
    (runSelectAndDisambiguate as jest.Mock).mockImplementation(async ({ windows }) =>
      allClear(windows.map((w: any) => w.sentence.index)),
    );
    (runDecomposition as jest.Mock).mockResolvedValue({
      outcomes: [{ index: 0, claims: [{ text: "c", inferred: false }] }],
      usage: USAGE,
    });
    (runVerification as jest.Mock).mockImplementation(async ({ claims }) => ({
      outcomes: claims.map((c: any) => ({ claimId: c.id, verdict: "unsupported", evidence: [], rationale: "r" })),
      usage: USAGE,
    }));
    const secondChance = jest.fn();

    const result = await runClaimCheck({
      question: "q", answer: ANSWER, sources: SOURCES, model: {} as any,
      options: options({ reRetrieve: false }), locale: "de", secondChance,
    });

    expect(secondChance).not.toHaveBeenCalled();
    expect(result.claims[0]!.rechecked).toBe(false);
  });
});
```

- [ ] **Step 6: Run them and watch them fail**

Run: `npm test -- ee/claim-check/run.test.ts`
Expected: FAIL — `Cannot find module './run'`.

- [ ] **Step 7: Implement `run.ts`**

```typescript
// ee/claim-check/run.ts
//
// Orchestration. Everything about cost and provider fragility lives here:
// batching (spec §2.3), bounded fan-out, one bisect per failed batch, a stage
// circuit breaker, and the caps that turn a huge answer into a partial result
// instead of a failure.
import type { LanguageModel } from "ai";
import {
  CLAIM_CHECK_DEFAULTS,
  type Claim,
  type ClaimCheckOptions,
  type ClaimCheckResult,
  type ClaimCheckSource,
  type DisambiguationOutcome,
  type EvidenceSnippet,
  type SelectionOutcome,
  type Sentence,
  type SentenceState,
  type SentenceWindow,
} from "./types";
import { buildWindows, localeFromText, splitIntoSentences } from "./split";
import { indexSources, selectEvidence } from "./evidence";
import { runSelectAndDisambiguate } from "./stages/select-disambiguate";
import { runSelection } from "./stages/select";
import { runDisambiguation } from "./stages/disambiguate";
import { runDecomposition } from "./stages/decompose";
import { runVerification } from "./stages/verify";
import { scoreClaims, buildSentenceResults } from "./score";
import { addUsage, EMPTY_USAGE, type StageUsage } from "./stages/usage";
import { mapWithConcurrency } from "./concurrency";

export const BATCH = { selectDisambiguate: 10, decompose: 5, verifySentences: 3 };
export const MAX_IN_FLIGHT = 6;
export const STAGE_FAILURE_ABORT = 0.4;
/** Paper §D: 3 completions, 2 successes required, for Selection and Disambiguation. */
const MIN_SUCCESS_RATIO = 2 / 3;

const chunk = <T,>(items: T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
};

type StageState = {
  usage: StageUsage;
  notes: string[];
  states: Map<number, { state: SentenceState; reason?: string }>;
  partial: boolean;
};

/**
 * Run one batched stage over all batches with bounded concurrency. A rejected
 * batch is split in half and each half retried once, so a single bad call
 * costs 2-3 sentences instead of 10. Above STAGE_FAILURE_ABORT the stage stops
 * reporting and the caller degrades to a partial result.
 */
async function runBatched<R>(
  batches: SentenceWindow[][],
  label: string,
  state: StageState,
  call: (windows: SentenceWindow[]) => Promise<{ result: R; usage: StageUsage }>,
): Promise<R[]> {
  const settled = await mapWithConcurrency(batches, MAX_IN_FLIGHT, async (windows) => call(windows));
  const good: R[] = [];
  const retryable: SentenceWindow[][] = [];
  let failures = 0;

  settled.forEach((outcome, i) => {
    if (outcome.status === "fulfilled") {
      good.push(outcome.value.result);
      state.usage = addUsage(state.usage, outcome.value.usage);
      return;
    }
    failures += 1;
    const batch = batches[i]!;
    if (batch.length > 1) {
      const mid = Math.ceil(batch.length / 2);
      retryable.push(batch.slice(0, mid), batch.slice(mid));
    } else {
      markNotChecked(state, batch, `${label} failed for this sentence`);
    }
  });

  if (batches.length > 0 && failures / batches.length > STAGE_FAILURE_ABORT) {
    state.partial = true;
    state.notes.push(
      `${label}: aborted after ${failures} of ${batches.length} calls failed; remaining sentences are not_checked`,
    );
    for (const batch of retryable) markNotChecked(state, batch, `${label} aborted`);
    return good;
  }

  if (retryable.length > 0) {
    const retried = await mapWithConcurrency(retryable, MAX_IN_FLIGHT, async (windows) => call(windows));
    retried.forEach((outcome, i) => {
      if (outcome.status === "fulfilled") {
        good.push(outcome.value.result);
        state.usage = addUsage(state.usage, outcome.value.usage);
      } else {
        markNotChecked(state, retryable[i]!, `${label} failed after bisect`);
      }
    });
  }

  return good;
}

function markNotChecked(state: StageState, windows: SentenceWindow[], reason: string): void {
  state.partial = true;
  state.notes.push(`${windows.length} sentence(s) marked not_checked: ${reason}`);
  for (const w of windows) {
    if (!state.states.has(w.sentence.index)) {
      state.states.set(w.sentence.index, { state: "not_checked", reason });
    }
  }
}

/** Majority voting for paper fidelity: a sentence advances when at least 2 of 3 runs agree. */
function vote<T extends { index: number }>(
  runs: T[][],
  passes: (outcome: T) => boolean,
  completions: number,
): Map<number, { passed: boolean; sample: T }> {
  const byIndex = new Map<number, T[]>();
  for (const run of runs) {
    for (const outcome of run) {
      const list = byIndex.get(outcome.index) ?? [];
      list.push(outcome);
      byIndex.set(outcome.index, list);
    }
  }
  const required = Math.max(1, Math.ceil(completions * MIN_SUCCESS_RATIO));
  const voted = new Map<number, { passed: boolean; sample: T }>();
  for (const [index, outcomes] of byIndex) {
    const successes = outcomes.filter(passes);
    voted.set(index, {
      passed: successes.length >= required,
      sample: successes[0] ?? outcomes[0]!,
    });
  }
  return voted;
}

export async function runClaimCheck(args: {
  question: string;
  answer: string;
  sources: ClaimCheckSource[];
  model: LanguageModel;
  options?: ClaimCheckOptions;
  locale?: string;
  /** Supplied only for IMP callers with an agent scope (Task 13). */
  secondChance?: (claimText: string) => Promise<EvidenceSnippet[]>;
}): Promise<ClaimCheckResult> {
  const options = args.options ?? CLAIM_CHECK_DEFAULTS;
  const startedAt = Date.now();
  const timings: Record<string, number> = {};
  const lap = (name: string, from: number) => {
    timings[name] = Date.now() - from;
  };

  const state: StageState = { usage: { ...EMPTY_USAGE }, notes: [], states: new Map(), partial: false };
  const locale = args.locale ?? localeFromText(args.answer);

  // ── Split ────────────────────────────────────────────────────────────────
  let tStage = Date.now();
  const allSentences = splitIntoSentences(args.answer, locale);
  const sentences = allSentences.slice(0, options.caps.maxSentences);
  const skipped = allSentences.slice(options.caps.maxSentences);
  for (const s of skipped) state.states.set(s.index, { state: "not_checked", reason: "cap_exceeded" });
  if (skipped.length > 0) {
    state.partial = true;
    state.notes.push(`maxSentences (${options.caps.maxSentences}) reached; ${skipped.length} sentence(s) not checked`);
  }
  lap("splitMs", tStage);

  // ── Selection + Disambiguation ───────────────────────────────────────────
  tStage = Date.now();
  const selectWindows = buildWindows(sentences, 5, 5);
  const laterWindows = new Map(buildWindows(sentences, 5, 0).map((w) => [w.sentence.index, w]));
  const temperature = options.completions > 1 ? 0.2 : 0;
  const batches = chunk(selectWindows, BATCH.selectDisambiguate);

  const selection: SelectionOutcome[] = [];
  const disambiguation: DisambiguationOutcome[] = [];

  if (options.fidelity === "paper") {
    const selectionRuns: SelectionOutcome[][] = [];
    for (let run = 0; run < options.completions; run += 1) {
      const results = await runBatched(batches, "selection", state, async (windows) => {
        const { outcomes, usage } = await runSelection({
          windows, question: args.question, model: args.model, temperature,
        });
        return { result: outcomes, usage };
      });
      selectionRuns.push(results.flat());
    }
    const selectionVote = vote(selectionRuns, (o) => o.verifiable, options.completions);
    for (const [index, { passed, sample }] of selectionVote) {
      selection.push({ ...sample, index, verifiable: passed });
    }

    const survivors = selection.filter((s) => s.verifiable).map((s) => laterWindows.get(s.index)!).filter(Boolean);
    const texts = new Map(selection.filter((s) => s.rewritten).map((s) => [s.index, s.rewritten!]));
    const disambiguationRuns: DisambiguationOutcome[][] = [];
    for (let run = 0; run < options.completions; run += 1) {
      const results = await runBatched(chunk(survivors, BATCH.selectDisambiguate), "disambiguation", state, async (windows) => {
        const { outcomes, usage } = await runDisambiguation({
          windows, question: args.question, sentenceTexts: texts, model: args.model, temperature,
        });
        return { result: outcomes, usage };
      });
      disambiguationRuns.push(results.flat());
    }
    const disambiguationVote = vote(disambiguationRuns, (o) => o.resolvable, options.completions);
    for (const [index, { passed, sample }] of disambiguationVote) {
      disambiguation.push({ ...sample, index, resolvable: passed });
    }
  } else {
    const merged = await runBatched(batches, "selection+disambiguation", state, async (windows) => {
      const out = await runSelectAndDisambiguate({
        windows, question: args.question, model: args.model, temperature,
      });
      return { result: { selection: out.selection, disambiguation: out.disambiguation }, usage: out.usage };
    });
    for (const part of merged) {
      selection.push(...part.selection);
      disambiguation.push(...part.disambiguation);
    }
  }
  lap("selectDisambiguateMs", tStage);

  // Record the states these two stages decided.
  const selectionByIndex = new Map(selection.map((s) => [s.index, s]));
  const disambiguationByIndex = new Map(disambiguation.map((d) => [d.index, d]));
  const survivingIndexes: number[] = [];
  for (const sentence of sentences) {
    const sel = selectionByIndex.get(sentence.index);
    const dis = disambiguationByIndex.get(sentence.index);
    if (!sel) continue; // not_checked was already recorded by runBatched
    if (!sel.verifiable) {
      state.states.set(sentence.index, { state: "no_verifiable_content", reason: sel.reason });
      continue;
    }
    if (!dis || !dis.resolvable) {
      state.states.set(sentence.index, {
        state: "cannot_disambiguate",
        reason: dis?.reason ?? "disambiguation did not report an outcome",
      });
      continue;
    }
    state.states.set(sentence.index, { state: "checked" });
    survivingIndexes.push(sentence.index);
  }

  // ── Decomposition ────────────────────────────────────────────────────────
  tStage = Date.now();
  const claims: Claim[] = [];
  if (survivingIndexes.length > 0) {
    const decomposeTexts = new Map<number, string>();
    for (const index of survivingIndexes) {
      const clarified = disambiguationByIndex.get(index)?.clarified;
      const rewritten = selectionByIndex.get(index)?.rewritten;
      const text = clarified ?? rewritten;
      if (text) decomposeTexts.set(index, text);
    }
    const survivorWindows = survivingIndexes.map((i) => laterWindows.get(i)!).filter(Boolean);
    const decomposed = await runBatched(chunk(survivorWindows, BATCH.decompose), "decomposition", state, async (windows) => {
      const { outcomes, usage } = await runDecomposition({
        windows, question: args.question, sentenceTexts: decomposeTexts, model: args.model, temperature: 0,
      });
      return { result: outcomes, usage };
    });

    const allowed = new Set(survivingIndexes);
    const flat = decomposed.flat().filter((o) => allowed.has(o.index)).sort((a, b) => a.index - b.index);
    for (const outcome of flat) {
      for (const c of outcome.claims) {
        if (claims.length >= options.caps.maxClaims) break;
        claims.push({
          id: `c${claims.length + 1}`,
          sentenceIndex: outcome.index,
          text: c.text,
          inferred: c.inferred,
          verdict: "unsupported",
          evidence: [],
          rationale: "",
          rechecked: false,
        });
      }
    }
    const produced = flat.reduce((n, o) => n + o.claims.length, 0);
    if (produced > claims.length) {
      state.partial = true;
      state.notes.push(`maxClaims (${options.caps.maxClaims}) reached; ${produced - claims.length} claim(s) dropped`);
    }
    // A sentence that yielded no claim after all is not "checked" — the paper
    // labels it no-verifiable-claims (0.8% of its cases).
    const withClaims = new Set(claims.map((c) => c.sentenceIndex));
    for (const index of survivingIndexes) {
      if (!withClaims.has(index)) {
        state.states.set(index, { state: "no_verifiable_content", reason: "decomposition extracted no claim" });
      }
    }
  }
  lap("decomposeMs", tStage);

  // ── Evidence + Verification ──────────────────────────────────────────────
  tStage = Date.now();
  const passages = indexSources(args.sources);
  lap("evidenceMs", tStage);

  tStage = Date.now();
  if (claims.length > 0) {
    const bySentence = new Map<number, Claim[]>();
    for (const claim of claims) {
      const list = bySentence.get(claim.sentenceIndex) ?? [];
      list.push(claim);
      bySentence.set(claim.sentenceIndex, list);
    }
    const groups = chunk([...bySentence.values()], BATCH.verifySentences).map((g) => g.flat());

    const verified = await mapWithConcurrency(groups, MAX_IN_FLIGHT, async (group) => {
      const evidence = selectEvidence(group.map((c) => c.text), passages);
      return runVerification({
        claims: group.map((c) => ({ id: c.id, text: c.text })),
        evidence,
        model: args.model,
      });
    });

    const byId = new Map(claims.map((c) => [c.id, c]));
    verified.forEach((outcome, i) => {
      if (outcome.status !== "fulfilled") {
        state.partial = true;
        state.notes.push(`verification failed for ${groups[i]!.length} claim(s); they stay unsupported`);
        for (const c of groups[i]!) {
          const claim = byId.get(c.id);
          if (claim) claim.rationale = "verification call failed";
        }
        return;
      }
      state.usage = addUsage(state.usage, outcome.value.usage);
      for (const verdict of outcome.value.outcomes) {
        const claim = byId.get(verdict.claimId);
        if (!claim) continue;
        claim.verdict = verdict.verdict;
        claim.evidence = verdict.evidence;
        claim.rationale = verdict.rationale;
      }
    });

    // ── Second chance for unsupported claims (IMP callers only) ────────────
    if (options.reRetrieve && args.secondChance && options.caps.maxReRetrievals > 0) {
      const candidates = claims.filter((c) => c.verdict === "unsupported");
      const budget = candidates.slice(0, options.caps.maxReRetrievals);
      if (candidates.length > budget.length) {
        state.notes.push(
          `maxReRetrievals (${options.caps.maxReRetrievals}) reached; ${candidates.length - budget.length} unsupported claim(s) were not re-retrieved`,
        );
      }
      await mapWithConcurrency(budget, MAX_IN_FLIGHT, async (claim) => {
        try {
          const extra = await args.secondChance!(claim.text);
          if (extra.length === 0) return;
          const { outcomes, usage } = await runVerification({
            claims: [{ id: claim.id, text: claim.text }],
            evidence: extra,
            model: args.model,
          });
          state.usage = addUsage(state.usage, usage);
          const verdict = outcomes[0];
          if (!verdict) return;
          claim.rechecked = true;
          claim.verdict = verdict.verdict;
          claim.evidence = verdict.evidence;
          claim.rationale = verdict.rationale;
        } catch (err) {
          // A failed second chance leaves the first verdict standing.
          state.notes.push(`second-chance retrieval failed for ${claim.id}`);
        }
      });
    }
  }
  lap("verifyMs", tStage);

  timings.totalMs = Date.now() - startedAt;

  return {
    status: state.partial ? "partial" : "ok",
    score: scoreClaims(claims, options.thresholds),
    sentences: buildSentenceResults(allSentences, state.states, claims),
    claims,
    usage: state.usage,
    timings,
    limits: { truncated: skipped.length > 0, sentencesSkipped: skipped.length },
    notes: state.notes,
  };
}
```

- [ ] **Step 8: Run the orchestrator tests**

Run: `npm test -- ee/claim-check/run.test.ts`
Expected: PASS, all ten tests. Then run the whole module: `npm test -- ee/claim-check`.

- [ ] **Step 9: Compare the typecheck against the baseline**

Run: `npm run type-check 2>&1 | grep -E "error TS" | sort | diff - /tmp/typecheck-baseline.txt`
Expected: no output — the pre-existing error set is unchanged in both count and identity.

- [ ] **Step 10: Commit**

```bash
git add ee/claim-check/concurrency.ts ee/claim-check/concurrency.test.ts ee/claim-check/run.ts ee/claim-check/run.test.ts
git commit -m "feat(claim-check): add the orchestrator with batching, bisect and circuit breaker"
```

---

### Task 12: The HTTP endpoint

**Files:**
- Create: `ee/claim-check/rate-limit.ts`
- Create: `ee/claim-check/routes.ts`
- Test: `ee/claim-check/rate-limit.test.ts`
- Test: `ee/claim-check/routes.test.ts`
- Modify: `ee/entitlements.ts` (add `"claim-check"` to the type, to the free `ENTITLEMENTS` object, and to the licensed return)
- Modify: `src/exulu/routes.ts` (import at the top with the other registrars, call next to `registerViewerIdentityRoutes(app, {...})` around line 5144)
- Create: `mintlify-docs/api-reference/rest/claim-check.mdx`
- Modify: `mintlify-docs/docs.json` (add `"api-reference/rest/claim-check"` to the REST group, after `"api-reference/rest/mcp"`)

**Interfaces:**
- Consumes: `runClaimCheck` (Task 11), `CLAIM_CHECK_DEFAULTS` (Task 1).
- Produces:
  - `CLAIM_CHECK_PATH = "/claims/check"`
  - `registerClaimCheckRoutes(app: Express, deps: ClaimCheckRouteDeps): void`
  - `type ClaimCheckRouteDeps = { authenticate; checkApiKeyScope; checkRecordAccess; getAgent; resolveModel; runCheck; isLicensed; limiter; secondChanceFor? }`
  - `ee/claim-check/rate-limit.ts`: `claimCheckRateLimiter(opts?: { perMinute?: number; perHour?: number; maxInFlight?: number })` returning `{ take(userId: string): { ok: boolean; reason?: string }; release(): void; reset(): void }`

- [ ] **Step 1: Write the failing rate-limiter tests**

```typescript
// ee/claim-check/rate-limit.test.ts
import { claimCheckRateLimiter } from "./rate-limit";

describe("claimCheckRateLimiter", () => {
  it("allows up to the per-minute budget per user and then refuses", () => {
    const limiter = claimCheckRateLimiter({ perMinute: 2, perHour: 100, maxInFlight: 10 });
    expect(limiter.take("u1").ok).toBe(true);
    limiter.release();
    expect(limiter.take("u1").ok).toBe(true);
    limiter.release();
    const third = limiter.take("u1");
    expect(third.ok).toBe(false);
    expect(third.reason).toContain("per-minute");
    // A different user has their own budget.
    expect(limiter.take("u2").ok).toBe(true);
  });

  it("refuses when the global in-flight cap is reached and recovers after release", () => {
    const limiter = claimCheckRateLimiter({ perMinute: 100, perHour: 100, maxInFlight: 1 });
    expect(limiter.take("u1").ok).toBe(true);
    const blocked = limiter.take("u2");
    expect(blocked.ok).toBe(false);
    expect(blocked.reason).toContain("in flight");
    limiter.release();
    expect(limiter.take("u2").ok).toBe(true);
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npm test -- ee/claim-check/rate-limit.test.ts`
Expected: FAIL — `Cannot find module './rate-limit'`.

- [ ] **Step 3: Implement `rate-limit.ts`**

```typescript
// ee/claim-check/rate-limit.ts
//
// One request can cost ~18 provider calls on arbitrary input, so this applies
// to EVERY role, not just external users (spec §4): a per-user fixed window
// plus a global in-flight cap, so a burst cannot drain the provider quota the
// chat itself needs.

const DEFAULTS = { perMinute: 30, perHour: 300, maxInFlight: 20 };

type Window = { minute: number; minuteStart: number; hour: number; hourStart: number };

export function claimCheckRateLimiter(opts: Partial<typeof DEFAULTS> = {}) {
  const { perMinute, perHour, maxInFlight } = { ...DEFAULTS, ...opts };
  const windows = new Map<string, Window>();
  let inFlight = 0;

  return {
    take(userId: string): { ok: boolean; reason?: string } {
      if (inFlight >= maxInFlight) {
        return { ok: false, reason: `too many claim checks in flight (${maxInFlight})` };
      }
      const now = Date.now();
      const current = windows.get(userId) ?? { minute: 0, minuteStart: now, hour: 0, hourStart: now };
      if (now - current.minuteStart >= 60_000) {
        current.minute = 0;
        current.minuteStart = now;
      }
      if (now - current.hourStart >= 3_600_000) {
        current.hour = 0;
        current.hourStart = now;
      }
      if (current.minute >= perMinute) {
        windows.set(userId, current);
        return { ok: false, reason: `per-minute claim-check limit reached (${perMinute})` };
      }
      if (current.hour >= perHour) {
        windows.set(userId, current);
        return { ok: false, reason: `per-hour claim-check limit reached (${perHour})` };
      }
      current.minute += 1;
      current.hour += 1;
      windows.set(userId, current);
      inFlight += 1;
      return { ok: true };
    },
    release(): void {
      inFlight = Math.max(0, inFlight - 1);
    },
    reset(): void {
      windows.clear();
      inFlight = 0;
    },
  };
}

export type ClaimCheckRateLimiter = ReturnType<typeof claimCheckRateLimiter>;
```

- [ ] **Step 4: Write the failing HTTP tests**

```typescript
// ee/claim-check/routes.test.ts
import express from "express";
import request from "supertest";
import { registerClaimCheckRoutes, CLAIM_CHECK_PATH, type ClaimCheckRouteDeps } from "./routes";
import { claimCheckRateLimiter } from "./rate-limit";

const RESULT = {
  status: "ok" as const,
  score: { claims: 2, supported: 2, contradicted: 0, unsupported: 0, unsupportedShare: 0, label: "ok" as const },
  sentences: [],
  claims: [],
  usage: { calls: 3, inputTokens: 10, outputTokens: 2 },
  timings: { totalMs: 5 },
  limits: { truncated: false, sentencesSkipped: 0 },
  notes: [],
};

const BODY = {
  question: "Womit arbeitet die FST-2XT?",
  answer: "Die FST-2XT arbeitet mit 230 Volt.",
  sources: [{ id: "s1", content: "Die FST-2XT arbeitet mit 230 Volt." }],
};

function buildApp(overrides: Partial<ClaimCheckRouteDeps> = {}) {
  const runCheck = jest.fn().mockResolvedValue(RESULT);
  const deps: ClaimCheckRouteDeps = {
    authenticate: async () => ({ user: { id: 7, type: "user" } as any }),
    checkApiKeyScope: () => ({ allowed: true, code: 200, reason: "" }),
    checkRecordAccess: async () => true,
    getAgent: async () => ({ id: "agent-1", model: "agent-model", tools: [] }) as any,
    resolveModel: async ({ modelId }: any) => ({ languageModel: { modelId } }) as any,
    runCheck,
    isLicensed: () => true,
    limiter: claimCheckRateLimiter({ perMinute: 100, perHour: 1000, maxInFlight: 10 }),
    platformDefaultModel: async () => "platform-model",
    ...overrides,
  };
  const app = express();
  app.use(express.json({ limit: "20mb" }));
  registerClaimCheckRoutes(app, deps);
  return { app, deps, runCheck: deps.runCheck as jest.Mock };
}

describe(`POST ${CLAIM_CHECK_PATH}`, () => {
  it("returns the engine's result for a valid request", async () => {
    const { app, runCheck } = buildApp();
    const res = await request(app).post(CLAIM_CHECK_PATH).send(BODY);
    expect(res.status).toBe(200);
    expect(res.body.score.label).toBe("ok");
    expect(runCheck).toHaveBeenCalledTimes(1);
    expect(runCheck.mock.calls[0][0].question).toBe(BODY.question);
  });

  it("404s when the deployment is not licensed, without running anything", async () => {
    const { app, runCheck } = buildApp({ isLicensed: () => false });
    const res = await request(app).post(CLAIM_CHECK_PATH).send(BODY);
    expect(res.status).toBe(404);
    expect(runCheck).not.toHaveBeenCalled();
  });

  it("401s when authentication fails", async () => {
    const { app } = buildApp({
      authenticate: async () => ({ error: true, code: 401, message: "no key" }),
    });
    const res = await request(app).post(CLAIM_CHECK_PATH).send(BODY);
    expect(res.status).toBe(401);
  });

  it("400s on a missing question, a missing answer and a non-array sources field", async () => {
    const { app } = buildApp();
    expect((await request(app).post(CLAIM_CHECK_PATH).send({ answer: "a", sources: [] })).status).toBe(400);
    expect((await request(app).post(CLAIM_CHECK_PATH).send({ question: "q", sources: [] })).status).toBe(400);
    expect((await request(app).post(CLAIM_CHECK_PATH).send({ question: "q", answer: "a", sources: "nope" })).status).toBe(400);
  });

  it("413s when the answer or the evidence exceeds the payload caps", async () => {
    const { app, runCheck } = buildApp();
    const huge = "a".repeat(200_001);
    const tooLongAnswer = await request(app).post(CLAIM_CHECK_PATH).send({ ...BODY, answer: huge });
    expect(tooLongAnswer.status).toBe(413);

    const tooMuchEvidence = await request(app)
      .post(CLAIM_CHECK_PATH)
      .send({ ...BODY, sources: [{ id: "s1", content: "b".repeat(2_000_001) }] });
    expect(tooMuchEvidence.status).toBe(413);
    expect(runCheck).not.toHaveBeenCalled();
  });

  it("429s when the limiter refuses, and releases the slot after a completed check", async () => {
    const limiter = claimCheckRateLimiter({ perMinute: 1, perHour: 10, maxInFlight: 10 });
    const { app } = buildApp({ limiter });
    expect((await request(app).post(CLAIM_CHECK_PATH).send(BODY)).status).toBe(200);
    const second = await request(app).post(CLAIM_CHECK_PATH).send(BODY);
    expect(second.status).toBe(429);
  });

  it("resolves the request model WITHOUT rbacBypass", async () => {
    const resolveModel = jest.fn(async ({ modelId }: any) => ({ languageModel: { modelId } }) as any);
    const { app } = buildApp({ resolveModel });
    await request(app).post(CLAIM_CHECK_PATH).send({ ...BODY, model: "caller-choice" });
    expect(resolveModel).toHaveBeenCalledWith(expect.objectContaining({ modelId: "caller-choice" }));
    expect(resolveModel.mock.calls[0][0].rbacBypass).toBeUndefined();
  });

  it("falls back through claim_check.model, utility_model and the agent model", async () => {
    const resolveModel = jest.fn(async ({ modelId }: any) => ({ languageModel: { modelId } }) as any);
    const agentWith = (config: Record<string, string>) => ({
      id: "agent-1",
      model: "agent-model",
      tools: [
        {
          id: "agentic_context_search",
          config: Object.entries(config).map(([name, variable]) => ({ name, variable, type: "json" })),
        },
      ],
    });

    const withClaimModel = buildApp({
      resolveModel,
      getAgent: async () => agentWith({ claim_check: '{"enabled":true,"model":"claim-model"}' }) as any,
    });
    await request(withClaimModel.app).post(CLAIM_CHECK_PATH).send({ ...BODY, agent: "agent-1" });
    expect(resolveModel.mock.calls[0][0].modelId).toBe("claim-model");

    resolveModel.mockClear();
    const withUtilityModel = buildApp({
      resolveModel,
      getAgent: async () =>
        agentWith({ claim_check: '{"enabled":true}', utility_model: "utility-model" }) as any,
    });
    await request(withUtilityModel.app).post(CLAIM_CHECK_PATH).send({ ...BODY, agent: "agent-1" });
    expect(resolveModel.mock.calls[0][0].modelId).toBe("utility-model");

    resolveModel.mockClear();
    const withAgentModel = buildApp({ resolveModel, getAgent: async () => agentWith({}) as any });
    await request(withAgentModel.app).post(CLAIM_CHECK_PATH).send({ ...BODY, agent: "agent-1" });
    expect(resolveModel.mock.calls[0][0].modelId).toBe("agent-model");
  });

  it("400s naming the missing configuration when no model resolves at all", async () => {
    const { app, runCheck } = buildApp({
      getAgent: async () => undefined,
      platformDefaultModel: async () => "",
    });
    const res = await request(app).post(CLAIM_CHECK_PATH).send(BODY);
    expect(res.status).toBe(400);
    expect(String(res.body.detail)).toContain("claim_check.default_model");
    expect(runCheck).not.toHaveBeenCalled();
  });

  it("403s when the API key is not scoped to the named agent", async () => {
    const { app, runCheck } = buildApp({
      checkApiKeyScope: () => ({ allowed: false, code: 403, reason: "key is scoped to another agent" }),
    });
    const res = await request(app).post(CLAIM_CHECK_PATH).send({ ...BODY, agent: "agent-1" });
    expect(res.status).toBe(403);
    expect(runCheck).not.toHaveBeenCalled();
  });

  it("403s when the caller cannot read the named agent", async () => {
    const { app } = buildApp({ checkRecordAccess: async () => false });
    const res = await request(app).post(CLAIM_CHECK_PATH).send({ ...BODY, agent: "agent-1" });
    expect(res.status).toBe(403);
  });

  it("passes a partial engine result through with 200", async () => {
    const { app } = buildApp({
      runCheck: jest.fn().mockResolvedValue({ ...RESULT, status: "partial", notes: ["selection aborted"] }),
    });
    const res = await request(app).post(CLAIM_CHECK_PATH).send(BODY);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("partial");
    expect(res.body.notes).toEqual(["selection aborted"]);
  });

  it("500s and releases the limiter slot when the engine throws", async () => {
    const limiter = claimCheckRateLimiter({ perMinute: 2, perHour: 10, maxInFlight: 1 });
    const { app } = buildApp({ limiter, runCheck: jest.fn().mockRejectedValue(new Error("engine exploded")) });
    expect((await request(app).post(CLAIM_CHECK_PATH).send(BODY)).status).toBe(500);
    // The slot was released, so the next request is not blocked by maxInFlight.
    const second = await request(app).post(CLAIM_CHECK_PATH).send(BODY);
    expect(second.status).toBe(500);
  });
});
```

- [ ] **Step 5: Run them and watch them fail**

Run: `npm test -- ee/claim-check/routes.test.ts`
Expected: FAIL — `Cannot find module './routes'`.

- [ ] **Step 6: Implement `routes.ts`**

```typescript
// ee/claim-check/routes.ts
//
// POST /claims/check. The payload is trusted on purpose (spec decision 4):
// the endpoint is a product for clients who bring their own sources and never
// touch an IMP knowledge base. What that buys in reach it pays for in abuse
// surface, so every guard here is load-bearing.
import type { Express, Request, Response } from "express";
import { z } from "zod";
import type { LanguageModel } from "ai";
import type { User } from "@EXULU_TYPES/models/user";
import { CLAIM_CHECK_DEFAULTS, type ClaimCheckOptions, type ClaimCheckResult } from "./types";
import type { ClaimCheckRateLimiter } from "./rate-limit";

export const CLAIM_CHECK_PATH = "/claims/check";

/** Payload caps: an answer is prose, evidence is documents. Beyond these, 413. */
const MAX_ANSWER_CHARS = 200_000;
const MAX_EVIDENCE_CHARS = 2_000_000;
const MAX_SOURCES = 200;

const requestSchema = z.object({
  question: z.string().min(1),
  answer: z.string().min(1),
  sources: z
    .array(z.object({ id: z.string().min(1), name: z.string().optional(), content: z.string() }))
    .default([]),
  agent: z.string().optional(),
  session: z.string().optional(),
  messageId: z.string().optional(),
  model: z.string().optional(),
  locale: z.string().optional(),
  options: z
    .object({
      fidelity: z.enum(["fast", "paper"]).optional(),
      completions: z.number().int().min(1).max(3).optional(),
      reRetrieve: z.boolean().optional(),
      thresholds: z.object({ warn: z.number().min(0).max(1), alert: z.number().min(0).max(1) }).partial().optional(),
      caps: z
        .object({
          maxSentences: z.number().int().positive(),
          maxClaims: z.number().int().positive(),
          maxReRetrievals: z.number().int().min(0),
        })
        .partial()
        .optional(),
    })
    .optional(),
});

export type ClaimCheckRouteDeps = {
  authenticate: (req: Request) => Promise<{ user?: User; error?: boolean; code?: number; message?: string }>;
  checkApiKeyScope: (user: User | undefined, agentId: string) => { allowed: boolean; code: number; reason: string };
  checkRecordAccess: (record: any, request: "read" | "write", user?: User) => Promise<boolean>;
  getAgent: (id: string) => Promise<any | undefined>;
  resolveModel: (input: { modelId: string; user?: User }) => Promise<{ languageModel?: LanguageModel }>;
  runCheck: (args: {
    question: string;
    answer: string;
    sources: { id: string; name?: string; content: string }[];
    model: LanguageModel;
    options: ClaimCheckOptions;
    locale?: string;
    secondChance?: (claimText: string) => Promise<any[]>;
  }) => Promise<ClaimCheckResult>;
  isLicensed: () => boolean;
  limiter: ClaimCheckRateLimiter;
  platformDefaultModel: () => Promise<string>;
  /** Supplied by Task 13; absent means no second-chance retrieval. */
  secondChanceFor?: (args: { agent: any; user?: User; model: LanguageModel; cap: number }) =>
    | ((claimText: string) => Promise<any[]>)
    | undefined;
};

/** Reads the claim_check blob off an agent's agentic_context_search tool config. */
function claimCheckConfigOf(agent: any): { model?: string; utilityModel?: string; options: Partial<ClaimCheckOptions> } {
  const tool = (agent?.tools ?? []).find((t: any) => t?.id === "agentic_context_search");
  const entries: any[] = tool?.config ?? [];
  const valueOf = (name: string): string | undefined =>
    entries.find((e) => e?.name === name)?.variable || undefined;

  let parsed: any = {};
  const raw = valueOf("claim_check");
  if (raw) {
    try {
      parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    } catch {
      // A malformed blob must not break the endpoint; defaults apply.
      parsed = {};
    }
  }
  return {
    model: typeof parsed.model === "string" && parsed.model ? parsed.model : undefined,
    utilityModel: valueOf("utility_model"),
    options: {
      ...(parsed.fidelity ? { fidelity: parsed.fidelity } : {}),
      ...(typeof parsed.completions === "number" ? { completions: parsed.completions } : {}),
      ...(typeof parsed.reRetrieve === "boolean" ? { reRetrieve: parsed.reRetrieve } : {}),
      ...(parsed.thresholds ? { thresholds: { ...CLAIM_CHECK_DEFAULTS.thresholds, ...parsed.thresholds } } : {}),
      ...(parsed.caps ? { caps: { ...CLAIM_CHECK_DEFAULTS.caps, ...parsed.caps } } : {}),
    },
  };
}

export function registerClaimCheckRoutes(app: Express, deps: ClaimCheckRouteDeps): void {
  app.post(CLAIM_CHECK_PATH, async (req: Request, res: Response) => {
    // An unlicensed deployment does not advertise a feature it has not bought.
    if (!deps.isLicensed()) {
      res.status(404).json({ detail: "Not found." });
      return;
    }

    const parsed = requestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ detail: `Invalid request body: ${parsed.error.issues[0]?.message ?? "unknown"}` });
      return;
    }
    const body = parsed.data;

    if (body.answer.length > MAX_ANSWER_CHARS) {
      res.status(413).json({ detail: `answer exceeds ${MAX_ANSWER_CHARS} characters.` });
      return;
    }
    if (body.sources.length > MAX_SOURCES) {
      res.status(413).json({ detail: `more than ${MAX_SOURCES} sources.` });
      return;
    }
    const evidenceChars = body.sources.reduce((n, s) => n + s.content.length, 0);
    if (evidenceChars > MAX_EVIDENCE_CHARS) {
      res.status(413).json({ detail: `source content exceeds ${MAX_EVIDENCE_CHARS} characters in total.` });
      return;
    }

    const auth = await deps.authenticate(req);
    if (!auth.user?.id) {
      res.status(auth.code || 401).json({ detail: auth.message ?? "Unauthorized." });
      return;
    }
    const user = auth.user;

    let agent: any | undefined;
    if (body.agent) {
      const scope = deps.checkApiKeyScope(user, body.agent);
      if (!scope.allowed) {
        res.status(scope.code).json({ detail: scope.reason });
        return;
      }
      agent = await deps.getAgent(body.agent);
      if (!agent) {
        res.status(404).json({ detail: `Agent ${body.agent} not found.` });
        return;
      }
      if (!(await deps.checkRecordAccess(agent, "read", user))) {
        res.status(403).json({ detail: "You don't have access to this agent." });
        return;
      }
    }

    const agentConfig = claimCheckConfigOf(agent);
    const candidates = [
      body.model,
      agentConfig.model,
      agentConfig.utilityModel,
      agent?.model,
      await deps.platformDefaultModel(),
    ].filter((id): id is string => Boolean(id));

    if (candidates.length === 0) {
      res.status(400).json({
        detail:
          "No model to run the check with: pass `model`, configure claim_check.model on the agent, " +
          "or set the platform setting claim_check.default_model.",
      });
      return;
    }

    // Resolved under the caller's own rights: a request body is not an admin,
    // so there is no rbacBypass here (unlike the retrieval tool's utility_model).
    let model: LanguageModel | undefined;
    let lastError: unknown;
    for (const modelId of candidates) {
      try {
        const resolved = await deps.resolveModel({ modelId, user });
        if (resolved.languageModel) {
          model = resolved.languageModel;
          break;
        }
      } catch (err) {
        lastError = err;
      }
    }
    if (!model) {
      res.status(400).json({
        detail: `Could not resolve a model for the claim check${lastError instanceof Error ? `: ${lastError.message}` : ""}.`,
      });
      return;
    }

    const options: ClaimCheckOptions = {
      ...CLAIM_CHECK_DEFAULTS,
      ...agentConfig.options,
      ...(body.options?.fidelity ? { fidelity: body.options.fidelity } : {}),
      ...(body.options?.completions ? { completions: body.options.completions } : {}),
      ...(typeof body.options?.reRetrieve === "boolean" ? { reRetrieve: body.options.reRetrieve } : {}),
      thresholds: {
        ...CLAIM_CHECK_DEFAULTS.thresholds,
        ...agentConfig.options.thresholds,
        ...(body.options?.thresholds ?? {}),
      },
      caps: {
        ...CLAIM_CHECK_DEFAULTS.caps,
        ...agentConfig.options.caps,
        ...(body.options?.caps ?? {}),
      },
    };

    const slot = deps.limiter.take(String(user.id));
    if (!slot.ok) {
      res.status(429).json({ detail: slot.reason ?? "Too many requests. Try again later." });
      return;
    }

    try {
      const secondChance =
        agent && options.reRetrieve && deps.secondChanceFor
          ? deps.secondChanceFor({ agent, user, model, cap: options.caps.maxReRetrievals })
          : undefined;

      const result = await deps.runCheck({
        question: body.question,
        answer: body.answer,
        sources: body.sources,
        model,
        options,
        ...(body.locale ? { locale: body.locale } : {}),
        ...(secondChance ? { secondChance } : {}),
      });
      res.status(200).json(result);
    } catch (err) {
      console.error("[EXULU] claim check failed.", err);
      res.status(500).json({ detail: "The claim check failed." });
    } finally {
      // Always release: an unreleased slot leaks the global in-flight budget.
      deps.limiter.release();
    }
  });
}
```

- [ ] **Step 7: Run the HTTP tests**

Run: `npm test -- ee/claim-check/routes.test.ts ee/claim-check/rate-limit.test.ts`
Expected: PASS, all fifteen tests.

- [ ] **Step 8: Add the entitlement**

In `ee/entitlements.ts`, add `"claim-check": boolean,` to the type, `"claim-check": false,` to the `ENTITLEMENTS` object, and `"claim-check": true,` to the object the licensed branch of `checkLicense()` returns. All three — the type and the free object are separate from the licensed return.

- [ ] **Step 9: Wire the registrar into the app**

In `src/exulu/routes.ts`, next to the other registrar imports (near line 73):

```typescript
import { registerClaimCheckRoutes } from "@EE/claim-check/routes";
import { claimCheckRateLimiter } from "@EE/claim-check/rate-limit";
import { runClaimCheck } from "@EE/claim-check/run";
import { checkLicense } from "@EE/entitlements";
```

Module scope, above `registerRoutes`'s body (one limiter per process, not per request):

```typescript
const claimCheckLimiter = claimCheckRateLimiter();
```

Next to the `registerViewerIdentityRoutes(app, { ... })` call (around line 5144):

```typescript
  registerClaimCheckRoutes(app, {
    authenticate: (req) => requestValidators.authenticate(req),
    checkApiKeyScope,
    checkRecordAccess,
    getAgent: (id) => exuluApp.get().agent(id),
    resolveModel: ({ modelId, user }) => resolveModel({ modelId, user }),
    runCheck: runClaimCheck,
    isLicensed: () => Boolean(checkLicense()["claim-check"]),
    limiter: claimCheckLimiter,
    // Platform default model for callers with no agent; empty until an
    // operator sets it.
    platformDefaultModel: async () => process.env.CLAIM_CHECK_DEFAULT_MODEL ?? "",
  });
```

- [ ] **Step 10: Smoke-test the live route**

```bash
npm run build && node -e "console.log('build ok')"
```

Then, against a running dev server with a valid key:

```bash
curl -s -X POST "$BACKEND/claims/check" \
  -H "Authorization: Bearer $EXULU_API_KEY" -H 'Content-Type: application/json' \
  -d '{"question":"Womit arbeitet die FST-2XT?","answer":"Die FST-2XT arbeitet mit 230 Volt. Das ist beeindruckend.","sources":[{"id":"s1","name":"handbuch.pdf","content":"Die FST-2XT arbeitet mit 230 Volt."}],"model":"'"$CLAIM_CHECK_MODEL"'"}' | python3 -m json.tool
```

Expected: `status: "ok"`, one claim `supported`, the second sentence `no_verifiable_content`, `score.label: "ok"`.

- [ ] **Step 11: Document the endpoint**

Create `mintlify-docs/api-reference/rest/claim-check.mdx` with: what the endpoint does (extraction + grounding, not fact-checking against the web), the request and response schemas copied from spec §4, the verdict vocabulary with the `contradicted` vs `unsupported` distinction, the note that sentences without verifiable content are reported as not checked rather than failed, the payload caps and rate limits, and that the caller's sources are the only evidence used. Add `"api-reference/rest/claim-check"` to `docs.json` after `"api-reference/rest/mcp"`.

- [ ] **Step 12: Commit**

```bash
git add ee/claim-check/routes.ts ee/claim-check/routes.test.ts ee/claim-check/rate-limit.ts ee/claim-check/rate-limit.test.ts ee/entitlements.ts src/exulu/routes.ts mintlify-docs/api-reference/rest/claim-check.mdx mintlify-docs/docs.json
git commit -m "feat(claim-check): add POST /claims/check with licensing, limits and docs"
```

---

### Task 13: Second-chance retrieval for unsupported claims

**Files:**
- Create: `ee/claim-check/second-chance.ts`
- Test: `ee/claim-check/second-chance.test.ts`
- Modify: `src/exulu/routes.ts` (pass `secondChanceFor` into the registrar)

**Interfaces:**
- Consumes: `searchContexts` (`@EE/agentic-retrieval/pipeline/search`), `parsePipelineConfig` (`@EE/agentic-retrieval/pipeline/config`), `indexSources` + `selectEvidence` (Task 4), `EvidenceSnippet` (Task 1).
- Produces: `makeSecondChance(args: { agent: any; user?: User; role?: string; model: LanguageModel; contexts: ExuluContext[]; cap: number }): ((claimText: string) => Promise<EvidenceSnippet[]>) | undefined` — `undefined` when the agent has no searchable context, so the orchestrator skips the pass entirely.

- [ ] **Step 1: Write the failing tests**

```typescript
// ee/claim-check/second-chance.test.ts
jest.mock("@EE/agentic-retrieval/pipeline/search", () => ({ searchContexts: jest.fn() }));
import { searchContexts } from "@EE/agentic-retrieval/pipeline/search";
import { makeSecondChance } from "./second-chance";

const CONTEXTS = [{ id: "handbuecher", name: "Handbücher" }, { id: "tickets", name: "Tickets" }] as any[];

const agentWith = (claimCheck: string, knowledgeBases?: string) => ({
  id: "agent-1",
  tools: [
    {
      id: "agentic_context_search",
      config: [
        { name: "claim_check", variable: claimCheck, type: "json" },
        ...(knowledgeBases ? [{ name: "knowledge_bases", variable: knowledgeBases, type: "json" }] : []),
      ],
    },
  ],
});

beforeEach(() => (searchContexts as jest.Mock).mockReset());

describe("makeSecondChance", () => {
  it("searches the agent's enabled contexts and returns ranked snippets", async () => {
    (searchContexts as jest.Mock).mockResolvedValue({
      chunks: [
        { chunk_id: "k1", item_id: "i1", item_name: "handbuch.pdf", chunk_content: "Die FST-2XT arbeitet mit 230 Volt." },
        { chunk_id: "k2", item_id: "i2", item_name: "anderes.pdf", chunk_content: "Unverwandter Inhalt über Türen." },
      ],
    });

    const secondChance = makeSecondChance({
      agent: agentWith('{"enabled":true}', '{"handbuecher":{"enabled":true},"tickets":{"enabled":false}}'),
      user: { id: 7 } as any,
      model: {} as any,
      contexts: CONTEXTS,
      cap: 5,
    });

    const snippets = await secondChance!("Die FST-2XT arbeitet mit 230 Volt.");
    expect((searchContexts as jest.Mock).mock.calls[0][0].contextIds).toEqual(["handbuecher"]);
    expect(snippets[0]!.text).toContain("230 Volt");
    expect(snippets[0]!.sourceId).toBe("i1");
  });

  it("returns undefined when the agent has no retrieval tool or no enabled context", () => {
    expect(makeSecondChance({ agent: { id: "a", tools: [] }, model: {} as any, contexts: CONTEXTS, cap: 5 })).toBeUndefined();
    expect(
      makeSecondChance({
        agent: agentWith('{"enabled":true}', '{"handbuecher":{"enabled":false},"tickets":{"enabled":false}}'),
        model: {} as any,
        contexts: CONTEXTS,
        cap: 5,
      }),
    ).toBeUndefined();
  });

  it("stops searching once the cap is spent", async () => {
    (searchContexts as jest.Mock).mockResolvedValue({ chunks: [] });
    const secondChance = makeSecondChance({
      agent: agentWith('{"enabled":true}'),
      model: {} as any,
      contexts: CONTEXTS,
      cap: 2,
    })!;
    await secondChance("eins");
    await secondChance("zwei");
    await secondChance("drei");
    expect((searchContexts as jest.Mock).mock.calls.length).toBe(2);
  });

  it("swallows a retrieval failure and returns no snippets, leaving the first verdict standing", async () => {
    (searchContexts as jest.Mock).mockRejectedValue(new Error("vector search down"));
    const secondChance = makeSecondChance({
      agent: agentWith('{"enabled":true}'),
      model: {} as any,
      contexts: CONTEXTS,
      cap: 5,
    })!;
    await expect(secondChance("eine Aussage")).resolves.toEqual([]);
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npm test -- ee/claim-check/second-chance.test.ts`
Expected: FAIL — `Cannot find module './second-chance'`.

- [ ] **Step 3: Implement `second-chance.ts`**

```typescript
// ee/claim-check/second-chance.ts
//
// One targeted retrieval per unsupported claim (spec decision 2). The point is
// to tell "the model made this up" apart from "true, but from a passage the
// answer was never shown" — so this only exists for callers with an agent
// scope. External callers bring their own sources and have nothing to search.
import type { LanguageModel } from "ai";
import type { User } from "@EXULU_TYPES/models/user";
import type { ExuluContext } from "@SRC/exulu/context";
import { searchContexts } from "@EE/agentic-retrieval/pipeline/search";
import { parsePipelineConfig } from "@EE/agentic-retrieval/pipeline/config";
import { indexSources, selectEvidence } from "./evidence";
import type { EvidenceSnippet } from "./types";

const MAX_SNIPPETS_PER_CLAIM = 4;

function toolConfigOf(agent: any): Record<string, unknown> {
  const tool = (agent?.tools ?? []).find((t: any) => t?.id === "agentic_context_search");
  const out: Record<string, unknown> = {};
  for (const entry of tool?.config ?? []) {
    if (entry?.name) out[entry.name] = entry.variable;
  }
  return out;
}

export function makeSecondChance(args: {
  agent: any;
  user?: User;
  role?: string;
  model: LanguageModel;
  contexts: ExuluContext[];
  cap: number;
}): ((claimText: string) => Promise<EvidenceSnippet[]>) | undefined {
  const raw = toolConfigOf(args.agent);
  if (Object.keys(raw).length === 0) return undefined;

  const cfg = parsePipelineConfig(raw);
  const enabled = args.contexts.filter((c) => cfg.knowledgeBases[c.id]?.enabled !== false);
  if (enabled.length === 0) return undefined;

  const contextsById = new Map(enabled.map((c) => [c.id, c]));
  const contextIds = enabled.map((c) => c.id);
  let spent = 0;

  return async (claimText: string): Promise<EvidenceSnippet[]> => {
    if (spent >= args.cap) return [];
    spent += 1;

    try {
      const { chunks } = await searchContexts({
        contextIds,
        contextsById,
        kbProfiles: cfg.knowledgeBases,
        // The claim IS the query: it is already standalone and decontextualized,
        // which is what the extraction stages were for.
        question: claimText,
        keywords: [],
        importantKeyword: "",
        user: args.user,
        role: args.role,
        model: args.model,
        preselectedItems: new Map(),
        identifierPinsByContext: new Map(),
        memoryPinnedItemIdsByContext: new Map(),
        userPinnedItemIdsByContext: new Map(),
        rewrites: cfg.vocabulary.rewrites,
        styleHint: cfg.vocabulary.styleHint,
        maxQueries: 1,
        skipPrefilter: true,
      });

      if (chunks.length === 0) return [];

      const passages = indexSources(
        chunks.map((c: any) => ({
          id: String(c.item_id ?? c.chunk_id),
          name: c.item_name,
          content: String(c.chunk_content ?? ""),
        })),
      );
      return selectEvidence([claimText], passages, MAX_SNIPPETS_PER_CLAIM);
    } catch (err) {
      // A failed second chance must never change a verdict or fail the check.
      console.warn("[EXULU claim-check] second-chance retrieval failed:", err);
      return [];
    }
  };
}
```

- [ ] **Step 4: Run the tests**

Run: `npm test -- ee/claim-check/second-chance.test.ts`
Expected: PASS, all four tests.

- [ ] **Step 5: Wire it into the registrar**

In `src/exulu/routes.ts`, add the import and the dependency to the `registerClaimCheckRoutes` call:

```typescript
import { makeSecondChance } from "@EE/claim-check/second-chance";
```

```typescript
    secondChanceFor: ({ agent, user, model, cap }) =>
      makeSecondChance({ agent, user, role: user?.role?.id, model, contexts: contexts ?? [], cap }),
```

- [ ] **Step 6: Run the full module suite and the typecheck**

Run: `npm test -- ee/claim-check`
Expected: PASS, every test in the module.
Run: `npm run type-check 2>&1 | grep -E "error TS" | sort | diff - /tmp/typecheck-baseline.txt`
Expected: no output — the pre-existing error set is unchanged in both count and identity.

- [ ] **Step 7: Commit**

```bash
git add ee/claim-check/second-chance.ts ee/claim-check/second-chance.test.ts src/exulu/routes.ts
git commit -m "feat(claim-check): add second-chance retrieval for unsupported claims"
```

---

## Stage 1 done when

- `npm test -- ee/claim-check` is green, and `npm test` shows no new failures elsewhere.
- `npm run type-check` matches the baseline exactly.
- The curl in Task 12 Step 10 returns a scored result against a live server.
- `POST /claims/check` is documented in `mintlify-docs`.

**Not in Stage 1, by design:** the 30-fixture benchmark and threshold tuning (Stage 2), and the chat panel, `claimCheckMetadata`, the wizard verification step and the `claim_checks` table (Stage 3). Each gets its own plan.
