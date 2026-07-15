# Prose section plan — Token transparency (retrieval benchmark line + in/out split)

**Page treatment: prose only — no video.** These are two ambient read-only
adornments; there is no user action to demo, and both already appear in-frame in
short C (`trajectory-reuse-feedback`). A dedicated short would violate the
one-action rule (there is none) and read as a static screenshot.

## Sources of truth

- Code (frontend commits `608d1f8`, `25b8d4e`, `22fbcc3`, 06-29):
  - `frontend/lib/retrieval-metrics.ts` — `formatRetrievalMetrics`: builds
    `↳ retrieval · {in} in / {out} out tokens · {s} s` (en-US number format,
    seconds to one decimal), returns null when no usable metrics.
  - `frontend/components/message-renderer-tool-data.ts` — pulls `result.metrics`
    from the knowledge-search tool output (both the typed context-search branch
    and the generic tool branch).
  - `frontend/components/message-renderer.tsx:996-998` / `:1068-1070` — renders
    the line under the tool result: `mt-1 text-xs text-muted-foreground`.
  - `frontend/components/message-renderer.tsx:1296-1302` — message footer:
    `{total} tokens · {in} in / {out} out` in a `<small class="text-muted-foreground">`,
    shown when the message metadata carries both numbers.
- No spec file; no i18n keys (formats are code-level, en-US).

## What shipped

Two small honesty features. Every knowledge-search result now carries a
one-line benchmark — exactly what the retrieval run cost in tokens and wall
time: `↳ retrieval · 2,412 in / 486 out tokens · 3.2 s`. And the per-message
token count in the footer now splits into input and output:
`1,412 tokens · 1,120 in / 292 out`.

## Hook

**Every answer now shows its receipt — retrieval cost and token split, inline.**

## Prose draft (2–3 paragraphs of benefit language)

1. Retrieval used to be a black box: you saw the sources, not the cost. Now
   every knowledge search prints its receipt right under the result — input and
   output tokens plus wall-clock time — so heavy queries are visible the moment
   they happen, not at the end of the month in an analytics view.
2. The message footer follows suit: instead of one opaque total, each assistant
   reply shows the input/output split. Input-heavy turns (big context, long
   history) look different from output-heavy ones (long generations), and that
   difference is exactly what you tune — presets, compaction, retrieval budgets.
3. Nothing to configure and nothing new to learn: both lines are quiet,
   muted-text adornments that appear whenever the metrics exist and stay out of
   the way when they don't.

## Code snippet decision

**No snippet.** Display-only UI; `formatRetrievalMetrics` is an internal
frontend helper, not a public SDK/REST/GraphQL surface. Nothing relevant in
`backend/src/index.ts`, `backend/src/exulu/routes.ts`, or
`frontend/queries/queries.ts`.
