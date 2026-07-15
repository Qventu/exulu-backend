# Feature plan — "Also shipped" (compact curated list, PROSE, no snippet, no video)

## Sources of truth (one commit each, all verified)

- Backend `c3884ff` — fix(chat): auto-decline stale tool approvals when the
  user moves on
- Backend `92623b3` — feat(redis): fail fast with clear logs when Redis is
  unreachable at startup
- Backend `9ee95ee` — feat: chunk large PDFs for OCR (≤25-page chunks via
  split_pdf.py, parallel with p-limit(3), works around Vertex's 30-page limit)
  + accept `x-api-key` header as an alternative to `exulu-api-key`
- Backend `f25b2c8` — feat: set `hnsw.ef_search=20` on all connections;
  `97e8f47` — perf(search): reusable precomputed query embedding + gated phase
  timing
- Frontend `58418cc` — fix(chat): use theme foreground token for response text
  (WCAG AA contrast)
- Frontend `900bf7d` — perf(chat): stop main-thread saturation while streaming
  multi-file agent turns

## What this section is

A single tight list at the bottom of the page — one line per item, benefit
first, no videos, no snippets. Order as below (user-visible first, infra last).

## Copy plan (one line each, adjust freely at page-build time)

1. **Stale tool approvals auto-decline.** Move on to a new message and pending
   approval prompts resolve themselves — no zombie "Awaiting Approval" chips.
2. **Chat text is WCAG AA.** Response text now uses the theme foreground token —
   full contrast in both themes.
3. **Smoother streaming on heavy turns.** Multi-file agent turns no longer
   saturate the browser main thread while streaming.
4. **Big PDFs OCR reliably.** 60-page scans are split into ≤25-page chunks and
   processed in parallel — no more Vertex page-limit failures.
5. **`x-api-key` accepted.** API callers can authenticate with the
   industry-standard header alongside `exulu-api-key`.
6. **Faster vector search.** `hnsw.ef_search` tuned on every connection and
   query embeddings computed once and reused across retrieval phases.
7. **Redis fails fast.** If Redis is unreachable at startup the server says so
   loudly and exits, instead of hanging half-alive.

## Hook

Section header: **"Also shipped"** — one-liner: "Small fixes that make the
whole platform feel tighter."

## Code snippet — NOT EARNED

Changelog lines, not surfaces.
