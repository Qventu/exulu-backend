# Claim Check — Stage 3, Frontend Half (trigger, panel, wizard) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When an answer finishes streaming, run the claim check and show it under the message — a score, the claims with their verdicts, hallucinations called out — surviving a reload, and let an admin turn the whole thing on per agent from the knowledge-search wizard.

**Architecture:** Mirrors the recalled-memories block end to end: a pure data module parses the turn's metadata and assembles the request from the tool output the client already holds, a presentational panel renders the result through the same `Sources` collapsible, `message-renderer.tsx` gains one optional component prop, and `message-column.tsx` threads `guestMode` through a factory closure because that prop shape is frozen. The check is fired from `useChatSession` on stream end and its results live in hook state keyed by message id, rehydrated from the backend when a session opens.

**Tech Stack:** Next.js (app router), React 19, TypeScript, **vitest** (`npx vitest run <path>` — not jest), next-intl, Tailwind, shadcn/ui, `streamdown` + `react-markdown` for answer rendering.

**Spec:** `docs/superpowers/specs/2026-10-13-claim-check-design.md` — §4 (the API contract this consumes), §5 (chat integration), §5.1 (frontend), §9 stage 3. The backend half is `2026-10-14-claim-check-stage-3-backend.md`; it must land first.

## Global Constraints

- Repo: `/Users/daniel.claessen/Desktop/Projects/exulu/frontend-claim-ui`, branch `feature/claim-check-ui`, forked from `main` at `b45c652`. `node_modules` is **hard-linked** (not symlinked) because Turbopack breaks on a symlinked tree.
- Tests: `npx vitest run <path>`. Lint: `npx eslint <path>`. Build: `npm run build` (Turbopack; slow — run once at the end of the last task, not per task).
- Conventional commits, scope `claim-check`.
- **All user-facing copy is German-first via `next-intl`.** Add keys under the existing `"chat"` block in `messages/de.json` **and** `messages/en.json`; never hardcode a string in a component. The panel reads them with `useTranslations("chat")`.
- **No fragment, no check.** If a message's metadata carries no `claimCheck` object, nothing runs and nothing renders — that is the backend's only switch and the frontend must not second-guess it.
- **The request carries source content from what the client already holds.** The metadata gives ids only; the sources' text comes out of the retrieval tool's output already in the message parts. Never fetch evidence again.
- **A guest must never see a panel the backend withheld.** The backend omits the fragment for external viewers when `showToExternalUsers` is false; the frontend additionally suppresses any action that needs authenticated routes, the way `RecalledMemories` suppresses Open/Forget for guests.
- **The panel is collapsed by default and leads with counts.** A real NEWLIFT answer can produce dozens of claims and no one has yet seen the live distribution, so a flat always-open list is not acceptable.
- `claim_check` must be added to **all three** of `WizardConfig`, `parseWizardConfig` and `serializeWizardConfig` in the same change, and the serialisation test's entry-count assertion updated from 14 to 15. A key the wizard does not serialise is silently deleted on the next save — the failure that killed `tuning.engine: "v2"` in NEWLIFT production.

## Review Focus

1. **A message whose check is still running** — the panel must show a running state rather than an empty or broken block, and must not fire a second request on re-render (Task F4).
2. **A reload mid-check** — a session that opens while a check never completed must render nothing for that message rather than a stuck spinner forever (Task F4).
3. **An answer with zero claims (`label: "n/a"`)** — must read as "nothing checkable here", never as 0% or a failure (Task F3).
4. **A check that returns `status: "partial"` with notes** — the reader must be told the check is incomplete, because the score then describes only part of the answer (Task F3).
5. **An agent saved through the wizard before/after this change** — an existing agent with no `claim_check` key must round-trip unchanged, and a configured key must survive a save (Task F7).

---

### Task F1: the API client

**Files:**
- Create: `lib/api/claim-check.ts`
- Test: `lib/api/claim-check.test.ts`

**Interfaces:**
- Consumes: `request(path, method, body)` from `@/lib/api/client` — the shared authenticated helper that throws on non-2xx (see `lib/api/trajectory-feedback.ts` for the house pattern).
- Produces:
  - `type ClaimCheckSource = { id: string; name?: string; content: string }`
  - `type ClaimCheckRequest = { question: string; answer: string; sources: ClaimCheckSource[]; agent?: string; session?: string; messageId?: string; locale?: string }`
  - `type ClaimCheckResult` — mirroring the API response in spec §4: `status`, `score`, `sentences`, `claims`, `usage`, `timings`, `limits`, `notes`
  - `ScoreLabel = "ok" | "warn" | "alert" | "n/a"` and `ClaimCheckSentence` — Tasks F2 and F6 import both by name, so they must be exported, not inlined
  - `postClaimCheck(body: ClaimCheckRequest): Promise<ClaimCheckResult>`
  - `getSessionClaimChecks(session: string): Promise<Record<string, ClaimCheckResult>>`

- [ ] **Step 1: Write the failing test**

```typescript
// lib/api/claim-check.test.ts
import { describe, expect, it, vi, beforeEach } from "vitest";

const request = vi.fn();
vi.mock("@/lib/api/client", () => ({ request: (...args: unknown[]) => request(...args) }));

import { getSessionClaimChecks, postClaimCheck } from "./claim-check";

beforeEach(() => request.mockReset());

// NOTE: use `mockRejectedValueOnce`, never `mockRejectedValue`, in a file that
// calls `mockReset()` in `beforeEach`. Measured on vitest 4.1.8 with a
// zero-app-code probe: that combination orphans the rejected promise and the
// test fails with an unhandled rejection pointing at the `new Error(...)` line.
// `mockRejectedValueOnce` and `mockImplementation(() => Promise.reject(...))`
// both pass. Do not "fix" it by deleting the reset hook or bumping vitest.

describe("postClaimCheck", () => {
  it("POSTs the body to /claims/check and returns the parsed result", async () => {
    const result = { status: "ok", score: { label: "ok" } };
    request.mockResolvedValue(result);
    const body = {
      question: "Womit arbeitet die FST-2XT?",
      answer: "Die FST-2XT arbeitet mit 230 Volt.",
      sources: [{ id: "i1", name: "handbuch.pdf", content: "Die FST-2XT arbeitet mit 230 Volt." }],
      session: "11111111-1111-4111-8111-111111111111",
      messageId: "msg_1",
    };
    await expect(postClaimCheck(body)).resolves.toBe(result);
    expect(request).toHaveBeenCalledWith("/claims/check", "POST", body);
  });

  it("propagates a rejection rather than swallowing it", async () => {
    request.mockRejectedValueOnce(new Error("429"));
    await expect(postClaimCheck({ question: "q", answer: "a", sources: [] })).rejects.toThrow("429");
  });
});

describe("getSessionClaimChecks", () => {
  it("GETs the session route and unwraps the checks map", async () => {
    request.mockResolvedValue({ checks: { msg_1: { status: "ok" } } });
    await expect(getSessionClaimChecks("11111111-1111-4111-8111-111111111111")).resolves.toEqual({
      msg_1: { status: "ok" },
    });
    expect(request).toHaveBeenCalledWith("/claims/check/11111111-1111-4111-8111-111111111111", "GET");
  });

  it("returns an empty map when the response carries no checks key", async () => {
    request.mockResolvedValue({});
    await expect(getSessionClaimChecks("s")).resolves.toEqual({});
  });

  it("returns an empty map instead of throwing when the route fails — a missing panel is not an error", async () => {
    request.mockRejectedValueOnce(new Error("500"));
    await expect(getSessionClaimChecks("s")).resolves.toEqual({});
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run lib/api/claim-check.test.ts`
Expected: FAIL — cannot resolve `./claim-check`.

- [ ] **Step 3: Implement it**

```typescript
// lib/api/claim-check.ts
//
// Client for the claim-check endpoints (spec §4). The chat posts a finished
// answer together with the sources it already holds and gets back per-claim
// verdicts; the session route rehydrates panels after a reload.
import { request } from "@/lib/api/client";

export type ClaimCheckSource = { id: string; name?: string; content: string };

export type ClaimVerdict = "supported" | "contradicted" | "unsupported";
export type ScoreLabel = "ok" | "warn" | "alert" | "n/a";
export type SentenceState = "checked" | "no_verifiable_content" | "cannot_disambiguate" | "not_checked";

export type ClaimCheckClaim = {
  id: string;
  sentenceIndex: number;
  text: string;
  inferred: boolean;
  verdict: ClaimVerdict;
  evidence: { sourceId: string; quote: string }[];
  rationale: string;
  rechecked: boolean;
};

export type ClaimCheckSentence = {
  index: number;
  start: number;
  end: number;
  state: SentenceState;
  reason?: string;
  claimIds: string[];
};

export type ClaimCheckResult = {
  status: "ok" | "partial";
  score: {
    claims: number;
    supported: number;
    contradicted: number;
    unsupported: number;
    unsupportedShare: number;
    label: ScoreLabel;
  };
  sentences: ClaimCheckSentence[];
  claims: ClaimCheckClaim[];
  usage: { calls: number; inputTokens: number; outputTokens: number };
  timings: Record<string, number>;
  limits: { truncated: boolean; sentencesSkipped: number };
  notes: string[];
};

export type ClaimCheckRequest = {
  question: string;
  answer: string;
  sources: ClaimCheckSource[];
  agent?: string;
  session?: string;
  messageId?: string;
  locale?: string;
};

export const CLAIM_CHECK_PATH = "/claims/check";

/** Runs a check. Throws on a non-2xx so the caller can show a failed state. */
export const postClaimCheck = (body: ClaimCheckRequest): Promise<ClaimCheckResult> =>
  request(CLAIM_CHECK_PATH, "POST", body) as Promise<ClaimCheckResult>;

/**
 * Stored checks for a session, keyed by message id.
 *
 * Resolves to an empty map on failure rather than throwing: a panel that
 * cannot be rehydrated is a missing convenience, not an error worth breaking
 * the session's load over.
 */
export async function getSessionClaimChecks(session: string): Promise<Record<string, ClaimCheckResult>> {
  try {
    const res = (await request(`${CLAIM_CHECK_PATH}/${session}`, "GET")) as
      | { checks?: Record<string, ClaimCheckResult> }
      | undefined;
    return res?.checks ?? {};
  } catch {
    return {};
  }
}
```

Check `lib/api/client.ts`'s actual `request` signature before committing — if it takes `(path, method, body)` positionally as `trajectory-feedback.ts` suggests, the above is right; if it differs, match it and keep the test's assertion in step with it.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run lib/api/claim-check.test.ts`
Expected: PASS, all five.

- [ ] **Step 5: Commit**

```bash
git add lib/api/claim-check.ts lib/api/claim-check.test.ts
git commit -m "feat(claim-check): add the claim-check API client"
```

---

### Task F2: the data module — parse the trigger, assemble the request

**Files:**
- Create: `app/(application)/chat/components/claim-check-data.ts`
- Test: `app/(application)/chat/components/claim-check-data.test.ts`

**Interfaces:**
- Consumes: `ClaimCheckSource`, `ClaimCheckResult` from `@/lib/api/claim-check`; `UIMessage` from `ai`.
- Produces:
  - `parseClaimCheckTrigger(metadata: unknown): { enabled: true; sourceIds: string[]; toolCallIds: string[] } | null`
  - `collectSources(message: UIMessage, sourceIds: string[]): ClaimCheckSource[]`
  - `answerTextOf(message: UIMessage): string`
  - `summarise(result: ClaimCheckResult): { checked: number; supported: number; contradicted: number; unsupported: number; label: ScoreLabel; partial: boolean }`

This module is pure: no React, no fetch. It is where the "ids only" contract is honoured — the metadata says *which* sources, this assembles their text out of the retrieval tool output already in the message.

- [ ] **Step 1: Write the failing test**

```typescript
// app/(application)/chat/components/claim-check-data.test.ts
import { describe, expect, it } from "vitest";
import type { UIMessage } from "ai";

import { answerTextOf, collectSources, parseClaimCheckTrigger, summarise } from "./claim-check-data";

const message = {
  id: "msg_1",
  role: "assistant",
  metadata: { claimCheck: { enabled: true, sourceIds: ["i1", "i2"], toolCallIds: ["call_1"] } },
  parts: [
    { type: "step-start" },
    {
      type: "tool-Context_Search",
      toolCallId: "call_1",
      output: {
        result: JSON.stringify({
          chunks: [
            { chunk_id: "k1", item_id: "i1", item_name: "handbuch.pdf", chunk_content: "Die FST-2XT arbeitet mit 230 Volt." },
            { chunk_id: "k2", item_id: "i2", item_name: "ticket.txt", chunk_content: "Die Tür wurde getauscht." },
            { chunk_id: "k3", item_id: "i3", item_name: "fremd.pdf", chunk_content: "Nicht angefragt." },
          ],
        }),
      },
    },
    { type: "text", text: "Die FST-2XT arbeitet mit 230 Volt. " },
    { type: "text", text: "Die Tür wurde getauscht." },
  ],
} as unknown as UIMessage;

describe("parseClaimCheckTrigger", () => {
  it("reads the fragment the backend emits", () => {
    expect(parseClaimCheckTrigger(message.metadata)).toEqual({
      enabled: true,
      sourceIds: ["i1", "i2"],
      toolCallIds: ["call_1"],
    });
  });

  it("returns null when there is no fragment, which is the backend's off switch", () => {
    expect(parseClaimCheckTrigger({})).toBeNull();
    expect(parseClaimCheckTrigger(undefined)).toBeNull();
    expect(parseClaimCheckTrigger({ claimCheck: { enabled: true } })).toBeNull(); // no sourceIds
    expect(parseClaimCheckTrigger({ claimCheck: { enabled: true, sourceIds: [] } })).toBeNull();
  });
});

describe("collectSources", () => {
  it("takes only the named ids, with their content, deduplicated and in metadata order", () => {
    expect(collectSources(message, ["i2", "i1"])).toEqual([
      { id: "i2", name: "ticket.txt", content: "Die Tür wurde getauscht." },
      { id: "i1", name: "handbuch.pdf", content: "Die FST-2XT arbeitet mit 230 Volt." },
    ]);
  });

  it("concatenates every chunk of the same item, so a multi-chunk document arrives whole", () => {
    const multi = {
      parts: [
        {
          type: "tool-Context_Search",
          output: {
            result: JSON.stringify({
              chunks: [
                { item_id: "i1", item_name: "h.pdf", chunk_content: "Erster Teil." },
                { item_id: "i1", item_name: "h.pdf", chunk_content: "Zweiter Teil." },
              ],
            }),
          },
        },
      ],
    } as unknown as UIMessage;
    expect(collectSources(multi, ["i1"])).toEqual([
      { id: "i1", name: "h.pdf", content: "Erster Teil.\n\nZweiter Teil." },
    ]);
  });

  it("returns an empty array when the tool output cannot be parsed", () => {
    const broken = { parts: [{ type: "tool-Context_Search", output: { result: "<<not json>>" } }] } as unknown as UIMessage;
    expect(collectSources(broken, ["i1"])).toEqual([]);
  });

  it("skips an id the message does not carry rather than inventing an empty source", () => {
    expect(collectSources(message, ["i1", "nope"]).map((s) => s.id)).toEqual(["i1"]);
  });
});

describe("answerTextOf", () => {
  it("joins the text parts in order, which is the string the offsets index into", () => {
    expect(answerTextOf(message)).toBe("Die FST-2XT arbeitet mit 230 Volt. Die Tür wurde getauscht.");
  });

  it("is empty for a message with no text parts", () => {
    expect(answerTextOf({ parts: [{ type: "step-start" }] } as unknown as UIMessage)).toBe("");
  });
});

describe("summarise", () => {
  const result = {
    status: "partial",
    score: { claims: 10, supported: 7, contradicted: 1, unsupported: 2, unsupportedShare: 0.3, label: "alert" },
  } as never;

  it("lifts the counts the panel's header needs", () => {
    expect(summarise(result)).toEqual({
      checked: 10,
      supported: 7,
      contradicted: 1,
      unsupported: 2,
      label: "alert",
      partial: true,
    });
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run "app/(application)/chat/components/claim-check-data.test.ts"`
Expected: FAIL — cannot resolve `./claim-check-data`.

- [ ] **Step 3: Implement it**

```typescript
// app/(application)/chat/components/claim-check-data.ts
//
// Pure helpers for the claim-check panel (spec §5, §5.1).
//
// The backend's metadata fragment names source IDS ONLY — the evidence itself
// averages ~89,000 characters per turn and the client already holds it in the
// retrieval tool's output, so this module assembles the request from what is
// already on the message rather than fetching anything again.
import type { UIMessage } from "ai";

import type { ClaimCheckResult, ClaimCheckSource, ScoreLabel } from "@/lib/api/claim-check";

export type ClaimCheckTrigger = { enabled: true; sourceIds: string[]; toolCallIds: string[] };

/** The retrieval tool is renamed per agent; these are the shapes it ships as. */
const RETRIEVAL_PART_TYPES = new Set(["tool-Context_Search", "tool-Knowledge_context_search"]);

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

/**
 * The backend's switch. No fragment — or a fragment naming no sources — means
 * no check ever runs for this message; the frontend does not second-guess it.
 */
export function parseClaimCheckTrigger(metadata: unknown): ClaimCheckTrigger | null {
  if (!isRecord(metadata) || !isRecord(metadata.claimCheck)) return null;
  const fragment = metadata.claimCheck;
  if (fragment.enabled !== true) return null;
  const sourceIds = Array.isArray(fragment.sourceIds) ? fragment.sourceIds.filter((v): v is string => typeof v === "string") : [];
  if (sourceIds.length === 0) return null;
  const toolCallIds = Array.isArray(fragment.toolCallIds) ? fragment.toolCallIds.filter((v): v is string => typeof v === "string") : [];
  return { enabled: true, sourceIds, toolCallIds };
}

/** Every retrieved chunk on this message, flattened; never throws. */
function chunksOf(message: UIMessage): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const part of (message.parts ?? []) as unknown[]) {
    if (!isRecord(part) || typeof part.type !== "string" || !RETRIEVAL_PART_TYPES.has(part.type)) continue;
    const raw = isRecord(part.output) ? part.output.result : undefined;
    if (typeof raw !== "string") continue;
    try {
      const parsed = JSON.parse(raw);
      if (isRecord(parsed) && Array.isArray(parsed.chunks)) {
        for (const chunk of parsed.chunks) if (isRecord(chunk)) out.push(chunk);
      }
    } catch {
      // A truncated or offloaded output is not a reason to break the panel.
    }
  }
  return out;
}

/**
 * The named sources, with their text, in the order the metadata named them.
 * Several chunks of one document are concatenated so the source arrives whole —
 * the check's containment and evidence selection both read continuous text.
 */
export function collectSources(message: UIMessage, sourceIds: string[]): ClaimCheckSource[] {
  const chunks = chunksOf(message);
  const out: ClaimCheckSource[] = [];
  for (const id of sourceIds) {
    const mine = chunks.filter((c) => c.item_id === id);
    if (mine.length === 0) continue;
    const name = typeof mine[0]!.item_name === "string" ? (mine[0]!.item_name as string) : undefined;
    const content = mine
      .map((c) => (typeof c.chunk_content === "string" ? c.chunk_content : ""))
      .filter(Boolean)
      .join("\n\n");
    out.push(name ? { id, name, content } : { id, content });
  }
  return out;
}

/**
 * The answer exactly as the check must see it: the text parts joined in order.
 * `sentences[].start/end` index into THIS string, so any transformation here
 * would silently move every highlight.
 */
export function answerTextOf(message: UIMessage): string {
  return ((message.parts ?? []) as unknown[])
    .filter((p): p is { type: "text"; text: string } => isRecord(p) && p.type === "text" && typeof p.text === "string")
    .map((p) => p.text)
    .join("");
}

export function summarise(result: ClaimCheckResult): {
  checked: number;
  supported: number;
  contradicted: number;
  unsupported: number;
  label: ScoreLabel;
  partial: boolean;
} {
  return {
    checked: result.score.claims,
    supported: result.score.supported,
    contradicted: result.score.contradicted,
    unsupported: result.score.unsupported,
    label: result.score.label,
    partial: result.status === "partial",
  };
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run "app/(application)/chat/components/claim-check-data.test.ts"`
Expected: PASS, all nine.

If `answerTextOf`'s expectation fails because the fixture's two text parts join differently than you expect, **do not change the assertion to match the code** — check against how `messageMarkdown` in `components/message-renderer.tsx` derives the answer string, and make this function agree with it. The offsets come from the backend having segmented exactly that string, so a mismatch here moves every highlight.

- [ ] **Step 5: Commit**

```bash
git add "app/(application)/chat/components/claim-check-data.ts" "app/(application)/chat/components/claim-check-data.test.ts"
git commit -m "feat(claim-check): parse the trigger and assemble sources from the message"
```

---

### Task F3: the panel

**Files:**
- Create: `app/(application)/chat/components/claim-check.tsx`
- Test: `app/(application)/chat/components/claim-check.test.tsx`
- Modify: `messages/de.json` and `messages/en.json` (new keys under the existing `"chat"` block)

**Interfaces:**
- Consumes: `summarise`, `ClaimCheckResult` and friends (Task F2, F1).
- Produces: `export function ClaimCheck({ state, guestMode }: { state: ClaimCheckState; guestMode?: boolean })` and `export type ClaimCheckState = { status: "running" } | { status: "done"; result: ClaimCheckResult } | { status: "failed" } | null`.

The panel is presentational: it takes state and renders. It never fetches — Task F4 owns that, so this task's tests need no network.

**Two items from spec §5.1 this task deliberately does not deliver — recorded here rather than dropped silently:**

- *"a claim counter"* while running. The A1 single-shot endpoint returns once, so there is no incremental count to show; a counter only becomes possible with the A2 progressive stream the spec defers. The running state shows the copy without a number.
- *"evidence links into the existing source viewer"*. The panel shows each claim's evidence quote and its source name, but not a link that opens the cited document. Doing it needs the entry point the existing source cards use to open an item — find how `components/ai-elements/sources.tsx` and the `/data/<context>/<item>` route are wired from a chat source card, then add the link behind the same `guestMode` suppression the rest of the panel uses. Left out of this pass because the quote and source name already make the verdict traceable, and a wrong link is worse than none.

- [ ] **Step 1: Add the copy**

In `messages/de.json`, inside `"chat"`:

```json
      "claimCheckRunning": "Antwort wird geprüft …",
      "claimCheckFailed": "Die Prüfung konnte nicht abgeschlossen werden.",
      "claimCheckNoClaims": "Keine überprüfbaren Aussagen in dieser Antwort.",
      "claimCheckSummary": "{supported} von {checked} Aussagen belegt",
      "claimCheckContradicted": "{count} widersprochen",
      "claimCheckUnsupported": "{count} ohne Belegstelle",
      "claimCheckPartial": "Prüfung unvollständig – der Wert beschreibt nur den geprüften Teil der Antwort.",
      "claimCheckVerdictSupported": "belegt",
      "claimCheckVerdictContradicted": "widersprochen",
      "claimCheckVerdictUnsupported": "ohne Belegstelle",
      "claimCheckInferred": "abgeleitet",
      "claimCheckRechecked": "nachgeschlagen"
```

Mirror them in `messages/en.json` with the English wording ("Checking the answer …", "{supported} of {checked} statements supported", "{count} contradicted", "{count} without evidence", and so on). Keep both files' key order identical to each other.

- [ ] **Step 2: Write the failing test**

```tsx
// app/(application)/chat/components/claim-check.test.tsx
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";

import { ClaimCheck, type ClaimCheckState } from "./claim-check";
import de from "@/messages/de.json";

const show = (state: ClaimCheckState) =>
  render(
    <NextIntlClientProvider locale="de" messages={de as never}>
      <ClaimCheck state={state} />
    </NextIntlClientProvider>,
  );

const result = (over: Partial<Record<string, unknown>> = {}) =>
  ({
    status: "ok",
    score: { claims: 4, supported: 3, contradicted: 1, unsupported: 0, unsupportedShare: 0.25, label: "warn" },
    sentences: [{ index: 0, start: 0, end: 34, state: "checked", claimIds: ["c1"] }],
    claims: [
      {
        id: "c1",
        sentenceIndex: 0,
        text: "Die FST-2XT arbeitet mit 230 Volt.",
        inferred: false,
        verdict: "supported",
        evidence: [{ sourceId: "i1", quote: "arbeitet mit 230 Volt" }],
        rationale: "Die Quelle nennt 230 Volt.",
        rechecked: false,
      },
      {
        id: "c2",
        sentenceIndex: 0,
        text: "Die FST-2XT wiegt 12 kg.",
        inferred: false,
        verdict: "contradicted",
        evidence: [{ sourceId: "i1", quote: "wiegt 18 kg" }],
        rationale: "Die Quelle nennt 18 kg.",
        rechecked: false,
      },
    ],
    usage: { calls: 8, inputTokens: 1, outputTokens: 1 },
    timings: { totalMs: 5000 },
    limits: { truncated: false, sentencesSkipped: 0 },
    notes: [],
    ...over,
  }) as never;

describe("ClaimCheck", () => {
  it("renders nothing when there is no state", () => {
    const { container } = show(null);
    expect(container).toBeEmptyDOMElement();
  });

  // Review Focus 1
  it("shows a running state while the check is in flight", () => {
    show({ status: "running" });
    expect(screen.getByText(/wird geprüft/i)).toBeInTheDocument();
  });

  it("shows a failed state without pretending to have a score", () => {
    show({ status: "failed" });
    expect(screen.getByText(/konnte nicht abgeschlossen/i)).toBeInTheDocument();
    expect(screen.queryByText(/belegt/i)).not.toBeInTheDocument();
  });

  it("leads with the counts and names contradictions separately from missing evidence", () => {
    show({ status: "done", result: result() });
    expect(screen.getByText(/3 von 4 Aussagen belegt/i)).toBeInTheDocument();
    expect(screen.getByText(/1 widersprochen/i)).toBeInTheDocument();
  });

  // Review Focus 3
  it("says nothing was checkable instead of showing a zero score when label is n/a", () => {
    show({
      status: "done",
      result: result({
        score: { claims: 0, supported: 0, contradicted: 0, unsupported: 0, unsupportedShare: 0, label: "n/a" },
        claims: [],
      }),
    });
    expect(screen.getByText(/Keine überprüfbaren Aussagen/i)).toBeInTheDocument();
    expect(screen.queryByText(/0 von 0/i)).not.toBeInTheDocument();
  });

  // Review Focus 4
  it("warns that the check is incomplete when the status is partial", () => {
    show({ status: "done", result: result({ status: "partial", notes: ["selection aborted"] }) });
    expect(screen.getByText(/unvollständig/i)).toBeInTheDocument();
  });

  it("is collapsed by default: the claim list is not rendered until opened", () => {
    show({ status: "done", result: result() });
    expect(screen.queryByText("Die FST-2XT wiegt 12 kg.")).not.toBeInTheDocument();
  });

  it("shows each claim with its verdict and rationale once opened", async () => {
    const { container } = show({ status: "done", result: result() });
    const trigger = container.querySelector("[data-claim-check-trigger]") as HTMLElement;
    trigger.click();
    expect(await screen.findByText("Die FST-2XT wiegt 12 kg.")).toBeInTheDocument();
    expect(screen.getByText(/Die Quelle nennt 18 kg\./i)).toBeInTheDocument();
  });
});
```

Check how the repo's other component tests render with `next-intl` before writing this — if they use a shared test helper rather than `NextIntlClientProvider` directly, use the helper. Also confirm `@testing-library/react` is a dependency; if the repo tests components another way, follow that way and keep the same assertions.

- [ ] **Step 3: Run it and watch it fail**

Run: `npx vitest run "app/(application)/chat/components/claim-check.test.tsx"`
Expected: FAIL — cannot resolve `./claim-check`.

- [ ] **Step 4: Implement the panel**

Build it on the same `Sources` / `SourcesTrigger` / `SourcesContent` collapsible `recalled-memories.tsx` uses, so it sits visually beside the existing source badge. Requirements the tests pin:

- `state === null` → render `null`.
- `running` → the running copy, no score.
- `failed` → the failed copy, no score.
- `done` with `label: "n/a"` → the no-claims copy, never a "0 of 0" figure.
- `done` otherwise → a trigger carrying `data-claim-check-trigger` that shows `claimCheckSummary` plus, when non-zero, `claimCheckContradicted` and `claimCheckUnsupported`; collapsed by default.
- `status: "partial"` → the partial warning, visible without opening.
- Opened → one row per claim: its text, a verdict badge using the three verdict keys, the rationale, and badges for `inferred` / `rechecked` when set.
- Colour by label (`ok` / `warn` / `alert`) using the project's existing token classes — read a neighbouring component for which ones; do not introduce new colour literals.
- `guestMode` suppresses anything linking into authenticated `/data/...` routes, exactly as `RecalledMemories` does.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run "app/(application)/chat/components/claim-check.test.tsx"`
Expected: PASS, all eight.

- [ ] **Step 6: Commit**

```bash
git add "app/(application)/chat/components/claim-check.tsx" "app/(application)/chat/components/claim-check.test.tsx" messages/de.json messages/en.json
git commit -m "feat(claim-check): add the claim-check panel"
```

---

### Task F4: fire the check on stream end, and rehydrate on session open

**Files:**
- Modify: `app/(application)/chat/hooks.ts` (inside `useChatSession`)
- Test: `app/(application)/chat/claim-check-trigger.test.ts`

**Interfaces:**
- Consumes: `postClaimCheck`, `getSessionClaimChecks`, `ClaimCheckRequest` (F1); `parseClaimCheckTrigger`, `collectSources`, `answerTextOf` (F2); **`ClaimCheckState` — imported from `./components/claim-check` (F3), which is where that union is declared**.
- Produces, on the controller object `useChatSession` returns: `claimChecks: Record<string, ClaimCheckState>` keyed by message id, so `MessageColumn` can read a message's state without prop-drilling.

Extract the decision into a pure function so it can be tested without React:

```typescript
export function claimCheckRequestFor(args: {
  message: UIMessage;
  question: string;
  session: string | undefined;
  agentId: string;
  locale: string;
}): ClaimCheckRequest | null
```

It returns `null` whenever no check should run — no trigger fragment, no sources recoverable, or an empty answer — and otherwise the exact body to post.

- [ ] **Step 1: Write the failing test**

```typescript
// app/(application)/chat/claim-check-trigger.test.ts
import { describe, expect, it } from "vitest";
import type { UIMessage } from "ai";

import { claimCheckRequestFor } from "./hooks";

const base = {
  id: "msg_1",
  role: "assistant",
  metadata: { claimCheck: { enabled: true, sourceIds: ["i1"], toolCallIds: ["call_1"] } },
  parts: [
    {
      type: "tool-Context_Search",
      toolCallId: "call_1",
      output: { result: JSON.stringify({ chunks: [{ item_id: "i1", item_name: "h.pdf", chunk_content: "230 Volt." }] }) },
    },
    { type: "text", text: "Die FST-2XT arbeitet mit 230 Volt." },
  ],
} as unknown as UIMessage;

const args = { message: base, question: "Womit?", session: "s1", agentId: "a1", locale: "de" };

describe("claimCheckRequestFor", () => {
  it("builds the exact body for a triggered message", () => {
    expect(claimCheckRequestFor(args)).toEqual({
      question: "Womit?",
      answer: "Die FST-2XT arbeitet mit 230 Volt.",
      sources: [{ id: "i1", name: "h.pdf", content: "230 Volt." }],
      agent: "a1",
      session: "s1",
      messageId: "msg_1",
      locale: "de",
    });
  });

  it("returns null when the message carries no trigger", () => {
    expect(claimCheckRequestFor({ ...args, message: { ...base, metadata: {} } as UIMessage })).toBeNull();
  });

  it("returns null when the named sources cannot be recovered from the message", () => {
    const noTool = { ...base, parts: [{ type: "text", text: "Antwort." }] } as unknown as UIMessage;
    expect(claimCheckRequestFor({ ...args, message: noTool })).toBeNull();
  });

  it("returns null for an empty answer", () => {
    const noText = { ...base, parts: [base.parts![0]] } as unknown as UIMessage;
    expect(claimCheckRequestFor({ ...args, message: noText })).toBeNull();
  });

  it("omits session and messageId when there is no session, so an unsaved chat still checks", () => {
    const body = claimCheckRequestFor({ ...args, session: undefined });
    expect(body?.session).toBeUndefined();
    expect(body?.messageId).toBeUndefined();
    expect(body?.answer).toBe("Die FST-2XT arbeitet mit 230 Volt.");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run "app/(application)/chat/claim-check-trigger.test.ts"`
Expected: FAIL — `claimCheckRequestFor` is not exported from `./hooks`.

- [ ] **Step 3: Implement the pure part**

Add to `app/(application)/chat/hooks.ts` (near the other exported helpers, not inside the hook):

```typescript
/**
 * The body to post for one finished assistant message, or null when no check
 * should run. Pure so the decision is testable without React: the hook below
 * only owns *when* to call it and where to put the answer.
 */
export function claimCheckRequestFor({ message, question, session, agentId, locale }: {
  message: UIMessage;
  question: string;
  session: string | undefined;
  agentId: string;
  locale: string;
}): ClaimCheckRequest | null {
  const trigger = parseClaimCheckTrigger(message.metadata);
  if (!trigger) return null;
  const sources = collectSources(message, trigger.sourceIds);
  if (sources.length === 0) return null;
  const answer = answerTextOf(message);
  if (!answer.trim()) return null;
  return {
    question,
    answer,
    sources,
    agent: agentId,
    ...(session ? { session, messageId: message.id } : {}),
    locale,
  };
}
```

- [ ] **Step 4: Wire the hook**

Inside `useChatSession`, add state and the two effects:

```typescript
  // Claim check (spec §5): fired once per finished assistant message, never
  // during the stream. Keyed by message id so a re-render cannot re-fire it.
  const [claimChecks, setClaimChecks] = useState<Record<string, ClaimCheckState>>({});
  const claimCheckFired = useRef<Set<string>>(new Set());
```

Then an effect that runs when `status` leaves the streaming state: find the last assistant message, call `claimCheckRequestFor`, and if it returns a body and `claimCheckFired` has not seen that id, mark it fired, set `{ status: "running" }`, post, and store `{ status: "done", result }` or `{ status: "failed" }`. Read how this file already derives the preceding user message for other features and reuse that for `question` rather than inventing a second derivation.

And an effect that runs when the session id changes: `getSessionClaimChecks(session)` and merge the stored results into state as `{ status: "done", result }`, **without** clearing an in-flight `running` entry. Add every stored id to `claimCheckFired` so rehydration cannot trigger a re-check.

Expose `claimChecks` on the object the hook returns, beside the existing controller fields.

- [ ] **Step 5: Verify the two Review Focus cases by hand**

Run the app (`npm run dev`) only if it is already running for you; otherwise reason from the code and say so in your report. The two behaviours to confirm:
- a message whose check is in flight shows the running state and does not re-fire on re-render (the `claimCheckFired` ref);
- a session reopened while a check never completed shows no panel for that message rather than a stuck spinner (nothing stored → no state → `ClaimCheck` renders `null`).

- [ ] **Step 6: Run the tests and the gates**

Run: `npx vitest run "app/(application)/chat/"`
Expected: PASS.
Run: `npx eslint "app/(application)/chat/hooks.ts"` → no new errors.

- [ ] **Step 7: Commit**

```bash
git add "app/(application)/chat/hooks.ts" "app/(application)/chat/claim-check-trigger.test.ts"
git commit -m "feat(claim-check): fire the check when a stream ends and rehydrate on open"
```

---

### Task F5: render the panel under the answer

**Files:**
- Modify: `components/message-renderer.tsx` (new optional `ClaimCheckComponent` prop, mirroring `RecalledMemoriesComponent` at lines 163, 197, 623, 673, 722, 1282)
- Modify: `app/(application)/chat/components/message-column.tsx` (a `makeClaimCheck(...)` factory beside `makeRecalledMemories`, and pass it down)
- Test: `app/(application)/chat/components/message-column-claim-check.test.tsx`

**Interfaces:**
- Consumes: `ClaimCheck` **and `ClaimCheckState`** from `./claim-check` (F3); `claimChecks` from the controller (F4).
- Produces: `ClaimCheckComponent?: React.ComponentType<{ message: UIMessage; agent: Agent }>` on `MessageRendererProps`.

`RecalledMemoriesComponent`'s shape is frozen and has no `guestMode` prop, which is why `message-column.tsx` wraps it in a factory closure. Do the same here, and carry `claimChecks` in the same closure so the component needs no new prop.

- [ ] **Step 1: Write the failing test**

```tsx
// app/(application)/chat/components/message-column-claim-check.test.tsx
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";

import { makeClaimCheck } from "./message-column";
import de from "@/messages/de.json";

const message = { id: "msg_1", role: "assistant", parts: [], metadata: {} } as never;
const agent = { id: "a1", name: "Agent" } as never;

describe("makeClaimCheck", () => {
  it("renders the panel for a message that has state", () => {
    const Component = makeClaimCheck({ msg_1: { status: "running" } }, false);
    render(
      <NextIntlClientProvider locale="de" messages={de as never}>
        <Component message={message} agent={agent} />
      </NextIntlClientProvider>,
    );
    expect(screen.getByText(/wird geprüft/i)).toBeInTheDocument();
  });

  it("renders nothing for a message with no state", () => {
    const Component = makeClaimCheck({}, false);
    const { container } = render(
      <NextIntlClientProvider locale="de" messages={de as never}>
        <Component message={message} agent={agent} />
      </NextIntlClientProvider>,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run "app/(application)/chat/components/message-column-claim-check.test.tsx"`
Expected: FAIL — `makeClaimCheck` is not exported.

- [ ] **Step 3: Add the factory and export it**

In `message-column.tsx`, beside `makeRecalledMemories`:

```tsx
/**
 * Carries the per-message claim-check state and guestMode in a closure, the
 * same way makeRecalledMemories does — MessageRenderer's component props are a
 * frozen shape and take only { message, agent }.
 */
export function makeClaimCheck(claimChecks: Record<string, ClaimCheckState>, guestMode: boolean) {
  const ClaimCheckForColumn = ({ message }: { message: UIMessage; agent: Agent }) => (
    <ClaimCheck state={claimChecks[message.id] ?? null} guestMode={guestMode} />
  );
  ClaimCheckForColumn.displayName = "ClaimCheckForColumn";
  return ClaimCheckForColumn;
}
```

- [ ] **Step 4: Thread it through the renderer**

In `components/message-renderer.tsx`, add `ClaimCheckComponent` exactly where `RecalledMemoriesComponent` appears: the prop type (line ~163), the destructure (~197), the pass-down (~623), the inner prop type (~673) and destructure (~722), and the render site (~1282) — rendered for assistant messages only, directly after the recalled-memories block so the two sit together under the answer.

Then in `MessageColumn`, build it with `useMemo` over `[controller.claimChecks, guestMode]` and pass `ClaimCheckComponent={...}` wherever `RecalledMemoriesComponent` is passed.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run "app/(application)/chat/components/"`
Expected: PASS.
Run: `npx eslint components/message-renderer.tsx "app/(application)/chat/components/message-column.tsx"` → no new errors.

- [ ] **Step 6: Commit**

```bash
git add components/message-renderer.tsx "app/(application)/chat/components/message-column.tsx" "app/(application)/chat/components/message-column-claim-check.test.tsx"
git commit -m "feat(claim-check): render the panel under the assistant answer"
```

---

### Task F6: highlight checked sentences in the answer — measure the premise first

**Files:**
- Create: `app/(application)/chat/components/claim-check-highlight.ts`
- Test: `app/(application)/chat/components/claim-check-highlight.test.ts`
- Possibly modify: `components/ai-elements/response.tsx`

**Interfaces:**
- Consumes: `ClaimCheckSentence` (F1), the answer string from `answerTextOf` (F2).
- Produces: `blockOffsets(blocks: string[]): number[]` and `sentencesInBlock(sentences: ClaimCheckSentence[], blockStart: number, blockEnd: number): ClaimCheckSentence[]`.

**This task has a premise that must be measured before anything is built.** `components/ai-elements/response.tsx` renders an answer by first calling `parseMarkdownIntoBlocks` from `streamdown` and then rendering each block through its own `ReactMarkdown`. Our `sentences[].start/end` are offsets into the *whole* answer, so mapping them onto a per-block render requires each block's start offset — which only exists if the splitter preserves every character.

- [ ] **Step 1: Measure whether block offsets are recoverable**

```bash
cd /Users/daniel.claessen/Desktop/Projects/exulu/frontend-claim-ui
cat > /tmp/block-probe.mjs <<'EOF'
import { parseMarkdownIntoBlocks } from "streamdown";
const answers = [
  "Die FST-2XT arbeitet mit 230 Volt. Sie sitzt im Schaltschrank.",
  "## Fehlerbehebung\n\nDer Schalter ist eine Ursache.\n\n- Punkt eins\n- Punkt zwei\n\nAbschließend gilt: geprüft.",
  "Erste Zeile.\nZweite Zeile.\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n```bash\necho hi\n```\n\nEnde.",
];
for (const a of answers) {
  const blocks = parseMarkdownIntoBlocks(a);
  const joined = blocks.join("");
  console.log(JSON.stringify({ lossless: joined === a, blocks: blocks.length, joinedLen: joined.length, originalLen: a.length }));
}
EOF
node /tmp/block-probe.mjs
```

**If every case reports `lossless: true`**, a running offset over the block list reconstructs each block's position in the answer exactly, and highlighting is implementable — continue to step 2.

**If any case reports `lossless: false`**, stop and report: in-body highlighting is deferred, because a drifting offset would highlight the wrong words silently, which is worse than no highlight. In that case the panel (Task F3) already shows each claim's sentence text, which is the fallback, and this task's remaining steps are skipped. Paste the probe output either way.

- [ ] **Step 2 (only if lossless): write the failing test**

```typescript
// app/(application)/chat/components/claim-check-highlight.test.ts
import { describe, expect, it } from "vitest";

import { blockOffsets, sentencesInBlock } from "./claim-check-highlight";

describe("blockOffsets", () => {
  it("returns each block's start offset in the joined answer", () => {
    expect(blockOffsets(["Eins. ", "Zwei. ", "Drei."])).toEqual([0, 6, 12]);
  });

  it("is empty for no blocks", () => {
    expect(blockOffsets([])).toEqual([]);
  });
});

describe("sentencesInBlock", () => {
  const sentences = [
    { index: 0, start: 0, end: 5, state: "checked", claimIds: ["c1"] },
    { index: 1, start: 6, end: 11, state: "no_verifiable_content", claimIds: [] },
    { index: 2, start: 12, end: 17, state: "checked", claimIds: ["c2"] },
  ] as never[];

  it("selects only the sentences that fall inside the block's range", () => {
    expect(sentencesInBlock(sentences, 6, 12).map((s) => s.index)).toEqual([1]);
  });

  it("excludes a sentence that merely straddles the boundary, rather than half-highlighting it", () => {
    expect(sentencesInBlock(sentences, 3, 8).map((s) => s.index)).toEqual([]);
  });

  it("returns an empty list when the block holds no sentences", () => {
    expect(sentencesInBlock(sentences, 100, 200)).toEqual([]);
  });
});
```

- [ ] **Step 3 (only if lossless): implement the offset helpers**

```typescript
// app/(application)/chat/components/claim-check-highlight.ts
//
// Mapping the check's whole-answer sentence offsets onto the per-block render
// in components/ai-elements/response.tsx, which splits an answer with
// streamdown's parseMarkdownIntoBlocks before rendering each block through its
// own ReactMarkdown. A running offset over the block list is only valid
// because the splitter was measured to be lossless (join() === input); if that
// ever changes, highlights would drift silently and this must be revisited.
import type { ClaimCheckSentence } from "@/lib/api/claim-check";

export function blockOffsets(blocks: string[]): number[] {
  const offsets: number[] = [];
  let at = 0;
  for (const block of blocks) {
    offsets.push(at);
    at += block.length;
  }
  return offsets;
}

/**
 * Sentences wholly inside [blockStart, blockEnd). A sentence straddling the
 * boundary is dropped rather than half-marked: half a highlighted sentence
 * reads as a different claim than the one that was checked.
 */
export function sentencesInBlock(
  sentences: ClaimCheckSentence[],
  blockStart: number,
  blockEnd: number,
): ClaimCheckSentence[] {
  return sentences.filter((s) => s.start >= blockStart && s.end <= blockEnd);
}
```

- [ ] **Step 4 (only if lossless): run the tests**

Run: `npx vitest run "app/(application)/chat/components/claim-check-highlight.test.ts"`
Expected: PASS, all five.

- [ ] **Step 5 (only if lossless): commit the helpers and report the rendering decision**

Commit the measured helpers on their own:

```bash
git add "app/(application)/chat/components/claim-check-highlight.ts" "app/(application)/chat/components/claim-check-highlight.test.ts"
git commit -m "feat(claim-check): map sentence offsets onto the block renderer"
```

Then **stop and report** rather than editing `response.tsx`: wiring a `<mark>` into the shared answer renderer touches every message in the product, and the controller wants to decide that separately now that the mapping is proven. Say in your report what you would change in `response.tsx` and which messages it would affect.

---

### Task F7: the wizard verification step

**Files:**
- Modify: `app/(application)/agents/edit/[id]/components/knowledge-search/config-schema.ts`
- Modify: `app/(application)/agents/edit/[id]/components/knowledge-search/config-schema.test.ts`
- Create: `app/(application)/agents/edit/[id]/components/knowledge-search/steps/verification-step.tsx`
- Modify: `app/(application)/agents/edit/[id]/components/knowledge-search/steps/review-step.tsx`
- Modify: `app/(application)/agents/edit/[id]/components/knowledge-search/summary-card.tsx`
- Modify: `app/(application)/agents/edit/[id]/components/knowledge-search/wizard.tsx`
- Modify: `messages/de.json`, `messages/en.json`

**Interfaces:**
- Consumes: the existing `WizardConfig`, `parseWizardConfig`, `serializeWizardConfig` and the model picker `behavior-step.tsx` uses for `utility_model`.
- Produces: `WizardConfig["claimCheck"]`, serialised as the 15th entry under the key `claim_check`, of **exactly** the shape the backend parses in `ee/agentic-retrieval/pipeline/config.ts` — all eight keys:

```typescript
{
  enabled: boolean;
  model: string;
  fidelity: "fast" | "paper";
  completions: number;                 // 1-3; no UI control, round-tripped only
  reRetrieve: boolean;
  thresholds: { warn: number; alert: number };
  showToExternalUsers: boolean;
  caps: { maxSentences: number; maxClaims: number; maxReRetrievals: number }; // no UI control, round-tripped only
}
```

**`completions` and `caps` carry no UI control and must still be declared.** The wizard re-serialises the whole blob through this schema on every save, and a key the schema does not declare is silently deleted — the failure that wiped `tuning.engine: "v2"` from NEWLIFT production. An operator who tunes `caps` through the API must not lose it because an admin later opened the wizard.

- [ ] **Step 1: Write the failing test**

Append to `config-schema.test.ts`:

```typescript
describe("claim_check", () => {
  it("defaults to disabled when the key is absent", () => {
    const cfg = parseWizardConfig([]);
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

  it("round-trips a configured value through serialize and parse", () => {
    const cfg = parseWizardConfig([
      { name: "claim_check", variable: '{"enabled":true,"model":"vertex-gemini-3.5-flash","thresholds":{"warn":0.2,"alert":0.5}}', type: "json" },
    ]);
    expect(cfg.claimCheck.enabled).toBe(true);
    expect(cfg.claimCheck.model).toBe("vertex-gemini-3.5-flash");
    expect(cfg.claimCheck.thresholds).toEqual({ warn: 0.2, alert: 0.5 });

    const entries = serializeWizardConfig(cfg);
    expect(parseWizardConfig(entries).claimCheck).toEqual(cfg.claimCheck);
  });

  // Review Focus 5
  it("serialises exactly 15 entries, with claim_check among them", () => {
    const entries = serializeWizardConfig(parseWizardConfig([]));
    expect(entries).toHaveLength(15);
    expect(entries.map((e) => e.name)).toContain("claim_check");
  });

  // Review Focus 5
  it("leaves an agent that never had the key with the default, not undefined", () => {
    const entries = serializeWizardConfig(parseWizardConfig([{ name: "instructions", variable: "x", type: "string" }]));
    const claim = entries.find((e) => e.name === "claim_check");
    expect(claim).toBeDefined();
    expect(JSON.parse(String(claim!.variable)).enabled).toBe(false);
  });

  // The UI edits six of the eight keys; a save must not drop the other two.
  it("preserves completions and caps set outside the wizard across a save", () => {
    const cfg = parseWizardConfig([
      {
        name: "claim_check",
        variable: '{"enabled":true,"completions":3,"caps":{"maxSentences":40,"maxClaims":60,"maxReRetrievals":0}}',
        type: "json",
      },
    ]);
    const saved = parseWizardConfig(serializeWizardConfig(cfg)).claimCheck;
    expect(saved.completions).toBe(3);
    expect(saved.caps).toEqual({ maxSentences: 40, maxClaims: 60, maxReRetrievals: 0 });
  });

  it("falls back to the default on a malformed blob instead of throwing", () => {
    expect(parseWizardConfig([{ name: "claim_check", variable: "{not json", type: "json" }]).claimCheck.enabled).toBe(false);
  });
});
```

The existing entry-count assertion elsewhere in this file says 14 — **update it to 15** rather than deleting it.

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run "app/(application)/agents/edit/[id]/components/knowledge-search/config-schema.test.ts"`
Expected: FAIL — `cfg.claimCheck` is undefined and the count is 14.

- [ ] **Step 3: Extend the schema**

Add a `claimCheckSchema` zod object mirroring the backend's (`ee/agentic-retrieval/pipeline/config.ts`), add `claimCheck` to the `WizardConfig` type and to the defaults, parse it in `parseWizardConfig` with the file's existing `safeZodParse` + `parseJsonField` helpers, and append the 15th entry in `serializeWizardConfig` in declaration order:

```typescript
    { name: "claim_check", variable: JSON.stringify(cfg.claimCheck), type: "json" },
```

Spell nested defaults out explicitly — zod's `.default()` does not apply inner defaults, the same trap the backend's schema documents. Declare all eight keys, including `completions` and `caps`, which have no UI control: they exist in this schema purely so a save round-trips them instead of deleting them.

- [ ] **Step 4: Build the step UI**

Create `steps/verification-step.tsx` following the shape of `memory-step.tsx`: an enable switch, the model picker `behavior-step.tsx` uses for `utility_model`, a fidelity select (`fast` / `paper`), two threshold number inputs, a `reRetrieve` switch and a `showToExternalUsers` switch. `completions` and `caps` get **no** control — they are schema-only, and inventing UI for them is out of scope. All labels and help text via `useTranslations`, with keys added to both message files. Register the step in `wizard.tsx` beside the others, add a line to `review-step.tsx`, and a line to `summary-card.tsx`.

Copy to add (German first, mirrored in English) — note the help text that matters:

```json
      "claimCheckStepTitle": "Antwortprüfung",
      "claimCheckStepHelp": "Prüft nach dem Streamen, welche Aussagen der Antwort von den gefundenen Quellen gedeckt sind. Kostet zusätzliche Modellaufrufe pro Antwort.",
      "claimCheckEnabled": "Antwortprüfung aktivieren",
      "claimCheckModel": "Modell für die Prüfung",
      "claimCheckModelHelp": "Ein schnelles, günstiges Modell genügt. Leer = Standardmodell des Agenten.",
      "claimCheckFidelity": "Prüftiefe",
      "claimCheckThresholds": "Schwellenwerte",
      "claimCheckReRetrieve": "Bei fehlender Belegstelle erneut suchen",
      "claimCheckShowExternal": "Auch externen Nutzern und Gästen anzeigen"
```

- [ ] **Step 5: Run the tests and the gates**

Run: `npx vitest run "app/(application)/agents/edit/[id]/components/knowledge-search/"`
Expected: PASS.
Run: `npx eslint "app/(application)/agents/edit/[id]/components/knowledge-search/"` → no new errors.
Run: `npm run build` — **once, here, at the end of the plan.** Turbopack is slow; this is the only full build and it is what proves the new step compiles into the app.

- [ ] **Step 6: Commit**

```bash
git add "app/(application)/agents/edit/[id]/components/knowledge-search/" messages/de.json messages/en.json
git commit -m "feat(claim-check): add the verification step to the knowledge-search wizard"
```

---

## Frontend half done when

- `npx vitest run lib/api/claim-check.test.ts "app/(application)/chat/" "app/(application)/agents/edit/[id]/components/knowledge-search/"` is green.
- `npm run build` succeeds.
- `npx eslint` reports no new errors on every file touched.
- An agent can be given `claim_check.enabled: true` through the wizard and the key survives a save — which is the constraint the spec records as blocking until this task lands.
- Task F6 has either shipped the offset mapping with its probe output, or reported why in-body highlighting is deferred.
