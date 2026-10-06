# 3 — What the agent actually uses

**Spec:** `2026-10-01-memory-usage-design.md` (sub-project 3a)

**Hook:** "Half a memory base is never read. Now you can tell which half."

**Why it matters.** Curators could see what was saved, never what agents drew
on. Every memory recalled into an answer is now recorded — one record per
recalled memory per answer, guest sessions included. That produces a **Last
used** column, a **Usage** filter (never used / not used in 90 days), a
**Never used** card, and an **Archive** bulk action for the leftovers.

**Surface:** the base page list and the memory detail Usage section.

**Demo arc (~9s), one slice: find the dead weight and archive it.**
| t | beat |
|---|---|
| 0.0–1.8 | Caption: "Which memories are earning their place?" Hold 1.6s. |
| 1.8–3.0 | The Never used card reads a number. |
| 3.0–4.3 | Apply the Usage filter → the list collapses to never-used rows. |
| 4.3–5.0 | **Breath.** |
| 5.0–6.4 | Select all, Archive. Rows leave. |
| 6.4–7.0 | **Breath.** |
| 7.0–9.0 | Caption: "Archived, not deleted — out of recall, restorable in Knowledge." |

**Snippet:** `memoryBaseUsage` / `memoryBaseUnusedIds` are real operations.
Candidate for the page body, not the video.
