# Release Backlog — Gap Analysis

> Generated 2026-06-22. Tracks **shipped** features that don't yet have a release page in `releases/`.
> Sources cross-referenced: `releases/` (existing pages), backend git history + `backend/docs/superpowers/specs/`,
> and the `frontend/` repo (`frontend/design/` + git history).

Commit hashes are short SHAs. Backend repo = `exulu/backend`, frontend repo = `exulu/frontend`.

---

## Already released (for reference)

| Release page | Features covered |
|---|---|
| `releases/2026-05-24-speech-to-text/` | Speech-to-text |
| `releases/2026-05-29-transcription/` | Transcription (review/rename, standalone Whisper, knowledge+chat) |
| `releases/2026-05-29-spring-platform-release/` | Session files panel, follow-up suggestions, LiteLLM proxy, skill bundle upload, GDPR export/delete |
| `releases/2026-06-10-summer-release/` | ExuluTool OAuth, in-chat image generation, personal system prompt, teams |

---

## Missing release pages (shipped, no release page yet)

### Flagship

**1. Frontend redesign — "new Exulu"** *(the big one)*
New navigation + mobile + design-system overhaul across 20 pages. Merged to `main` 2026-06-20.
- Master plan / living status: `frontend/design/IMPLEMENTATION_PLAN.md` (§6 tracking table)
- Pillar docs: `frontend/design/{philosophy,navigation,responsive,personas,codebase-structure}.md`
- 20 page specs: `frontend/design/pages/*.md` · audits: `frontend/design/audits/*.md`
- Commits: `7c2895f` … `dd4b58c` (2026-06-11 → 06-20), merged via `cb3cb68` (PR #7 `4b8cff0`)
- Pillars: Spine persona-grouped RBAC nav, command palette, role-composed Home; mobile DoD at 390/768/1024/1440 in both themes; semantic tokens/type scale; per-page redesigns (chat, projects, auth, dashboard, agents, prompts, skills, knowledge); Knowledge V2 pipeline (F1–F4).

### Shipped & live, no release page

| # | Feature | Backend ref | Frontend ref |
|---|---|---|---|
| 2 | **Recall.ai meeting recording** | `src/exulu/recall/` (`e00698e`); spec `docs/superpowers/specs/2026-06-19-recall-meeting-recording-design.md` (`01f32ed`) | `app/(application)/transcriptions/` meeting-composer/review-sheet (`dd4b58c`) |
| 3 | **Graph retrieval / entity layer** | `2026-06-06-graph-retrieval-design.md` (`03e0c6f`, `de939a0`, `09be511`, `79bbcbe`) | entity-types in /data (`edb1356`) |
| 4 | **Tag-based budget management** | `2026-06-07-tag-budget-management-design.md` (`e99a07a`, `fe0f9b9`, `28e7cbe`) | budgets in top bar + analytics (`f05cbef`, `0101bd6`) |
| 5 | **Knowledge Base V2** | KB-1/3/4/5/7 (`f44f826`, `b24a965`, `3006173`) | pipeline V2 phases F1–F4 (`5deb5ac`→`ec41aa3`) |
| 6 | **LiteLLM rerankers + embeddings/OCR routing** | `2026-06-19-litellm-reranker-design.md` (`e00698e`) | — |
| 7 | **Text-to-speech** (only STT was announced) | `2026-05-25-text-to-speech-design.md` (`091e186`, `ab3af43`) | — |
| 8 | **Models / agent-provider decoupling** | `2026-05-23-models-entity-agent-decoupling-design.md` (`815efc3`) | LiteLLM-only catalog (`0d6d0c1`) |
| 9 | **API-key agent scoping (enterprise)** | `2026-05-21-api-key-scoping-and-agent-rate-limits-design.md` (`78eec19`; rate-limit half later removed `9174cef`) | — |
| 10 | **Vertex billing labels** | `2026-05-22-vertex-billing-labels-design.md` (`2621c1d`) | — |
| 11 | **Skill sandbox → S3 artifact persistence** | `2026-05-17-skill-sandbox-s3-artifact-persistence-design.md` (`602b8f7`, `a7f9a60`, `6ff5a71`) | — |
| 12 | **Memory: surrounding-context capture** | `a5913e0` (no spec) | — |

---

## Design-only — do NOT release yet

- **Headroom token compression** — `docs/superpowers/specs/DRAF_2026-06-19-headroom-token-compression-design.md` (`2e6affe`). Draft, no implementation. The only genuinely unbuilt item.

---

## Release packages

- ✅ **(A) Frontend redesign** — BUILT 2026-06-22 → `releases/2026-06-22-new-exulu-redesign/` (shorts: the-spine, mobile, design-system, home). Covers #1.
- ✅ **(B) "Knowledge & Cost"** — BUILT 2026-06-22 → `releases/2026-06-22-knowledge-and-cost/` (shorts: recall, kb-v2, budgets, entities, litellm-routing). Covers #2, #3, #4, #5, #6.
- ⬜ **(C) Smaller items** — still no release page: TTS (#7), models decoupling (#8), API-key scoping (#9), Vertex billing (#10), skill-sandbox S3 (#11), memory context (#12). Fold into the next platform release.

> Design-only, still not shippable: Headroom token compression (draft, no implementation).
