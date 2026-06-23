# Release Page B — "Knowledge & Cost"

Folder: `releases/2026-06-22-knowledge-and-cost/`
Five shipped features; one 16:9 short each. Brand tokens shared with Page A (`hyperframes/design.md`).

## Shorts (all rendered → `shorts/`)
1. **recall** — "Send a bot to any meeting" (Recall.ai). Surface: Transcripts UI. Snippet: GraphQL `meetingBotStart`. Refs: backend `src/exulu/recall/`, spec `docs/superpowers/specs/2026-06-19-recall-meeting-recording-design.md`; frontend `app/(application)/transcriptions/{meeting-composer,job-row,review-sheet}.tsx`.
2. **kb-v2** — "A pipeline that shows its work" (Knowledge Base V2). Surface: item-detail pipeline stepper. No snippet. Refs: KB-1/3/4/5/7 (`f44f826`, `b24a965`, `3006173`); frontend `data/[ctx]/items/[itemId]/item-pipeline-status.tsx`, `pipeline-health.tsx`.
3. **budgets** — "Cap spend on anything" (tag budgets). Surface: /budgets table + top-bar chip. Snippet: REST `PUT /admin/budgets/...`. Refs: spec `2026-06-07-tag-budget-management-design.md` (`e99a07a`); frontend `budget-bar.tsx`, `top-bar-budget.tsx`.
4. **entities** — "A connected entity graph" (graph retrieval). Surface: /data Entities tab. Snippet: `ExuluContext({ entities })`. Refs: spec `2026-06-06-graph-retrieval-design.md` (`03e0c6f`); frontend `data/components/entity-types.tsx`, `item-entities-section.tsx`.
5. **litellm-routing** — "One path for every model" (rerankers/embeddings/OCR). Surface: infra diagram + YAML. Snippet: `config.litellm.yaml`. Refs: spec `2026-06-19-litellm-reranker-design.md`, commit `e00698e`.

## Honesty note
The reranker shipped with `ExuluReranker` **kept** as a LiteLLM-backed shim (not deleted as the spec proposed). The page copy says "routes through the proxy" — it does not claim the class was removed.

## Outputs
- `index.html` — hero + 5 feature sections (embedded 16:9 video + prose + snippet where it earns its place)
- `shorts/*.mp4` (+ `.jpg` posters) — 1920×1080
- `hyperframes/compositions/*.html` — reproducible sources
