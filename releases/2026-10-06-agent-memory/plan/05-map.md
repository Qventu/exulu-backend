# 5 — The map

**Specs:** `2026-10-04-vector-map-positions-design.md` (3c-1),
`2026-10-05-memory-map-view-design.md` (3c-2),
`2026-10-05-map-legibility-design.md` (3c-3)

**Hook:** "A list tells you what is in a base one row at a time. The map tells
you what it is about."

**Why it matters.** Every passage carries a position computed from its
embedding, so a base draws as a cloud where near means similar. Regions are
clusters, **named from distinctive words in the text index the search already
keeps — no model is asked**, so a region's name is the base's own vocabulary.
Selecting a dot draws lines to the passages worded most like it and opens the
item. On a memory base a slider filters by when a memory was added, so you
can watch the base fill in.

**Surface:** the base page's Overview tab.

**Demo arc (~10s), one slice: the cloud, a region, a selection.**
| t | beat |
|---|---|
| 0.0–2.0 | Cloud rotating. Caption: "Every passage, placed by meaning." Hold 1.8s. |
| 2.0–3.4 | Region labels resolve; chips appear beneath. |
| 3.4–4.1 | **Breath.** |
| 4.1–5.5 | Hover a chip — everything outside that region dims. |
| 5.5–7.0 | Select a dot: lines to its nearest neighbours, panel opens on the item. |
| 7.0–7.6 | **Breath.** |
| 7.6–10.0 | Caption: "Named from the base's own words. No model asked." |

**Caution for the brief:** the cloud must be reconstructed, not screen-grabbed
— the real map needs WebGL and a fitted base. Build it as animated 2D
projection with the real palette and real region names from a fitted base.

**Snippet:** `contextMapPoints` / `contextMapTopics` are real and genuinely
developer-facing. Strongest snippet candidate of the five.
