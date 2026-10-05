# Agent memory redesign — sub-project 3c-2: the 3D map view

Date: 2026-10-05 · Status: design approved in conversation, spec for review · Branch: `feat/memory-map-view` (backend from develop 708f100; frontend branch of the same name from local main)

Sub-project 3c was split on 2026-10-04 into **3c-1: positions, the fit and the read API** (merged locally 2026-10-05, develop 708f100) and **3c-2: the view** (this spec). 3c-1 gave every chunk a position in three dimensions and three read queries. This sub-project draws it, and adds the two pieces of backend the drawing needs.

## 1. Purpose

A memory or knowledge base is a list. A list tells you what is in it one row at a time and never tells you what the whole thing is about. The map answers two questions a list cannot: how many distinct topics live in this base, and how thin or crowded each one is. It is also the surface that makes the knowledge feel tangible to someone watching a demonstration, so it has to look good on a large screen without pretending to know more than it does.

Decisions Daniel made on 2026-10-05:

| Decision | Choice |
|---|---|
| What the map is for | understanding what is in a base, and showing the capability convincingly — in that order |
| How a region gets its name | clustered coordinates, named from distinctive words in the existing text index. No model calls |
| How much of the relation graph is drawn | lines on demand, for one selected node |
| What a dot is | **a passage**, always. Not a document |
| Where it lives | as in the shared design: the base page's Overview tab, a card beside a detail panel |
| What replaces the design's entity chips | topic chips, and a panel that shows the selected passage |

### 1.1 Three deviations from the shared design

The mockup (`Memory · Overview with 3D memory map (interactive)`) predates Daniel's 2026-10-04 redirect away from entity extraction. Where it and reality disagree, this spec wins:

1. **Lines are lexical, not entity-based.** Entity extraction is not enabled on most bases. The card's caption says lines join passages that share distinctive wording.
2. **The entity chip row and the entity panel are replaced** by topic chips and a selected-passage panel.
3. **There is no Flagged tab.** No flagging feature exists. The tab bar is Overview, Memories, Conflicts.

## 2. Where it lives

### 2.1 The memory base page

`/memory/[ctx]` has no tabs today: the shell renders a header, five stat cards and the table. It gains a tab bar with three tabs, driven by `?tab=`, defaulting to `overview`, following the mechanism `/data/[ctx]` already uses (URL-driven, only the active tab mounted, `router.replace` without scroll, clearing stale params on switch).

| Tab | Content |
|---|---|
| Overview | the stat cards, then the map card and its panel |
| Memories | today's `MemoryTable`, moved unchanged |
| Conflicts | links to the existing `/memory/[ctx]/conflicts` route |

Conflicts stays a sibling route. Making it a tab body would move shipped, reviewed code for cosmetic gain.

The stat cards stay as built (memories, contributors, last saved, never used, conflicts). The mockup's four-card row is from the same pre-redirect draft as the Flagged tab.

### 2.2 The knowledge workspace

`/data/[ctx]` already has `items | pipeline | entities`. A fourth tab, `map`, renders the same component. The differences are data, not structure: no memory type to colour by, so the colour field is whichever enum field the base declares first, or a single colour when it declares none; and the panel links to `/data/[ctx]/items/[itemId]`.

## 3. Backend additions

3c-1 already provides `contextMapPoints`, `contextMapEdges` and `contextProjectionStatus`, with item-level access control, a 5,000 default and 20,000 cap, and honest `total` / `sampled`. Two things are missing.

### 3.1 Topics

A cloud of dots shows that clusters exist and never says what they are about. Topics are computed **at fit time**, inside `fitContextProjection`, after `backfillCoordinates` succeeds and in the same success path as the projection upsert. They are stored, not computed per request: a label that changes between two page loads of the same unchanged base is a bug, and clustering on read would repeat the work for every viewer.

**Clustering.** k-means over the stored three-dimensional coordinates of the fit's sample, seeded from the same `sanitizeName(contextId)` seed the layout uses, k-means++ initialisation, at most 25 iterations. `k = clamp(round(sqrt(n / 2)), 3, 12)`. Three dimensions and at most 20,000 points make this milliseconds; the cost of the fit stays dominated by the layout.

**Naming.** Each cluster is named from words that are frequent inside it and rare outside it, using the lexemes Postgres already stores:

```sql
SELECT a.cluster, l.lexeme, count(*) AS df
  FROM <temp table of (chunk id, cluster)> a
  JOIN <ctx>_chunks ch ON ch.id = a.id
  CROSS JOIN LATERAL unnest(ch.fts) AS l(lexeme, positions, weights)
 GROUP BY 1, 2
```

The score for a lexeme in a cluster is its in-cluster document frequency over its corpus document frequency, requiring a minimum of two in-cluster documents and a lexeme of at least three characters. The two highest-scoring lexemes, title-cased and joined with ` & `, are the label — the shape the mockup shows (`Steuerblock & Ventile`). A cluster with no qualifying lexeme is labelled by its ordinal (`Topic 4`).

This reuses exactly the mechanism 3c-1 proved for edges. It inherits one honest limitation: lexemes are stemmed, so a label can read slightly clipped in English. German compounds, the primary case here, survive stemming well.

**Storage.** A new core table `context_map_topics`, no RBAC flag, rows replaced per context on each fit:

| Field | Type | Notes |
|---|---|---|
| `context` | text | sanitised context id, as everywhere else |
| `topic_index` | number | 0-based, stable within a fit only |
| `label` | text | |
| `count` | number | sampled chunks in the cluster |
| `x`, `y`, `z` | number | cluster centroid, for the floating label |
| `version` | number | `PROJECTION_VERSION`; a mismatch means "no topics" |
| `fitted_at` | date | |

A new query returns them, gated like the others on an authenticated user:

```graphql
type ContextMapTopic { id: ID!  label: String!  count: Int!  x: Float!  y: Float!  z: Float! }
contextMapTopics(contextId: ID!): [ContextMapTopic!]!
```

`id` is `topic_index` as a string. It identifies a topic only within one fit, which is all the chip row and the `?topic=` parameter need; a refit may renumber.

Counts are the fit's counts, so they are **not** access-scoped and do not change per viewer. That is deliberate and matches `contextProjectionStatus`: a topic count describes the base, not the reader's slice of it. The chip row states this with the same footnote the mockup uses for private memories.

### 3.2 Edges must return passages

`contextMapEdges` groups by item and returns item ids. With passage dots, the view cannot join an edge to a point. It gains the same `mode` argument the points query has:

```graphql
contextMapEdges(contextId: ID!, nodeId: ID!, mode: ContextMapMode = DOCUMENTS, limit: Int = 8): [ContextMapEdge!]!
```

In `PASSAGES` the ranking groups by chunk id and returns chunk ids as `target`; in `DOCUMENTS` nothing changes. The seed already accepts either kind of id, and the exclusion already removes the seed's own item, which stays right in both modes.

## 4. The view

### 4.1 The card

Title **Memory map** (**Knowledge map** on a knowledge base). Caption: *Similar passages sit close together. Lines join passages that share distinctive wording. Drag to rotate.* Three controls in the card's toolbar, as the mockup has them: a segmented **All links / Selection only**, a **pause** toggle for the idle rotation, and a **reset** for the camera. Below the canvas: the topic chips, then the legend, then the footnote.

The frame is the existing `ChartCard` primitive, which already takes a title, description, toolbar slot and an inline error with Retry, and accepts a class name for height. Its built-in loading skeleton is a fixed short height, so the map drives its own skeleton through children at the canvas's height instead, and the card does not jump when the data arrives. The primitive is not modified.

### 4.2 What the view asks for

On mount, per base: `contextMapPoints(contextId, mode: PASSAGES, groupField: <the colour field>, limit: 20000)` once, `contextMapTopics(contextId)` once, and `contextProjectionStatus(contextId)` once for coverage and the not-fitted state. `contextMapEdges(contextId, nodeId, mode: PASSAGES)` runs on each selection. Nothing polls. A memory base additionally reuses the conflicts query the Conflicts route already issues, to ring the passages in a conflict group.

### 4.3 Rendering

The app has never rendered WebGL: there is no canvas, no render loop and no pan-zoom handler anywhere in it. This is genuinely new, and it is the only new dependency: **three.js with its React renderer**, with orbit controls taken from three's own examples rather than adding a helper library. The canvas component is loaded through `next/dynamic` with server rendering off, the one precedent the repo already has, so the library never reaches another route.

- Every passage is one vertex of a single `Points` object: one draw call for up to 20,000 points, positions and colours in typed arrays built once per data change, never per frame. Round dots come from discarding fragments outside the point's radius, not from a texture.
- Conflicted and selected passages are drawn by a second, small `Points` layer with a ring, so the common case stays one buffer.
- Lines are one `LineSegments` object rebuilt only on selection change, opacity scaled by rank.
- Picking uses a raycaster against the points, throttled to one test per animation frame.
- Device pixel ratio is capped at 2.

**Colour cannot come from CSS in WebGL.** The palette is resolved from the theme's chart tokens with `getComputedStyle` at mount and again when the theme changes. Two tokens are excluded: `--chart-2` and `--chart-9` are violet, which is not used in this product's design work. `--chart-5` is grey and reserved for "no value". That leaves seven categorical colours, which is more than the memory contract's declared types need.

### 4.4 Interaction

Drag orbits, wheel zooms within clamped bounds, and the cloud rotates slowly on its own until the pointer touches it or the pause control stops it. Reset restores the initial framing. The existing reduced-motion convention applies: when the viewer prefers reduced motion there is no idle rotation and the toggle starts paused.

Hovering a dot raises a tooltip with the first line of the passage. Selecting one fills the panel, draws its neighbour lines, and writes `?selected=` so the view is linkable. **All links** versus **Selection only** controls whether unselected passages keep faint lines to their nearest neighbour or the cloud stays clean until something is selected; it defaults to Selection only. The mockup shows the opposite segment active, but that draft assumed entity lines, which are far sparser than lexical ones; a base of any size turns a full lexical web into a hairball.

### 4.5 Topics

Topic labels float over the cloud as HTML positioned by projecting each centroid, which keeps them crisp and lets them use the same type tokens as the rest of the page. Labels that would overlap are resolved greedily in favour of the larger cluster, and a label behind the camera is hidden.

The chip row lists the same topics with their counts. Selecting a chip dims every passage outside that cluster and writes `?topic=`. Selecting a chip and selecting a dot are independent; the dot's lines stay visible through a topic filter.

### 4.6 The panel

A docked resizable panel on large screens, a sheet below, reusing the existing primitive. With nothing selected it shows the base's shape: the topic list with counts and the sampled caption. With a passage selected it shows the passage text, its type, the item it belongs to with a link to the item page, the author and when it was saved, the number of times it has been used on a memory base, and then **Closest by wording** — the neighbours from the edges query, each with its score, highlighting its line on hover and selecting it on click.

### 4.7 Legend

Generated from the base's own declared enum, in declared order, by the existing helper that reads a memory base's `type` values — never a hardcoded list, because each base declares its own. A knowledge base uses its first declared enum field, or no legend when it has none. Memory bases with conflicts add the ringed entry the mockup shows.

## 5. Honesty, access and failure

| Case | Behaviour |
|---|---|
| Viewer may not read an item | its passages are absent, as 3c-1 already guarantees; the footnote says private items are counted, never shown |
| Base larger than the cap | the caption states how many of how many passages are drawn |
| Base never fitted, or stale | an empty state explaining the base has not been mapped yet, with what an administrator runs; `contextProjectionStatus` is the source |
| Topics missing or stale while points exist | the cloud draws without labels or chips; no error |
| Edges query fails | the panel shows that neighbours could not be loaded; the cloud is unaffected |
| WebGL unavailable | the card falls back to the empty-state frame saying the map needs hardware acceleration, rather than a blank canvas |
| Coverage below 100% | the caption says how many passages have no position yet, because that is what a half-finished backfill looks like |

## 6. Testing

- **Backend (jest):** k-means determinism from the seed and `k` at the boundaries; label scoring preferring a word frequent in one cluster over a word frequent everywhere; the minimum-document and minimum-length rules; topics written only after a successful backfill and replaced rather than appended on a refit; `contextMapTopics` returning nothing for a stale version; passage-mode edges returning chunk ids and document-mode behaviour unchanged; access scoping unchanged in both modes.
- **Frontend (vitest):** the canvas itself is not exercised in jsdom. Its pure parts are extracted and tested — building the position and colour buffers from points, resolving the palette and excluding the violet tokens, projecting a centroid to screen coordinates, the label-collision rule, the selection and topic URL synchronisation, legend generation from a declared enum, the sampled and partial-coverage captions, and each empty state.
- **UAT (Daniel):** fit a memory base and open Overview; confirm topics read sensibly against the memories they cover; select a passage and confirm its neighbours are genuinely related; confirm a second user with fewer rights sees fewer dots and the same topic counts; repeat on a real knowledge base, which exercises sampling; confirm the view on a laptop screen and on a large display; confirm reduced motion stops the rotation.

## 7. Out of scope

The Flagged tab and any flagging feature, entity-based chips and lines, a whole-graph precomputed mesh, editing or resolving conflicts from inside the map, fitting from the UI, search inside the map, and any 2D fallback renderer.
