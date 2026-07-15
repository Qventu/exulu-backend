# Prose section plan — One budget, every model (no video)

## Sources of truth

- Spec: `docs/superpowers/specs/2026-07-07-context-window-management-design.md`
  §"Thresholds" + §1 (foundations)
- Backend: `src/exulu/context-budget.ts` (`deriveContextBudget`, `contextOccupancy`,
  `sliceHistoryAtCheckpoint`, `b01b148`), `src/exulu/resolve-context-window.ts`
  (`338cfb1`), ordered checkpoint-aware `getAgentMessages` in `src/exulu/provider.ts`
  (`4388173`)
- Frontend mirror: `frontend/app/(application)/chat/lib/context-budget.ts` (`4987217`) —
  "the formulas MUST match byte-for-byte"

## Why prose, not video

Pure infrastructure — threshold math, catalog lookups, and SQL ordering have no
demoable surface. The visible consequences (meter, banner, block) each have their own
short. This section is the "how it all hangs together" copy between them.

## What shipped (raw material for 2–3 paragraphs)

- **The real window, at runtime.** `resolveContextWindow` finally gives the backend the
  model's actual max input tokens: LiteLLM mode reads the catalog
  (`max_input_tokens ?? max_tokens`), catalog mode reads `ExuluProvider.maxContextLength`,
  unknown models fall back to 128K with a logged config warning. Before this, runtime
  consumers always saw a hardcoded 128K — too big for 32K models, too small for 1M models.
  It respects the `x-exulu-model-override` header, so overriding to a small model tightens
  every guard automatically.
- **One formula set, shared everywhere.** From `contextWindow` a single module derives the
  whole budget: `outputReserve = min(32K, 20%)`, `usableWindow = window − reserve`, warn at
  80%, block at 95%, per-tool-output cap `min(25K, max(4K, 10% of window))`, compaction
  tail 10%, summary budget `min(8K, 5% of usable)`. The frontend mirrors the same file so
  the meter, the banner, and the backend gate can never disagree.
- **Occupancy that self-corrects.** Occupancy = the newest *real* number (the last
  assistant turn's provider-reported usage, or the latest compaction checkpoint's
  estimate) plus a chars/4 estimate of everything after it. Real usage re-anchors the
  estimate every turn, so drift never accumulates.
- **Deterministic history.** `getAgentMessages` now loads the full session ordered by
  `created_at` (tiebreak on id) — the old code had `limit: 50` with **no ORDER BY**, so
  long sessions sent an arbitrary heap-ordered subset to the model. Compaction checkpoints
  keep the assembled prompt bounded: the model view is
  `[checkpoint, …messages after it]` via `sliceHistoryAtCheckpoint`.

Benefit angle: every other feature on this page (meter, compaction, caps, gates) derives
from this one module — same math on client and server, same numbers for every provider
and model, LiteLLM and catalog mode alike.

## Code snippet decision

**No snippet.** Nothing here is exported from `backend/src/index.ts`, exposed as a route
in `src/exulu/routes.ts`, or queried from `frontend/queries/queries.ts` — internal by
design. A compact thresholds table (Name / Formula / Purpose, straight from the spec) may
stand in for code if the section needs a visual anchor.
