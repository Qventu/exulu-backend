# 2 — The Memory area

**Spec:** `2026-09-30-memory-area-design.md` (sub-project 2)

**Hook:** "One place that answers: what has this agent actually learned?"

**Why it matters.** Builders had no view of all memory bases, what each agent
had learned, or one memory in full. The Memory area under Build adds three
pages — bases overview, per-base list with a stats strip, memory detail —
built as memory-specific views over the existing knowledge workspace, so
filters, access and dialogs behave exactly as curators already expect.

**Surface:** `/memory` and `/memory/[ctx]`.

**Demo arc (~8s), one slice: overview → one memory.**
| t | beat |
|---|---|
| 0.0–1.6 | Caption: "Every base, every agent." Hold 1.4s. |
| 1.6–3.0 | Bases overview: cards with counts. |
| 3.0–4.2 | Click into a base; stats strip resolves above the list. |
| 4.2–4.9 | **Breath.** |
| 4.9–6.2 | Open one memory — the detail page, in full. |
| 6.2–8.0 | Caption: "Readable, editable, access-controlled — like any knowledge item." |

**Snippet:** `memoryBaseStats` is real and developer-facing, but the slice is a
UI walkthrough. Hold the snippet for the page body rather than the video.
