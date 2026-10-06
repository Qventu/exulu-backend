# 4 — Conflicts

**Spec:** `2026-10-03-memory-conflicts-design.md` (sub-project 3b)

**Hook:** "Two memories disagree. The agent believes both."

**Why it matters.** Bases accumulate near-duplicates and contradictions, and
nothing surfaced them. An on-demand scan per base finds both: duplicates by
similarity, contradictions judged by a structured model call per candidate
pair. Three resolutions — keep one, merge into one memory, dismiss as not a
conflict. **Public memories only; private memories never enter detection.**

**Surface:** `/memory/[ctx]/conflicts`, plus a Conflicts card on the base page.

**Demo arc (~9s), one slice: scan, then resolve one group by merging.**
| t | beat |
|---|---|
| 0.0–1.8 | Caption: "Find what contradicts itself." Hold 1.6s. |
| 1.8–3.2 | Click **Find conflicts**; the scan resolves into grouped cards. |
| 3.2–3.9 | **Breath.** |
| 3.9–5.4 | Open one group: two memories side by side, visibly in tension. |
| 5.4–6.8 | Choose **Merge** — a suggested single memory appears. |
| 6.8–7.4 | **Breath.** |
| 7.4–9.0 | Caption: "Keep one, merge, or dismiss. The decision is recorded." |

**Snippet:** `memoryConflictsScan`, `memoryConflictResolve`,
`memoryConflictSuggestMerge` — all real. Good candidate for a GraphQL snippet
in the page body.
