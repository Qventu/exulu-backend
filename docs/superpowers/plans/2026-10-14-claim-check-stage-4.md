# Claim Check Stage 4 — client-assembled source coverage — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A turn that used recalled memories, `read_session_file`, `parse_document`, `internet_search` or session-items retrieval gets a **complete** claim check instead of no check at all.

**Architecture:** The backend's metadata fragment becomes a `sources[]` manifest — one entry per source the client should send, each naming its `type` and (where applicable) the `toolCallId` that produced it. The client finds each part **by tool-call id**, runs the handler the `type` names, and posts the assembled content. Nothing is resolved server-side: the endpoint keeps receiving content and trusting it, which is what keeps it usable by callers who have no IMP knowledge base.

**Tech Stack:** Backend — TypeScript, Express, knex, jest (`npx jest <path>`). Frontend — Next.js app router, React 19, **vitest** (`npx vitest run <path>`), next-intl.

**Spec:** `docs/superpowers/specs/2026-10-14-claim-check-stage-4-source-coverage-design.md` (committed `d7501e3`). It amends `2026-10-13-claim-check-design.md`, which remains the authority for everything Stage 4 does not change — read §2.4, §4 and §5 of the parent before starting.

## Global Constraints

- **Backend repo:** `/Users/daniel.claessen/Desktop/Projects/exulu/backend-claim-ui`, new branch `feature/claim-check-sources` off the **merged** `develop` (`0eb9ef1`). The worktree already exists with `node_modules` in place; create the branch in it rather than making a new worktree.
- **Frontend repo:** `/Users/daniel.claessen/Desktop/Projects/exulu/frontend-claim-ui`, new branch `feature/claim-check-sources` off the **merged** `main` (`9fcdc29`). Same: reuse the worktree, `node_modules` is hard-linked and must stay that way (Turbopack breaks on a symlinked tree).
- Conventional commits, scope `claim-check`. commitlint rejects non-standard types — `merge:` is not a type.
- **Backend typecheck is an equality at 8 errors** with these identities: `src/exulu/auth/flow.ts` ×2, `src/exulu/auth/validate.ts` ×2, `src/exulu/openai-transformer.ts` ×2, `src/templates/tools/convert-exulu-tools-to-ai-sdk-tools.ts` ×2. Fewer than 8 is also a failure — a stray backtick truncates the GraphQL `typeDefs` template literal and silently drops types.
- Backend lint: no new errors in **non-test** files, proven by comparing the *set* of files with errors. Each new test file adds exactly one `parserOptions.project` parse error by construction.
- Frontend: 3 pre-existing unrelated TypeScript errors; compare identities, do not chase zero. Component tests need an explicit `afterEach(cleanup)` — `vitest.config.ts` sets no `test.globals`, so DOM leaks between cases and assertions pass for the wrong reason. A rejecting mock must use `mockRejectedValueOnce`, never `mockRejectedValue`, in any file that resets mocks in a `beforeEach` (measured on vitest 4.1.8: the persistent form orphans the rejected promise and fails the test with an unhandled rejection).
- **German-first copy** via `next-intl`, keys added under the existing block in **both** `messages/de.json` and `messages/en.json`, same key set in both, read with `useTranslations`. German as a German-speaking colleague would write it. The verdict vocabulary is already `belegt` / `widerlegt` / `ohne Belegstelle` — match it.
- **Ids only in metadata.** The manifest carries ids and tool-call ids; no source content ever travels in message metadata. A turn's evidence averages ~89,000 characters.
- **Never invent, never pad.** A source whose recovered content is empty is omitted, and the client then refuses the whole check rather than verifying an answer against part of its evidence (parent spec §2.4). This is the rule that prevents a false `unsupported`, which is the worst output this system has.
- **The two halves must merge together.** B1 changes the fragment shape that the merged frontend still reads as `sourceIds`/`toolCallIds`, so between B1 and F1 the deployed pair would be incompatible. Neither branch is deployable alone; merge both or neither.

## Review Focus

1. **A guest turn whose memory list was withheld** — `recalledMemoriesMetadata` returns nothing when the viewer is a guest and the agent's `guests.showRecalled` is false, so the client has no memory text. The manifest must not name memory sources for that turn, or the completeness guard refuses **every** check on the public surface (Task B1).
2. **A tool that returned an error** — `read_session_file`, `parse_document` and `view_document_page` all return `{ error: "…" }` on failure. An error string must never become a source's content: the check would verify the answer against an error message and report grounded claims unsupported (Task F2).
3. **A web search whose citations cannot be parsed** — must yield **one** source named for the search itself, not zero. Zero sources would trip the completeness guard and silently kill the check on every search turn (Task F2).
4. **A document tool whose `content` is empty or absent** — omitted by the handler, and the manifest must not have named it, so the counts still agree (Tasks B1, F2).
5. **Two sources supplying the same `id`** — a 400, not a silent merge. An evidence quote that cannot be traced to one document is worse than a rejected request (Task B2).

---

## File Structure

**Backend** (`feature/claim-check-sources` in `../backend-claim-ui`):

| File | Responsibility |
|---|---|
| `src/exulu/claim-check/finish-metadata.ts` | Build the manifest; decide suppression. The one place that knows which evidence paths exist. |
| `src/exulu/claim-check/finish-metadata.test.ts` | Its tests. |
| `ee/claim-check/routes.ts` | The request contract: `content`-only sources, positional ids, the `type` enum, the duplicate-id 400. |
| `ee/claim-check/routes.test.ts` | Its tests. |
| `ee/claim-check/evidence.ts` | Carry the *names* of truncated sources alongside the counts it already reports. |
| `ee/claim-check/run.ts` | Name those sources in the truncation note it already emits. |
| `mintlify-docs/api-reference/rest/claim-check.mdx` | The public contract. |

**Frontend** (`feature/claim-check-sources` in `../frontend-claim-ui`):

| File | Responsibility |
|---|---|
| `lib/api/claim-check.ts` | Request/response types, including the source `type`. |
| `app/(application)/chat/components/claim-check-data.ts` | Parse the manifest; one handler per source type; assemble the request. |
| `app/(application)/chat/components/claim-check-data.test.ts` | Its tests. |
| `app/(application)/chat/components/claim-check.tsx` | Per-type labels in the panel. |
| `messages/de.json`, `messages/en.json` | The labels. |

---

## The cross-repo contract, stated once

Both halves depend on exactly these two shapes. Every task that touches either must match them verbatim.

**The manifest, on the assistant turn's `finish` metadata:**

```typescript
export type ClaimCheckSourceType =
  | "knowledge_base"
  | "document"
  | "memory"
  | "web"
  | "session_item"
  | "other";

export type ClaimCheckManifestEntry = {
  type: ClaimCheckSourceType;
  /** Stable within the turn. `item_id` for kb, `memory:<id>`, `tool:<toolCallId>` otherwise. */
  id: string;
  /** Absent for `memory` (it comes from metadata, not a tool part). */
  toolCallId?: string;
};

export type ClaimCheckTrigger = {
  enabled: true;
  sources: ClaimCheckManifestEntry[];
};
```

**The POST body's sources** (`content` is the only required field):

```typescript
export type ClaimCheckSource = {
  content: string;
  name?: string;
  type?: ClaimCheckSourceType;
  id?: string;
};
```

---

### Task B1: the manifest replaces the two parallel arrays

**Files:**
- Modify: `src/exulu/claim-check/finish-metadata.ts`
- Modify: `src/exulu/claim-check/finish-metadata.test.ts`
- Modify: `src/exulu/routes.ts` (the `claimCheckStreamMetadata` call site — it gains the recall list's *visibility*, see Interfaces)

**Interfaces:**
- Consumes: `recalledMemoriesMetadata({ recall, agent, isGuest })` from `./memory/recalled-metadata` — call it and look at whether it returned a `recalledMemories` key, rather than re-deriving its gate. That function already encodes "the viewer may see these memories"; duplicating its condition is how the two drift apart.
- Produces: `ClaimCheckTrigger` with `sources: ClaimCheckManifestEntry[]` exactly as the contract block above. `sourceIds` and `toolCallIds` are **removed**.

- [ ] **Step 1: Write the failing tests**

Replace the existing `sourceIds`/`toolCallIds` assertions with manifest ones, and add the new cases. Keep every existing absence test — they still hold.

**The helper names below (`ctx(...)`, `retrievalResult(...)`) are illustrative.** Use whatever fixture helpers that file already defines; if it builds its contexts inline, build yours the same way rather than introducing a helper the file does not have.

```typescript
// in src/exulu/claim-check/finish-metadata.test.ts
it("names each retrieved document once, as a knowledge_base entry carrying its tool call", () => {
  const out = claimCheckMetadata({ ...ctx({ enabled: true }), toolResults: [retrievalResult("call_1", ["i1", "i2"])] });
  expect(out.claimCheck?.sources).toEqual([
    { type: "knowledge_base", id: "i1", toolCallId: "call_1" },
    { type: "knowledge_base", id: "i2", toolCallId: "call_1" },
  ]);
});

it("names a recalled memory as a memory entry with no tool call", () => {
  const out = claimCheckMetadata({
    ...ctx({ enabled: true }),
    toolResults: [retrievalResult("call_1", ["i1"])],
    recalledMemories: [{ id: "m_7", title: "Sprache", information: "Der Kunde bevorzugt Deutsch." }],
  });
  expect(out.claimCheck?.sources).toContainEqual({ type: "memory", id: "memory:m_7" });
});

it("names a document tool's output as a document entry", () => {
  const out = claimCheckMetadata({
    ...ctx({ enabled: true }),
    toolResults: [retrievalResult("call_1", ["i1"]), { type: "tool-read_session_file", toolCallId: "call_4", output: { content: "230 Volt." } }],
  });
  expect(out.claimCheck?.sources).toContainEqual({ type: "document", id: "tool:call_4", toolCallId: "call_4" });
});

// Review Focus 4
it("does not name a document tool call whose output carries no content", () => {
  const out = claimCheckMetadata({
    ...ctx({ enabled: true }),
    toolResults: [retrievalResult("call_1", ["i1"]), { type: "tool-read_session_file", toolCallId: "call_4", output: { content: "" } }],
  });
  expect(out.claimCheck?.sources.some((s) => s.id === "tool:call_4")).toBe(false);
});

// Review Focus 2
it("does not name a document tool call that failed", () => {
  const out = claimCheckMetadata({
    ...ctx({ enabled: true }),
    toolResults: [retrievalResult("call_1", ["i1"]), { type: "tool-read_session_file", toolCallId: "call_4", output: { error: "Could not read session file" } }],
  });
  expect(out.claimCheck?.sources.some((s) => s.id === "tool:call_4")).toBe(false);
});

// Review Focus 1 — the interaction that would break every check on the public surface
it("names no memory source when the recall list was withheld from this viewer", () => {
  const out = claimCheckMetadata({
    ...ctx({ enabled: true, showToExternalUsers: true }),
    isGuest: true,
    toolResults: [retrievalResult("call_1", ["i1"])],
    recalledMemories: undefined, // what recalledMemoriesMetadata returns for a gated guest
    recallHadItems: true,
  });
  // The spec (§5) is explicit: a withheld memory list means the turn is
  // uncovered and "the fragment must stay absent". The answer may rest on a
  // memory the client cannot send, so there is nothing partial to emit — and
  // asserting partial omission here is also unsatisfiable, since `out` is `{}`
  // and `out.claimCheck?.sources` is then `undefined`, not an array.
  expect(out).toEqual({});
});

it("still emits for a turn with retrieval alone", () => {
  const out = claimCheckMetadata({ ...ctx({ enabled: true }), toolResults: [retrievalResult("call_1", ["i1"])] });
  expect(out.claimCheck?.sources).toHaveLength(1);
});

it("is absent when an attachment was carried, as before", () => {
  const out = claimCheckMetadata({
    ...ctx({ enabled: true }),
    toolResults: [retrievalResult("call_1", ["i1"])],
    messages: [{ role: "user", parts: [{ type: "text", text: '<file file name = "wartung.pdf" >…</file>' }] }],
  });
  expect(out).toEqual({});
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx jest src/exulu/claim-check/finish-metadata.test.ts`
Expected: FAIL — `sources` is undefined on the fragment, and the memory/document cases have no code behind them.

- [ ] **Step 3: Build the manifest**

Replace `retrievedIdsOf`'s two-array return with manifest entries, add a handler per recognised part type, and narrow the suppression. The invisible-evidence set shrinks to what §5 of the spec lists:

```typescript
/**
 * The manifest the client fills in. One entry per source it must send, each
 * naming the handler (`type`) and where to find it (`toolCallId`). The client
 * locates parts BY TOOL CALL ID — no tool display name appears on the frontend
 * any more, which is what makes a rename on this side harmless.
 */
function manifestFor(args: {
  toolResults: unknown;
  recalledMemories: { id: string }[] | undefined;
}): ClaimCheckManifestEntry[] {
  const out: ClaimCheckManifestEntry[] = [];
  const seen = new Set<string>();
  const add = (entry: ClaimCheckManifestEntry) => {
    if (seen.has(entry.id)) return;
    seen.add(entry.id);
    out.push(entry);
  };

  for (const memory of args.recalledMemories ?? []) {
    if (typeof memory?.id === "string" && memory.id) add({ type: "memory", id: `memory:${memory.id}` });
  }

  for (const part of Array.isArray(args.toolResults) ? args.toolResults : []) {
    if (!isRecord(part) || typeof part.type !== "string" || typeof part.toolCallId !== "string") continue;

    if (RETRIEVAL_PART_TYPES.has(part.type)) {
      for (const id of chunkItemIdsOf(part.output)) {
        add({ type: "knowledge_base", id, toolCallId: part.toolCallId });
      }
      continue;
    }

    if (DOCUMENT_PART_TYPES.has(part.type)) {
      // `{ content }` on success, `{ error }` on failure. An error string is not
      // evidence: naming it would have the check verify the answer against a
      // failure message and report grounded claims unsupported.
      const output = isRecord(part.output) ? part.output : undefined;
      const content = typeof output?.content === "string" ? output.content : "";
      if (content.trim()) add({ type: "document", id: `tool:${part.toolCallId}`, toolCallId: part.toolCallId });
      continue;
    }

    if (part.type === WEB_PART_TYPE) {
      add({ type: "web", id: `tool:${part.toolCallId}`, toolCallId: part.toolCallId });
      continue;
    }

    if (part.type === SESSION_ITEMS_PART_TYPE) {
      add({ type: "session_item", id: `tool:${part.toolCallId}`, toolCallId: part.toolCallId });
      continue;
    }
  }

  return out;
}
```

`DOCUMENT_PART_TYPES` is built the way the existing constants are — from each tool's exported display-name literal through `sanitizeToolName`, so there is still only one spelling per tool:

```typescript
const DOCUMENT_PART_TYPES = new Set([
  partTypeOf(SESSION_FILE_READ_TOOL_NAME),
  partTypeOf(PARSE_DOCUMENT_TOOL_NAME),
]);
const WEB_PART_TYPE = partTypeOf(INTERNET_SEARCH_TOOL_NAME);
```

Then narrow the suppression. `view_document_page` and the attachment wrapper stay; the four now-covered paths leave the invisible set. The memory half becomes a *visibility* question rather than a presence question:

```typescript
  // A recall the viewer may not see is still invisible evidence: the client has
  // no memory text to send, so the check would run against part of the answer's
  // evidence. recalledMemoriesMetadata already owns that rule — ask it, do not
  // restate its condition here.
  if (ctx.recallHadItems && !ctx.recalledMemories) return {};
```

- [ ] **Step 4: Run the tests and the gates**

Run: `npx jest src/exulu/claim-check/finish-metadata.test.ts` → PASS, output pristine.
Run: `npx jest src/exulu/claim-check/ ee/claim-check/` → PASS.
Run the typecheck equality: save the 8 baseline identities to a file, then `npm run type-check 2>&1 | grep -E "error TS" | sort | diff - <baseline>` → no output.

- [ ] **Step 5: Commit**

```bash
git add src/exulu/claim-check/ src/exulu/routes.ts
git commit -m "feat(claim-check): name every sendable source in a manifest"
```

---

### Task B2: the request contract gets simpler

**Files:**
- Modify: `ee/claim-check/routes.ts` (`requestSchema` near line 126; the handler's source normalisation)
- Modify: `ee/claim-check/routes.test.ts`
- Modify: `mintlify-docs/api-reference/rest/claim-check.mdx`

**Interfaces:**
- Produces: the request accepts `sources: { content: string; name?: string; type?: ClaimCheckSourceType; id?: string }[]`. The handler normalises each to an internal `{ id, name?, content }` before the engine sees it, so `ee/claim-check/run.ts` and `evidence.ts` are untouched by this task.

- [ ] **Step 1: Write the failing tests**

```typescript
// in ee/claim-check/routes.test.ts
it("accepts a source with only content, and assigns it a positional id", async () => {
  const runCheck = jest.fn().mockResolvedValue(RESULT);
  const { app } = buildApp({ runCheck });
  await post(app, { question: "q", answer: "a", sources: [{ content: "230 Volt." }] }).expect(200);
  expect(runCheck.mock.calls[0][0].sources).toEqual([{ id: "s1", content: "230 Volt." }]);
});

it("keeps a caller's own id and name, and carries type through without acting on it", async () => {
  const runCheck = jest.fn().mockResolvedValue(RESULT);
  const { app } = buildApp({ runCheck });
  await post(app, {
    question: "q", answer: "a",
    sources: [{ id: "memory:m_7", name: "Sprache", type: "memory", content: "Deutsch." }],
  }).expect(200);
  expect(runCheck.mock.calls[0][0].sources).toEqual([{ id: "memory:m_7", name: "Sprache", content: "Deutsch." }]);
});

it("does not let a generated id collide with one the caller supplied", async () => {
  const runCheck = jest.fn().mockResolvedValue(RESULT);
  const { app } = buildApp({ runCheck });
  await post(app, { question: "q", answer: "a", sources: [{ content: "first" }, { id: "s1", content: "second" }] }).expect(200);
  const ids = runCheck.mock.calls[0][0].sources.map((s: { id: string }) => s.id);
  expect(new Set(ids).size).toBe(2);
  expect(ids).toContain("s1");
});

// Review Focus 5
it("rejects two sources that supply the same id rather than merging them", async () => {
  const { app } = buildApp({});
  const res = await post(app, {
    question: "q", answer: "a",
    sources: [{ id: "doc", content: "one" }, { id: "doc", content: "two" }],
  }).expect(400);
  expect(res.body.detail).toMatch(/duplicate source id/i);
});

// An unknown `type` is IGNORED, not rejected: the field is informational, so
// a misspelled label must not cost the caller their check. Before this change
// the schema stripped an unknown key and answered 200 — a bare z.enum here
// would have turned that into a 400 and broken the compatibility promise.
it("ignores an unknown source type instead of rejecting the request", async () => {
  const runCheck = jest.fn().mockResolvedValue(RESULT);
  const { app } = buildApp({ runCheck });
  await post(app, { question: "q", answer: "a", sources: [{ content: "x", type: "guesswork" }] }).expect(200);
  expect(runCheck.mock.calls[0][0].sources).toEqual([{ id: "s1", content: "x" }]);
});

it("still accepts the Stage 1 shape, id and all", async () => {
  const runCheck = jest.fn().mockResolvedValue(RESULT);
  const { app } = buildApp({ runCheck });
  await post(app, { question: "q", answer: "a", sources: [{ id: "i1", name: "h.pdf", content: "x" }] }).expect(200);
  expect(runCheck.mock.calls[0][0].sources[0].id).toBe("i1");
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx jest ee/claim-check/routes.test.ts`
Expected: FAIL — `id` is currently required, so the content-only cases 400; the duplicate case currently passes two identical ids through.

- [ ] **Step 3: Loosen the schema and normalise**

```typescript
const SOURCE_TYPES = ["knowledge_base", "document", "memory", "web", "session_item", "other"] as const;

sources: z
  .array(
    z.object({
      content: z.string(),
      name: z.string().optional(),
      // `.catch` keeps the enum as documentation and typing while never
      // rejecting: an unrecognised label falls back to undefined.
      type: z.enum(SOURCE_TYPES).optional().catch(undefined),
      id: z.string().min(1).optional(),
    }),
  )
  .default([]),
```

```typescript
/**
 * One id per source, because `evidence[].sourceId` has to resolve to exactly one
 * document. A caller may supply ids, none, or some — so a generated id gets `_`
 * suffixes until it stops colliding with a supplied one, and two sources
 * supplying the SAME id are refused: an evidence quote that cannot be traced to
 * one document is worse than a rejected request.
 */
function assignSourceIds(
  sources: { content: string; name?: string; type?: string; id?: string }[],
): { ok: true; sources: { id: string; name?: string; content: string }[] } | { ok: false; detail: string } {
  const supplied = new Set<string>();
  for (const s of sources) {
    if (!s.id) continue;
    if (supplied.has(s.id)) return { ok: false, detail: `duplicate source id "${s.id}"` };
    supplied.add(s.id);
  }
  const used = new Set(supplied);
  return {
    ok: true,
    sources: sources.map((s, i) => {
      let id = s.id;
      if (!id) {
        id = `s${i + 1}`;
        while (used.has(id)) id = `${id}_`;
      }
      used.add(id);
      return s.name ? { id, name: s.name, content: s.content } : { id, content: s.content };
    }),
  };
}
```

Call it right after `requestSchema.safeParse` succeeds, 400 with its `detail` when it fails, and pass `result.sources` onward. **`type` is deliberately dropped here** — the engine treats every type identically (spec §2, no trust tiers) and it exists for the panel and the request log.

- [ ] **Step 4: Run the tests and document the contract**

Run: `npx jest ee/claim-check/routes.test.ts` → PASS.
Then update `claim-check.mdx`: `content` is the only required field on a source, `id` is optional and positional, the `type` enum and that it is informational, and the duplicate-id 400 in the status table.

- [ ] **Step 5: Commit**

```bash
git add ee/claim-check/ mintlify-docs/api-reference/rest/claim-check.mdx
git commit -m "feat(claim-check): accept a source with just its content"
```

---

### Task B3: name the sources that were truncated

**Files:**
- Modify: `ee/claim-check/evidence.ts` (the `truncation` accumulator, ~line 91)
- Modify: `ee/claim-check/run.ts` (the note at ~line 510)
- Modify: `ee/claim-check/run.test.ts`

**Interfaces:**
- Consumes: the existing `SourceTruncation` (`{ sources: number; droppedChars: number }`) returned beside the index by `buildPassageIndex`.
- Produces: `SourceTruncation` gains `names: string[]` — the `name ?? id` of each cut source, in index order. Nothing else about the type changes.

**Read this before you start.** Truncation is **already** reported: `run.ts` sets `state.partial = true`, pushes a note with the source count and the dropped-character count, and that note already says *"so a claim supported only there reads as unsupported"*. A Stage 1 review (R35) put that there deliberately. **Do not touch any of it.** The only gap is that a reader is told *how many* sources were cut, never *which* — and "handbuch.pdf was truncated" is actionable where "2 source(s) were truncated" is not.

- [ ] **Step 1: Write the failing test**

```typescript
// in ee/claim-check/run.test.ts
it("names the truncated source in the note it already emits", async () => {
  const result = await runClaimCheck({
    ...baseArgs,
    sources: [
      { id: "big", name: "handbuch.pdf", content: "x".repeat(MAX_CHARS_PER_SOURCE + 100) },
      { id: "small", content: "fits" },
    ],
  });
  expect(result.status).toBe("partial");                     // unchanged behaviour
  expect(result.limits.truncated).toBe(true);                // unchanged behaviour
  const note = result.notes.find((n) => n.includes("truncated"));
  expect(note).toContain("handbuch.pdf");
  expect(note).not.toContain("small");                       // an uncut source is not named
});

it("falls back to the id when a truncated source has no name", async () => {
  const result = await runClaimCheck({
    ...baseArgs,
    sources: [{ id: "big", content: "x".repeat(MAX_CHARS_PER_SOURCE + 100) }],
  });
  expect(result.notes.find((n) => n.includes("truncated"))).toContain("big");
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx jest ee/claim-check/run.test.ts`
Expected: FAIL — the note contains a count, not a name.

- [ ] **Step 3: Carry the names through**

In `evidence.ts`, where `truncation.sources += 1` already runs:

```typescript
      truncation.sources += 1;
      truncation.droppedChars += full.length - content.length;
      // Which document, not just how many: a reader cannot act on a count.
      truncation.names.push(source.name ?? source.id);
```

Initialise it as `{ sources: 0, droppedChars: 0, names: [] }` and add `names: string[]` to the `SourceTruncation` type. Then in `run.ts`, extend the existing note — keep its wording and its warning sentence, and append the names:

```typescript
      state.notes.push(
        `${truncation.sources} source(s) were truncated at ${MAX_CHARS_PER_SOURCE} characters ` +
          `(${truncation.names.join(", ")}); ` +
          `${truncation.droppedChars} character(s) of evidence were not searched, so a claim supported only there reads as unsupported`,
      );
```

- [ ] **Step 4: Run the tests and the gates**

Run: `npx jest ee/claim-check/` → PASS, pristine. Then the typecheck equality and the lint file-set comparison.

- [ ] **Step 5: Commit**

```bash
git add ee/claim-check/
git commit -m "feat(claim-check): name the sources a check had to truncate"
```

---

### Task F1: read the manifest, and send memories

**Files:**
- Modify: `lib/api/claim-check.ts`
- Modify: `app/(application)/chat/components/claim-check-data.ts`
- Modify: `app/(application)/chat/components/claim-check-data.test.ts`

**Interfaces:**
- Consumes: the manifest from Task B1, verbatim as the contract block states.
- Produces:
  - `type ClaimCheckSourceType` and `ClaimCheckSource` (with `type?`, `id?`) exported from `lib/api/claim-check.ts`
  - `parseClaimCheckTrigger(metadata): { enabled: true; sources: ClaimCheckManifestEntry[] } | null`
  - `collectSources(message: UIMessage, manifest: ClaimCheckManifestEntry[]): ClaimCheckSource[]` — same name as Stage 3, new second argument
- **`RETRIEVAL_PART_TYPES` is deleted from this file.** Parts are found by tool-call id now. That constant was the one place a backend tool rename could silently stop the feature.

- [ ] **Step 1: Write the failing tests**

```typescript
describe("parseClaimCheckTrigger", () => {
  it("accepts a manifest and rejects the Stage 3 shape", () => {
    expect(parseClaimCheckTrigger({ claimCheck: { enabled: true, sources: [{ type: "memory", id: "memory:m_7" }] } }))
      .toEqual({ enabled: true, sources: [{ type: "memory", id: "memory:m_7" }] });
    // The old shape carries no `sources`, so it must read as "nothing to do"
    // rather than as an empty check.
    expect(parseClaimCheckTrigger({ claimCheck: { enabled: true, sourceIds: ["i1"], toolCallIds: ["call_1"] } })).toBeNull();
  });

  it("drops an entry with an unknown type rather than trusting it", () => {
    const out = parseClaimCheckTrigger({
      claimCheck: { enabled: true, sources: [{ type: "memory", id: "memory:m_1" }, { type: "guesswork", id: "x" }] },
    });
    expect(out?.sources).toEqual([{ type: "memory", id: "memory:m_1" }]);
  });
});

describe("collectSources — knowledge_base by tool call id", () => {
  it("finds the retrieval part by its tool call id, whatever the tool is named", () => {
    const message = {
      metadata: { claimCheck: { enabled: true, sources: [{ type: "knowledge_base", id: "i1", toolCallId: "call_1" }] } },
      parts: [{
        type: "tool-Something_Renamed", // deliberately not the production name
        toolCallId: "call_1",
        output: { result: JSON.stringify({ chunks: [{ item_id: "i1", item_name: "h.pdf", chunk_content: "230 Volt." }] }) },
      }],
    } as unknown as UIMessage;
    expect(collectSources(message, [{ type: "knowledge_base", id: "i1", toolCallId: "call_1" }]))
      .toEqual([{ id: "i1", name: "h.pdf", type: "knowledge_base", content: "230 Volt." }]);
  });
});

describe("collectSources — memory", () => {
  it("takes a memory's information out of the turn's metadata", () => {
    const message = {
      metadata: {
        claimCheck: { enabled: true, sources: [{ type: "memory", id: "memory:m_7" }] },
        recalledMemories: [{ id: "m_7", title: "Sprache", information: "Der Kunde bevorzugt Deutsch." }],
      },
      parts: [],
    } as unknown as UIMessage;
    expect(collectSources(message, [{ type: "memory", id: "memory:m_7" }]))
      .toEqual([{ id: "memory:m_7", name: "Sprache", type: "memory", content: "Der Kunde bevorzugt Deutsch." }]);
  });

  it("omits a memory the metadata does not carry, rather than inventing one", () => {
    const message = { metadata: { recalledMemories: [] }, parts: [] } as unknown as UIMessage;
    expect(collectSources(message, [{ type: "memory", id: "memory:m_7" }])).toEqual([]);
  });

  it("omits a memory whose information is empty", () => {
    const message = {
      metadata: { recalledMemories: [{ id: "m_7", title: "Sprache", information: "   " }] },
      parts: [],
    } as unknown as UIMessage;
    expect(collectSources(message, [{ type: "memory", id: "memory:m_7" }])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run "app/(application)/chat/components/claim-check-data.test.ts"`
Expected: FAIL — `parseClaimCheckTrigger` still returns the old shape and `collectSources` takes `sourceIds`.

- [ ] **Step 3: Implement the parser, the lookup and the memory handler**

```typescript
const SOURCE_TYPES = new Set<ClaimCheckSourceType>([
  "knowledge_base", "document", "memory", "web", "session_item", "other",
]);

export function parseClaimCheckTrigger(metadata: unknown): ClaimCheckTrigger | null {
  if (!isRecord(metadata)) return null;
  const fragment = metadata.claimCheck;
  if (!isRecord(fragment) || fragment.enabled !== true || !Array.isArray(fragment.sources)) return null;
  const sources = fragment.sources.filter(
    (s): s is ClaimCheckManifestEntry =>
      isRecord(s) && typeof s.id === "string" && !!s.id &&
      typeof s.type === "string" && SOURCE_TYPES.has(s.type as ClaimCheckSourceType) &&
      (s.toolCallId === undefined || typeof s.toolCallId === "string"),
  );
  return sources.length > 0 ? { enabled: true, sources } : null;
}

/** The tool part a manifest entry points at, found by id rather than by name. */
function partByToolCallId(message: UIMessage, toolCallId: string): Record<string, unknown> | undefined {
  for (const part of (message.parts ?? []) as unknown[]) {
    if (isRecord(part) && part.toolCallId === toolCallId) return part;
  }
  return undefined;
}
```

`collectSources` walks the manifest, dispatches on `type`, and — per the never-invent rule — omits any entry whose content comes back empty:

```typescript
export function collectSources(message: UIMessage, manifest: ClaimCheckManifestEntry[]): ClaimCheckSource[] {
  const out: ClaimCheckSource[] = [];
  const seen = new Set<string>();
  for (const entry of manifest) {
    if (seen.has(entry.id)) continue;
    const source = sourceFor(message, entry);
    // A source with no text is indistinguishable from a fabricated one, and the
    // caller refuses the whole check when the counts disagree. See hooks.ts.
    if (!source || !source.content.trim()) continue;
    seen.add(entry.id);
    out.push(source);
  }
  return out;
}
```

with the `memory` and `knowledge_base` arms implemented in this task and the other three added in Task F2.

- [ ] **Step 4: Run the tests**

Run the focused file, then the whole `npx vitest run` — `collectSources`' signature changed, so its other callers must still compile.

- [ ] **Step 5: Commit**

```bash
git add lib/api/claim-check.ts "app/(application)/chat/components/claim-check-data.ts" "app/(application)/chat/components/claim-check-data.test.ts"
git commit -m "feat(claim-check): read the source manifest, send recalled memories"
```

---

### Task F2: the document, web and session-item handlers

**Files:**
- Modify: `app/(application)/chat/components/claim-check-data.ts`
- Modify: `app/(application)/chat/components/claim-check-data.test.ts`

**Interfaces:**
- Consumes: `partByToolCallId`, `collectSources`' dispatch and the never-invent rule from Task F1.
- Produces: the remaining three arms of `sourceFor`.

**One shape must be measured, not guessed.** `read_session_file`, `parse_document` and `internet_search` have shapes this plan states from their source (`{ content, … }`, `{ error }`, and `{ result: JSON.stringify({ content, citations, search_results }) }`). The **session-items** tool returns `{ result: JSON.stringify(results.flat()) }` where each element comes from `context.search(...)`, and this plan deliberately does not guess that element's fields.

- [ ] **Step 1: Measure the session-items element shape**

Read `src/templates/tools/session-items-retrieval-tool.ts` in the backend repo (`../backend-claim-ui`) and follow `context.search` to its return type. Write down the element's actual fields. **Report them in your task report**, and build the handler against what you found. If the element turns out to carry `item_id` / `item_name` / `chunk_content` like the agentic retrieval chunks do, say so — the handler then shares the knowledge-base arm's extraction rather than duplicating it.

- [ ] **Step 2: Write the failing tests**

Use the shapes this plan states for document and web, and the shape you measured for session items.

```typescript
describe("collectSources — document", () => {
  it("takes a document tool's content and names it from the tool's input filename", () => {
    const message = {
      parts: [{ type: "tool-read_session_file", toolCallId: "call_4", input: { filename: "wartung.pdf" }, output: { content: "230 Volt." } }],
    } as unknown as UIMessage;
    expect(collectSources(message, [{ type: "document", id: "tool:call_4", toolCallId: "call_4" }]))
      .toEqual([{ id: "tool:call_4", name: "wartung.pdf", type: "document", content: "230 Volt." }]);
  });

  // Review Focus 2
  it("never sends a tool error as evidence", () => {
    const message = {
      parts: [{ type: "tool-read_session_file", toolCallId: "call_4", output: { error: "Could not read session file \"x\"." } }],
    } as unknown as UIMessage;
    expect(collectSources(message, [{ type: "document", id: "tool:call_4", toolCallId: "call_4" }])).toEqual([]);
  });
});

describe("collectSources — web", () => {
  it("makes one source per cited page, named by its url", () => {
    const parsed = {
      content: "Die Anlage läuft mit 230 Volt.",
      search_results: [
        { url: "https://example.com/a", title: "Anlagen A", snippet: "230 Volt." },
        { url: "https://example.com/b", title: "Anlagen B", snippet: "Wartung jährlich." },
      ],
    };
    const message = {
      parts: [{ type: "tool-Internet_Search", toolCallId: "call_9", output: { result: JSON.stringify(parsed) } }],
    } as unknown as UIMessage;
    const out = collectSources(message, [{ type: "web", id: "tool:call_9", toolCallId: "call_9" }]);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ id: "tool:call_9#0", name: "https://example.com/a", type: "web", content: "Anlagen A\n\n230 Volt." });
  });

  // Review Focus 3 — zero sources here would trip the completeness guard and
  // silently kill the check on every search turn.
  it("falls back to one source for the search itself when there are no citations", () => {
    const message = {
      parts: [{ type: "tool-Internet_Search", toolCallId: "call_9", output: { result: JSON.stringify({ content: "Die Anlage läuft mit 230 Volt." }) } }],
    } as unknown as UIMessage;
    const out = collectSources(message, [{ type: "web", id: "tool:call_9", toolCallId: "call_9" }]);
    expect(out).toEqual([{ id: "tool:call_9", name: undefined, type: "web", content: "Die Anlage läuft mit 230 Volt." }]);
  });

  it("omits the entry entirely when the payload will not parse", () => {
    const message = {
      parts: [{ type: "tool-Internet_Search", toolCallId: "call_9", output: { result: "<<not json>>" } }],
    } as unknown as UIMessage;
    expect(collectSources(message, [{ type: "web", id: "tool:call_9", toolCallId: "call_9" }])).toEqual([]);
  });
});
```

Plus a session-items test written against the measured shape, and its empty-array case.

**Note on the multi-source entry:** one `web` manifest entry can legitimately produce several sources (`tool:call_9#0`, `#1`, …). The completeness guard in `hooks.ts` compares `sources.length` to `manifest.length` and would read that as a mismatch, so Task F3 changes the guard to compare **covered manifest entries** rather than source counts. Until F3 lands, the web test above will pass while a live web turn is refused — that is expected and F3 closes it.

- [ ] **Step 3: Run them and watch them fail**

Run: `npx vitest run "app/(application)/chat/components/claim-check-data.test.ts"`
Expected: FAIL — the three arms do not exist yet.

- [ ] **Step 4: Implement the three arms**

```typescript
/**
 * `read_session_file` and `parse_document` both answer `{ content, … }` on
 * success and `{ error }` on failure, so one arm serves both. The error branch
 * matters: an error string is not evidence, and sending it would have the check
 * verify the answer against a failure message.
 */
function documentSource(part: Record<string, unknown>, entry: ClaimCheckManifestEntry): ClaimCheckSource | undefined {
  const output = isRecord(part.output) ? part.output : undefined;
  const content = typeof output?.content === "string" ? output.content : "";
  if (!content.trim()) return undefined;
  const input = isRecord(part.input) ? part.input : undefined;
  const name = typeof input?.filename === "string" ? input.filename : undefined;
  return { id: entry.id, name, type: "document", content };
}
```

```typescript
/**
 * Perplexity answers `{ result: JSON.stringify({ content, citations,
 * search_results }) }`. Each `search_results` entry becomes its own source so a
 * verdict can cite the page it came from; with none, the search's own answer
 * text becomes a single source — zero sources would make the caller refuse the
 * whole check, which would silence every search turn.
 */
function webSources(part: Record<string, unknown>, entry: ClaimCheckManifestEntry): ClaimCheckSource[] {
  const output = isRecord(part.output) ? part.output : undefined;
  if (typeof output?.result !== "string") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(output.result);
  } catch {
    return [];
  }
  if (!isRecord(parsed)) return [];
  const results = Array.isArray(parsed.search_results) ? parsed.search_results : [];
  const cited = results.flatMap((r, i) => {
    if (!isRecord(r)) return [];
    const url = typeof r.url === "string" ? r.url : undefined;
    const title = typeof r.title === "string" ? r.title : undefined;
    const snippet = typeof r.snippet === "string" ? r.snippet : "";
    const content = [title, snippet].filter(Boolean).join("\n\n");
    if (!content.trim()) return [];
    return [{ id: `${entry.id}#${i}`, name: url ?? title, type: "web" as const, content }];
  });
  if (cited.length > 0) return cited;
  const answer = typeof parsed.content === "string" ? parsed.content : "";
  return answer.trim() ? [{ id: entry.id, name: undefined, type: "web", content: answer }] : [];
}
```

The session-items arm follows from your Step 1 measurement. **If** the elements are retrieval chunks — `{ item_id, item_name, chunk_content }`, which is what `context.search` returns elsewhere in this codebase — then it is the knowledge-base extraction over a bare array instead of a `chunks` key, and one source per item with its chunks joined:

```typescript
function sessionItemSources(part: Record<string, unknown>, entry: ClaimCheckManifestEntry): ClaimCheckSource[] {
  const output = isRecord(part.output) ? part.output : undefined;
  if (typeof output?.result !== "string") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(output.result);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  // One source per document, its chunks joined, so a quote is attributable to a
  // file rather than to a fragment number.
  const byItem = new Map<string, { name?: string; chunks: string[] }>();
  for (const row of parsed) {
    if (!isRecord(row) || typeof row.item_id !== "string") continue;
    const text = typeof row.chunk_content === "string" ? row.chunk_content : "";
    if (!text.trim()) continue;
    const bucket = byItem.get(row.item_id) ?? { name: typeof row.item_name === "string" ? row.item_name : undefined, chunks: [] };
    bucket.chunks.push(text);
    byItem.set(row.item_id, bucket);
  }
  return [...byItem].map(([itemId, { name, chunks }]) => ({
    id: `${entry.id}#${itemId}`,
    name,
    type: "session_item" as const,
    content: chunks.join("\n\n"),
  }));
}
```

**If your measurement shows different fields, adapt this to what you found and say so in your report** — do not reshape the data to match this snippet, and do not guess a field that is not there. A handler built against a shape the tool does not emit produces zero sources, which makes the caller refuse every session-items check silently.

- [ ] **Step 5: Run the tests and commit**

Run the focused file and the full `npx vitest run`.

```bash
git add "app/(application)/chat/components/claim-check-data.ts" "app/(application)/chat/components/claim-check-data.test.ts"
git commit -m "feat(claim-check): send document, web and session-item evidence"
```

---

### Task F3: the guard across types, and the panel's labels

**Files:**
- Modify: `app/(application)/chat/hooks.ts` (`claimCheckRequestFor`)
- Modify: `app/(application)/chat/claim-check-trigger.test.ts`
- Modify: `app/(application)/chat/components/claim-check.tsx`
- Modify: `messages/de.json`, `messages/en.json`
- Modify: `app/(application)/chat/components/claim-check.test.tsx`

**Interfaces:**
- Consumes: `parseClaimCheckTrigger`, `collectSources` (F1, F2).
- Produces: nothing new; `claimCheckRequestFor`'s signature is unchanged.

- [ ] **Step 1: Write the failing tests**

```typescript
// in app/(application)/chat/claim-check-trigger.test.ts
it("runs the check when every manifest entry produced at least one source", () => {
  // A web entry yields two sources, so a count comparison would wrongly refuse.
  const body = claimCheckRequestFor({ message: webAndKbMessage, question: "q", session: "s", agentId: "a", locale: "de" });
  expect(body?.sources).toHaveLength(3);
});

// The spec's §8 end-to-end case: the turn that produced NOTHING before Stage 4.
it("builds a complete request for a memory turn with retrieval", () => {
  const body = claimCheckRequestFor({ message: memoryAndKbMessage, question: "q", session: "s", agentId: "a", locale: "de" });
  expect(body?.sources.map((s) => s.type)).toEqual(["memory", "knowledge_base"]);
  expect(body?.sources.every((s) => s.content.trim().length > 0)).toBe(true);
});

it("refuses when a manifest entry produced nothing", () => {
  // Two entries named, only one recoverable: the answer may rest on evidence we
  // cannot send, and a partial check reports grounded claims unsupported.
  expect(claimCheckRequestFor({ message: oneMissingMessage, question: "q", session: "s", agentId: "a", locale: "de" })).toBeNull();
});
```

```typescript
// in app/(application)/chat/components/claim-check.test.tsx
it("labels a memory source as a memory, not as a document", () => {
  show({ status: "done", result: resultWithEvidence({ sourceId: "memory:m_7" }) },
       { sourceNames: { "memory:m_7": "Sprache" }, sourceTypes: { "memory:m_7": "memory" } });
  expect(screen.getByText(/Erinnerung/i)).toBeDefined();
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run "app/(application)/chat/claim-check-trigger.test.ts" "app/(application)/chat/components/claim-check.test.tsx"`
Expected: FAIL — the guard still compares counts, and the panel has no type labels.

- [ ] **Step 3: Change the guard to compare coverage, not counts**

```typescript
  const sources = collectSources(message, trigger.sources);
  // One manifest entry can yield several sources (a web search cites several
  // pages), so a length comparison is wrong. What must hold is that EVERY entry
  // contributed something: an entry that produced nothing means the answer may
  // rest on evidence the client cannot send, and verifying against part of the
  // evidence reports grounded claims unsupported.
  const covered = new Set(sources.map((s) => s.id.split("#")[0]));
  if (trigger.sources.some((entry) => !covered.has(entry.id))) return null;
```

- [ ] **Step 4: Add the labels**

Add one key per type under the existing `chat` block in both message files, and render the label beside the source name in the evidence line. German first:

```json
      "claimCheckSourceKnowledgeBase": "Wissensbasis",
      "claimCheckSourceDocument": "Dokument",
      "claimCheckSourceMemory": "Erinnerung",
      "claimCheckSourceWeb": "Web",
      "claimCheckSourceSessionItem": "Angehängtes Element",
      "claimCheckSourceOther": "Quelle"
```

The panel needs the type per source id, so `makeClaimCheck` in `message-column.tsx` builds `sourceTypes` from `collectSources` the same way it already builds `sourceNames`. A type it does not recognise falls back to the plain quote — **never render a raw id or a bare type key at a reader.**

- [ ] **Step 5: Run everything and commit**

Run: `npx vitest run` → green, pristine. `npx eslint` on each touched file. Verify the de/en key sets still match by comparing the sorted key lists, not by eye.
Run: `npm run build` — **once, here**, since this is the last frontend task.

```bash
git add "app/(application)/chat/" messages/de.json messages/en.json
git commit -m "feat(claim-check): guard on coverage and label each source type"
```

---

## Stage 4 done when

- `npx jest src/exulu/claim-check/ ee/claim-check/` and the backend typecheck equality are green.
- `npx vitest run` and `npm run build` are green.
- A memory-only turn, a document-tool turn, a web turn and a session-items turn each produce a fragment, a complete request and a panel — the four cases that produced **nothing** before this stage.
- An attachment turn and a `view_document_page` turn still produce no fragment, and the parent spec's §10 still records why.
- The parent spec's §9 gains Stage 4 as delivered, and `2026-10-14-claim-check-stage-4-source-coverage-design.md` §10 still names coverage-aware scoring as Stage 5.
