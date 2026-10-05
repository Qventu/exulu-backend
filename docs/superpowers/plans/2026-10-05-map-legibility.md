# Map Legibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the three-dimensional map readable on a real base: stop flattening the cloud, colour the regions, and strip the frame down to what earns its place.

**Architecture:** Two backend changes in the fit — cluster in layout space, and store each sampled passage's true layout position instead of its linear approximation — then three frontend changes: colour by region rather than by a declared field, merge the legend into the chips, and show the panel and the links control only when they have something to say.

**Tech Stack:** TypeScript ESM backend (knex/Postgres, jest), Next.js 16 / React 19.2 frontend (Apollo, next-intl, vitest, three.js).

**Spec:** `docs/superpowers/specs/2026-10-05-map-legibility-design.md`

**Worktrees:** backend `/Users/daniel.claessen/Desktop/Projects/exulu/backend-agent-memory` (from develop 0fb5723), frontend `/Users/daniel.claessen/Desktop/Projects/exulu/frontend-agent-memory` (from main 17d8e93). Both already on `feat/map-legibility`.

## Global Constraints

- Backend tests `npx jest <path> --maxWorkers=2`; frontend `npx vitest run <path> --maxWorkers 2`. **Never** pass `-w` to either; that is watch mode.
- Backend typecheck must stay at **8** errors, in four pre-existing unrelated files. Frontend typecheck clean, lint unchanged from baseline, message parity green, `npm run build` succeeds with three.js in no route's initial scripts.
- Colour comes from theme tokens only. **`--chart-2` and `--chart-9` are violet and must never be used**; `--chart-5` is grey and reserved for "no region".
- `components/widgets/**` bans literal user-visible strings: every fixed string comes from `next-intl`, and every new key goes in **both** message files.
- Verify the branch in the same command as every commit. No dependency changes. Never push, never merge.
- No dev server, no background processes, nothing touching any `.env*` file, no secrets printed.

## Review Focus

- **A base smaller than the sample** — every chunk is in the sample, so the linear map is never used for storage, yet a passage added tomorrow still needs one. The fit must learn and store it anyway. Pinned in Task 1.
- **A base larger than the sample** — sampled chunks get layout positions and the rest get approximated ones, in the same space. The two must not be visibly different populations. Pinned in Task 1.
- **A base with more regions than palette colours** — twelve regions against seven approved entries, so colours repeat. The chips must stay the authority on identity. Pinned in Task 2.
- **A base with no regions at all** — never fitted, or fitted before regions existed. Every dot takes the reserved grey and no chips render, without error. Pinned in Task 2.
- **A passage in no region** — only reachable with no regions or a non-finite coordinate. It must draw grey rather than vanish or throw. Pinned in Task 2.

---

## File Structure

**Backend**
- `src/exulu/projection/fit.ts` — cluster in layout space; hand the backfill the sample's layout positions.
- `src/exulu/projection/fit.test.ts` — the new storage contract.

**Frontend**
- `components/widgets/context-map/map-data.ts` + test — `buildBuffers` colours by region.
- `components/widgets/context-map/map-canvas.tsx` — pass regions through; label plates.
- `components/widgets/context-map/context-map-card.tsx` + test — chips as legend, conditional panel and controls, one caption.
- `components/widgets/context-map/map-panel.tsx` — type on selection.
- `messages/en.json`, `messages/de.json`.

---

### Task 1: Store the layout, not its shadow

**Files:**
- Modify: `src/exulu/projection/fit.ts` (the `computeTopics` call around line 201; `backfillCoordinates` at 228)
- Test: `src/exulu/projection/fit.test.ts`

**Interfaces:**
- Produces: `backfillCoordinates({ db, contextId, projection, layout, batch?, log? })` where `layout` is `Map<string, [number, number, number]>` from chunk id to its true layout position. Absent id means the linear map is used.

- [ ] **Step 1: Write the failing test**

```ts
it("stores the layout position for a sampled chunk and the linear map for the rest", async () => {
  // Two chunks: one in the fit's sample, one that arrived later. The sampled
  // one must land where the layout put it, not where the linear map guesses.
  const written: Record<string, number[]> = {};
  const db = fakeFitDb({ onCoordinateWrite: (id: string, xyz: number[]) => { written[id] = xyz; } });
  await fitContextProjection({ db, contextId: "mem", components: 2, umapFactory: fakeUmap });
  expect(written["id-0"]).toEqual(LAYOUT_OF_ID_0);
  expect(written["id-unsampled"]).not.toEqual(LAYOUT_OF_ID_0);
});

it("clusters the layout, not the approximation", async () => {
  // No spy is needed and none should be invented: with a fake layout whose
  // points all fall in one cluster, the stored centroid IS the mean of what was
  // clustered. The layout and the linear map differ by the residual, so the
  // centroid tells you which of the two the k-means saw.
  const db = fakeFitDb({});
  await fitContextProjection({ db, contextId: "mem", components: 2, umapFactory: fakeUmap });
  const centroid = db.__topicRows[0];
  expect(centroid.x).toBeCloseTo(MEAN_OF_FAKE_LAYOUT[0], 5);
  expect(centroid.y).toBeCloseTo(MEAN_OF_FAKE_LAYOUT[1], 5);
  expect(centroid.z).toBeCloseTo(MEAN_OF_FAKE_LAYOUT[2], 5);
});

it("still learns and stores a map on a base smaller than the sample", async () => {
  // Every chunk is in the sample, so nothing is stored through the linear map —
  // but a passage added tomorrow still needs one, so it must be fitted anyway.
  const db = fakeFitDb({});
  const result = await fitContextProjection({ db, contextId: "mem", components: 2, umapFactory: fakeUmap });
  expect(result.fitted).toBe(true);
  const projection = db.__writes.find((w: any) => w.table === "context_projections");
  expect(JSON.parse(projection.rows[0].map)).toHaveLength(3);
});
```

Extend the file's existing fake so it records coordinate writes per id and exposes the clustering input; keep every current assertion intact.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest src/exulu/projection/fit --maxWorkers=2`
Expected: FAIL — the sampled chunk currently gets the linear map's output.

- [ ] **Step 3: Cluster the layout**

In `src/exulu/projection/fit.ts`, replace the coordinates passed to `computeTopics`:

```ts
      // Cluster where the points will actually be drawn. The layout is the real
      // structure; applyMap is its linear shadow, and clustering the shadow puts
      // the centroids somewhere the dots are not.
      coordinates: layout.map((p) => [...p]),
```

- [ ] **Step 4: Hand the backfill the sample's positions**

Build the map alongside the projection and pass it down:

```ts
  // The fit computed a true position for every sampled chunk. Storing the linear
  // approximation for those too is what flattened the cloud: a linear map cannot
  // reproduce a non-linear embedding, so it collapses the structure toward its
  // dominant direction (measured on a real base: corr(px, py) = -0.80). The map
  // is still what places a chunk that arrives after the fit, which is all it was
  // ever learned for.
  const sampledLayout = new Map<string, [number, number, number]>();
  for (const [i, s] of sampled.entries()) {
    const p = layout[i];
    if (p) sampledLayout.set(s.id, [p[0] ?? 0, p[1] ?? 0, p[2] ?? 0]);
  }
  const written = await backfillCoordinates({ db, contextId, projection, layout: sampledLayout, log });
```

In `backfillCoordinates`, accept `layout` and prefer it per row:

```ts
      const known = layout?.get(String(row.id));
      const [x, y, z] = known ?? applyMap(
        projectComponents(l2normalize(raw), mean, basis), projection.map, projection.intercept,
      );
```

Keep the dimension check ahead of it, so a row whose embedding no longer matches is still skipped rather than written from a stale layout.

- [ ] **Step 5: Run the tests and the typecheck**

Run: `npx jest src/exulu/projection --maxWorkers=2 && npx tsc --noEmit -p tsconfig.json 2>&1 | grep -c "error TS"`
Expected: PASS; count 8.

- [ ] **Step 6: Commit**

```bash
git branch --show-current   # feat/map-legibility
git add src/exulu/projection/fit.ts src/exulu/projection/fit.test.ts
git commit -m "fix(map): store the layout for sampled passages, not its linear shadow"
```

---

### Task 2: Colour by region

**Files:**
- Modify: `components/widgets/context-map/map-data.ts`, its test
- Modify: `components/widgets/context-map/map-canvas.tsx`, `context-map-card.tsx`

**Interfaces:**
- Produces: `buildBuffers(points, regionOf, palette)` where `regionOf: (point: MapPoint) => number` returns a region index or `-1`.

- [ ] **Step 1: Write the failing test**

```ts
it("colours a point by its region, not by its group value", () => {
  const palette = { colors: [[1, 0, 0], [0, 1, 0]] as Rgb[], noValue: [0.5, 0.5, 0.5] as Rgb };
  const points = [point("a", "FACT"), point("b", "FACT")];
  const { colors } = buildBuffers(points, (p) => (p.id === "a" ? 0 : 1), palette);
  expect(Array.from(colors.slice(0, 3))).toEqual([1, 0, 0]);
  expect(Array.from(colors.slice(3, 6))).toEqual([0, 1, 0]);
});

it("gives a point in no region the reserved grey", () => {
  const palette = { colors: [[1, 0, 0]] as Rgb[], noValue: [0.5, 0.5, 0.5] as Rgb };
  const { colors } = buildBuffers([point("a", null)], () => -1, palette);
  expect(Array.from(colors)).toEqual([0.5, 0.5, 0.5]);
});

it("cycles when a base has more regions than colours", () => {
  const palette = { colors: [[1, 0, 0], [0, 1, 0]] as Rgb[], noValue: [0.5, 0.5, 0.5] as Rgb };
  const { colors } = buildBuffers([point("a", null)], () => 2, palette);
  expect(Array.from(colors)).toEqual([1, 0, 0]);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run components/widgets/context-map --maxWorkers 2`
Expected: FAIL — `buildBuffers` still takes `groups`.

- [ ] **Step 3: Implement**

Change the signature to take a region resolver, and index the palette by it:

```ts
export function buildBuffers(
  points: MapPoint[], regionOf: (point: MapPoint) => number, palette: Palette,
): { positions: Float32Array; colors: Float32Array } {
  // …positions unchanged…
    const region = regionOf(p);
    const rgb = region < 0
      ? palette.noValue
      : (palette.colors[region % Math.max(1, palette.colors.length)] ?? palette.noValue);
```

`MapCanvasProps` changes with it: `groups: string[]` becomes `regionOf: (point: MapPoint) => number`, and the canvas passes that straight to `buildBuffers`. Nothing else in the canvas reads `groups`, and its colour effect keeps its existing dependency shape with `regionOf` in place of `groups`.

In the card, build the resolver from the regions already loaded, memoised on them, and pass it to the canvas in place of `groups`:

```ts
  // topicOf is the same nearest-centre rule the dimming uses, so a dot's colour
  // and its chip can never disagree.
  const regionIndex = React.useMemo(() => {
    const order = new Map(topics.map((t, i) => [t.id, i]));
    return (p: MapPoint) => order.get(topicOf(p, topics) ?? "") ?? -1;
  }, [topics]);
```

- [ ] **Step 4: Run the tests and the gates**

Run: `npx vitest run components/widgets/context-map --maxWorkers 2 && npx tsc --noEmit`
Expected: PASS; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git branch --show-current   # feat/map-legibility
git add components/widgets/context-map
git commit -m "feat(map): a dot takes the colour of its region"
```

---

### Task 3: The chips become the legend, and the frame loses a layer

**Files:**
- Modify: `components/widgets/context-map/context-map-card.tsx` (chips around line 422, legend at 449, captions at 493)
- Modify: `components/widgets/context-map/map-panel.tsx`
- Modify: `messages/en.json`, `messages/de.json`
- Test: `components/widgets/context-map/context-map-card.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
it("shows one row of chips carrying their region's colour, and no separate legend", async () => {
  render(withProviders([pointsMock, topicsMock, statusMock]));
  const chips = await screen.findAllByRole("button", { name: /Steuerblock/ });
  expect(chips).toHaveLength(1);
  expect(chips[0].querySelector("[data-region-swatch]")).not.toBeNull();
  expect(screen.queryByTestId("map-legend")).toBeNull();
});

it("keeps the panel shut until a passage is selected", async () => {
  render(withProviders([pointsMock, topicsMock, statusMock]));
  await waitFor(() => expect(screen.getByTestId("canvas")).toBeInTheDocument());
  expect(screen.queryByRole("complementary")).toBeNull();
});

it("hides the links control until a passage is selected", async () => {
  render(withProviders([pointsMock, topicsMock, statusMock]));
  await waitFor(() => expect(screen.getByTestId("canvas")).toBeInTheDocument());
  expect(screen.queryByRole("tab", { name: /links/i })).toBeNull();
});

it("states once what a dot is and what a count counts", async () => {
  render(withProviders([pointsMock, topicsMock, statusMock]));
  expect(await screen.findByText(/passage/i)).toBeInTheDocument();
  expect(screen.queryAllByText(/counted but never shown/i)).toHaveLength(1);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run components/widgets/context-map --maxWorkers 2`
Expected: FAIL — the legend renders, the panel is open, the links control is present.

- [ ] **Step 3: Implement**

- Delete the separate legend block and `legendEntries` from the card's imports; give each chip a swatch element carrying `data-region-swatch` and the region's token, so the chip row is the legend.
- Render `MapPanel` only when a passage is selected; its close clears the selection.
- Render the links segmented control only when a passage is selected.
- Move pause and reset out of the card header into the canvas's own top-right corner as icon buttons with accessible names, so the header carries the title and nothing else. They stay always-available: unlike the links control, both do something the moment the cloud is drawn.
- Replace the two caption lines with one `map.caption.explained` saying what a dot is, what a count counts, and that private items are counted and never drawn. Keep the sampled and coverage captions as they are.
- In `map-panel.tsx`, show the passage's `group` as a badge where the base declares one — this is where memory `type` now lives.

Message keys to add to both files: `map.caption.explained`, `map.legend.region`. Remove `map.legend.noValue` if nothing else uses it, and run the parity check.

- [ ] **Step 4: Run the tests and the gates**

Run: `npx vitest run components/widgets/context-map --maxWorkers 2 && npm run check-messages && npx tsc --noEmit`
Expected: PASS; parity OK; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git branch --show-current   # feat/map-legibility
git add components/widgets/context-map messages/en.json messages/de.json
git commit -m "feat(map): the chips are the legend, and the frame shows only what it can act on"
```

---

### Task 4: Labels that can be read over dots

**Files:**
- Modify: `components/widgets/context-map/map-canvas.tsx` (the label overlay at the end of the component)

- [ ] **Step 1: Give each label a plate**

The labels are HTML over the canvas, so this is a class change, not a shader one. Replace the bare span's classes with a plate that carries the page's own surface and a soft border, keeping `pointer-events-none` and the centring transform:

```tsx
        <span
          key={l.id}
          className="pointer-events-none absolute whitespace-nowrap rounded border border-border/60 bg-background/85 px-1.5 py-0.5 text-xs font-medium text-foreground shadow-sm backdrop-blur-[2px]"
          style={{ left: l.x, top: l.y, transform: "translate(-50%, -50%)" }}
        >
          {l.label}
        </span>
```

The collision rule already measures a box per label; widen its estimate to match the new padding so plates do not overlap where bare text did not.

- [ ] **Step 2: Verify the gates**

Run: `npx tsc --noEmit && npx eslint components/widgets/context-map && npx vitest run components/widgets/context-map --maxWorkers 2`
Expected: all clean. There is no test for the canvas by design; the collision rule's own test in `map-data.test.ts` covers the widened box.

- [ ] **Step 3: Commit**

```bash
git branch --show-current   # feat/map-legibility
git add components/widgets/context-map
git commit -m "feat(map): region labels sit on a plate so they read over the cloud"
```

---

### Task 5: Verification, a refit, and the handover

**Files:** none changed unless a gate fails.

- [ ] **Step 1: Gates in both repositories**

Backend:
```bash
npx jest --silent --maxWorkers=2 2>&1 | grep -E "^(Tests:|Test Suites:|FAIL)" | sort -u
npx tsc --noEmit -p tsconfig.json 2>&1 | grep -c "error TS"
```
Expected: only `compact-session`, `email-inbound/intake` and `resolve-context-window` fail; count 8.

Frontend:
```bash
npx vitest run --maxWorkers 2 2>&1 | tail -3
npm run check-messages
npm run lint 2>&1 | tail -3
npm run build 2>&1 | tail -3
```
Expected: green; parity OK; lint unchanged from baseline; build succeeds.

- [ ] **Step 2: Refit the real base and measure the change**

Against the restored local copy, which is where this was diagnosed:

```bash
POSTGRES_DB_HOST=127.0.0.1 POSTGRES_DB_PORT=5432 POSTGRES_DB_USER=postgres \
POSTGRES_DB_PASSWORD=localdev POSTGRES_DB_NAME=algi POSTGRES_DB_SSL=false \
npx tsx scripts/fit-context-projection.ts --context hydraulik_steuerbloecke
```

Then compare the shape against the streak this work exists to fix:

```bash
docker exec algi-local psql -U postgres -d algi -c \
  "select round(corr(px,py)::numeric,3) corr_xy, round(stddev(px)::numeric,3) sd_x,
          round(stddev(py)::numeric,3) sd_y, round(stddev(pz)::numeric,3) sd_z
     from hydraulik_steuerbloecke_chunks where px is not null;"
```

Report both numbers. Before this work: `corr_xy = -0.795`, `sd 0.363 / 0.208 / 0.232`. A cloud rather than a streak means the correlation falls well away from ±1 and the three spreads move closer together. **If the correlation is still near ±0.8, stop and say so — the change did not do what it was meant to.**

- [ ] **Step 3: Hand off**

Report the gate output verbatim, both correlation figures, and this list for Daniel:

1. Open `/data/hydraulik_steuerbloecke?tab=map` and compare against the streak screenshot.
2. Confirm the twelve regions are visually separable and that chip colours match their dots.
3. Confirm two regions sharing a colour are far apart, not adjacent.
4. Select a passage: the panel opens, the links control appears, closing it clears the selection.
5. Confirm the labels read over the dots at the default camera distance.
6. Open a memory base and confirm it still reads well with `type` in the panel rather than in colour.
