# The map, made legible — sub-project 3c-3

Date: 2026-10-05 · Status: design approved in conversation, spec for review · Branch: `feat/map-legibility` (backend from develop 0fb5723, frontend from main 17d8e93)

## 1. Why

The map shipped and was shown a real base for the first time: `hydraulik_steuerbloecke`, 1,134 German passages, twelve named regions. It rendered correctly and communicated nothing. Daniel's verdict: the dots are hard to tell apart, there is no colour difference between clusters, there are buttons whose purpose is unclear, numbers that mean nothing, and no overall utility.

Three causes, two of them structural rather than cosmetic. All three trace to the same origin: the design was drawn for a fifty-memory base coloured by `type`, and the first real test was an eleven-hundred-passage knowledge base with no declared types at all.

## 2. What is actually wrong

### 2.1 The cloud is a streak, and we do that to it

Measured on the fitted base: `corr(px, py) = −0.80`. The points lie close to a line.

The fit computes a genuine non-linear layout for the sampled passages, then **discards it** and stores the *linear approximation* for every chunk — including the 1,129 it had true positions for.

**Corrected on 2026-10-06, by this sub-project's own measurement.** This section originally concluded that the linear approximation *is what flattened the cloud*, and cited the −0.80 correlation as its evidence. That was wrong. Storing the true positions moved the correlation from −0.795 to −0.779 — nothing. The residual of 0.144 had been saying so all along: a linear map only approximates a layout that closely when the layout is already nearly linear.

The real cause is the **camera**. The layout is an elongated ellipsoid whose long axis lies diagonally across two axes, while the camera sits fixed on the third — so a flattened cloud was being seen nearly edge-on. §4.1 is the fix that followed, and it is the one that worked.

The change below is still worth making, on its own narrower grounds: the layout is known exactly for the sampled passages, so storing an approximation of something already known is wasteful and wrong. It is simply not the fix for what was on screen.

### 2.2 Every dot is the same colour

Colour encodes a declared enumeration field. A memory base has `type`; a knowledge base has none, so every dot falls through to the reserved "no value" colour. The organising idea of the map — its regions — is the one thing colour does not show.

### 2.3 The frame carries no weight

The side panel repeats the chip row verbatim. The counts appear twice and never say what they count. Two controls do nothing visible until a passage is selected, and nothing says so. Labels overlap the dots and each other.

## 3. Decisions

| Decision | Choice |
|---|---|
| What colour encodes | **the region**, on every base, matching the chips. The palette cycles where regions outnumber it (see §5.1) |
| What a sampled passage's coordinates are | **its true layout position**, not the linear approximation |
| What the linear map is still for | passages that arrive after the fit, and only those |
| Where the memory `type` goes | the panel, on selection — it stops being a colour channel |
| What the panel shows with nothing selected | nothing; it is not open |

## 4. Coordinates (backend)

Three changes in the fit, all in `src/exulu/projection/`. The third was added on 2026-10-06, after §2.1's diagnosis was refuted; it is the one that fixed what was on screen.

### 4.1 Rotate the layout onto its own axes

The layout's long axis can lie anywhere and the camera does not move, so an elongated cloud is seen edge-on as often as not. Aligning the layout with its own principal axes before anything else consumes it is a **proper rotation** — every distance and every neighbour survives — and it puts the widest spread across the screen instead of into the depth.

Measured on `hydraulik_steuerbloecke`: the three axis correlations went from −0.779, −0.217 and −0.163 to 0.001, 0.000 and −0.001, with spreads moving from 0.381 / 0.220 / 0.245 to 0.449 / 0.276 / 0.137. The cloud is a sheet of roughly three to one with its widest face now at the camera.

The axes are ordered by the spread of the data along them and their signs are pinned, because an axis and its negation describe the same orientation and without a convention a refit of unchanged data would mirror the cloud and rewrite every stored coordinate for nothing.

This reuses the existing subspace iteration rather than adding a second eigensolver. Doing so surfaced a real defect in the shared orthonormalisation, which on a low-rank cloud could return a vector parallel to one it had already accepted; fixing it changes the basis handed to the layout for **every** base on its next refit, which is the one behavioural change here that a reader will not find in §4.2 or §4.3.

### 4.2 Cluster in layout space

k-means currently runs over `applyMap(reduced)` — the linear approximation. It runs over the layout itself instead. The centroids then live in the same space as the stored coordinates, which is what the client's nearest-centre membership assumes.

### 4.3 Store the layout for the sample

`backfillCoordinates` writes `applyMap(...)` for every chunk. It takes the fit's sample as a map of chunk id to layout position and writes that instead wherever it has one, falling back to the linear map for the rest. On this base that is 1,129 of 1,134 rows; on a base larger than `FIT_SAMPLE` the sample is 20,000 and the remainder uses the map, which is exactly what the map was learned for.

The residual keeps its current meaning — how far a *new* passage lands from where the layout would have put it — and becomes more honest, because it now measures the only thing the linear map is still used for.

Nothing about the stored shape changes: three `real` columns, same table, same projection row. A refit is required to see it, which is already true of every layout change.

## 5. Colour and the frame (frontend)

### 5.1 Colour by region

The client already derives region membership by nearest centre, so no new field is served. `buildBuffers` takes the region of each passage rather than its group value, and the palette is indexed by region. Passages in no region — only possible when a base has no regions at all — keep the reserved grey.

The region palette must survive twelve regions where the approved palette holds seven non-violet entries. It cycles, and adjacent regions in space may therefore share a colour. That is acceptable: the chips carry the names, and colour is for telling neighbours apart, not for identifying a region on its own.

### 5.2 The chips become the legend

One row, not two. Each chip carries the swatch of its region's colour, its label and its count. The separate legend and the panel's duplicate list both go.

### 5.3 The panel opens when it has something to say

With nothing selected it does not open. Selecting a passage opens it with the passage, its item link, its type where the base declares one, and its neighbours. Closing it clears the selection.

### 5.4 Controls appear when they do something

The links control is shown only while a passage is selected, and the faint whole-cloud web it governs is gated on that selection too. Pause and reset stay, reduced to icons with labels, in the canvas corner rather than the card header.

Corrected on 2026-10-05 during execution. This paragraph originally justified hiding the control by claiming it "only changes anything with a selection". That is false: the renderer draws the web from its own geometry whenever the control is set, with no reference to the selection, so hiding the control alone would have left a web on screen that nothing could turn off. Gating the web with its control keeps the viewer's choice for their next selection, where resetting it on deselect would silently discard it.

### 5.5 The caption says what the numbers are

One line under the chips, replacing two: what a dot is, what a count counts, and that private items are counted but never drawn. The sampling and coverage captions are unchanged.

### 5.6 Labels stay readable

Floating labels are drawn with the page's own contrast — a background plate rather than bare text over dots — and only for regions whose centre is in front of the camera and whose box survives collision, which is already the rule.

## 6. What does not change

The clustering and naming, the identifier and stop-word filters, the relation lines, the edges and status queries, access scoping, the dynamic import, and the two pages' tab mechanics. The map's data model is right; this is about what it stores for the sample and what the page does with it.

## 7. Testing

- **Backend (jest):** k-means runs over the layout, not the approximation; the backfill writes the layout position for a sampled chunk and the linear map for an unsampled one; a refit of the same base reproduces the same coordinates; the residual is still scored on held-out rows.
- **Frontend (vitest):** buffers coloured by region and not by group; a base with no regions falls to grey; the chips carry the matching swatch; the panel is closed with nothing selected and open with a selection; the links control is absent until then.
- **UAT:** refit `hydraulik_steuerbloecke` and compare the shape against the streak in the screenshot; confirm the twelve regions are visually separable; confirm a memory base still reads well with `type` in the panel rather than in colour.

## 8. Out of scope

The three regions still named by short identifier fragments — no charset rule separates them from real part codes, and the honest fix is upstream, where document identifiers are written into chunk text. The German knowledge bases indexed with the English text-search configuration only, which affects search far more than labels. Search inside the map. A whole-graph relation mesh.
