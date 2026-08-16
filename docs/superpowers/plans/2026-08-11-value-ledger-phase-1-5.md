# Value Ledger Phase 1.5 — Storytelling Layer

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the monthly report from a wall of levels into a story: month-over-month movement on every figure, a project dimension management recognises, and charts instead of tables for the evidence that matters.

**Architecture:** No new data sources. Deltas come from previously-frozen snapshots, summarised into the new snapshot at build time so the report still reads exactly one immutable object. The project split reuses the existing tag-expansion pattern. Charts are pure HTML/CSS bars — no SVG, no images — because that is what survives Gmail and Outlook.

**Tech Stack:** Unchanged. Next.js 15, TypeScript, Drizzle, `pg`, Vitest, nodemailer.

**Context:** Phase 0 + Phase 1 are complete (125 tests, UAT Stage A passed). This plan responds to the first real rendered report reading flat. See `../logs/2026-08-11-value-ledger-uat-stage-a.md`.

## Global Constraints

Carried unchanged from Phase 1. Every task's requirements implicitly include these.

- **G1 — Never sum across tag dimensions.** A request carries ~8 tags. Totals come from `LiteLLM_SpendLogs` rows only; tag aggregation is valid within one dimension.
- **G3 — Snapshot immutability.** Write-once on the `month` primary key. A frozen month is never recomputed. **New in this plan:** the delta baseline is *copied into* the snapshot at build time, so a frozen report's deltas can never change afterwards either.
- **G4 — Team-level only, min-N 5.** No per-person figures in the report. Reaffirmed by Daniel when this phase was scoped. See Task 2 for how this applies to projects, which is not obvious.
- **G5 — Evidence-Lock.** Every number rendered must have been emitted through the `NumberRegistry`. **Task 3 covers a new way to break this** — read it before writing any delta rendering.
- **G8 — Money units.** Source rows carry `spendUsd`; panels carry `spendReporting`. Convert once.
- **C3 — The email is the artifact.** Charts must render in a mail client, not a browser.

## File Structure

```
src/
├── metrics/
│   ├── types.ts          MODIFY — PreviousMonthSummary, HistoryPoint, ProjectAdoption, panel additions
│   └── projects.ts       NEW    — buildProjects()
├── litellm/
│   ├── types.ts          MODIFY — ProjectRow, LiteLLMSource.projects()
│   ├── source-sql.ts     MODIFY — projects() implementation
│   └── source-fake.ts    MODIFY — projects fixture field
├── snapshot/
│   ├── prior.ts          NEW    — summarise(), loadPriorContext()
│   └── build.ts          MODIFY — accept PriorContext, embed previous + history
├── report/
│   ├── delta.ts          NEW    — deltaLabel(), DELTA_NONE
│   ├── chart.ts          NEW    — barTrack(), barRow()
│   ├── html.ts           MODIFY — narrative opening, charts, project section
│   └── csv.ts            MODIFY — project, delta and history rows
└── jobs/monthly.ts       MODIFY — load prior context, pass to buildSnapshot
```

---

## Task 1: Carry the delta baseline inside the snapshot

Deltas need last month's numbers. Rather than have the renderer read two snapshots, the
build copies a small summary of the prior month *into* the new snapshot. Three reasons:
the report still reads exactly one object; a frozen report's deltas are frozen too (G3);
and a month built before its predecessor exists simply has `previous: null` rather than
deltas that appear later and change history.

**Files:**
- Modify: `src/metrics/types.ts`
- Create: `src/snapshot/prior.ts`
- Modify: `src/snapshot/build.ts`
- Modify: `src/jobs/monthly.ts`
- Test: `tests/snapshot/prior.test.ts`

**Interfaces:**
- Consumes: `Snapshot`, `readSnapshot(db, month)` from `src/snapshot/freeze.ts`
- Produces: `PreviousMonthSummary`, `HistoryPoint`, `PriorContext`, `summarise(s: Snapshot): PreviousMonthSummary`, `loadPriorContext(db, month, monthsBack): Promise<PriorContext>`, and `buildSnapshot(src, cfg, month, now, prior)` — note the **new fifth parameter**

- [ ] **Step 1: Add the types**

In `src/metrics/types.ts`, add above `Snapshot`:

```ts
/** Last month's comparable scalars, copied into this snapshot so deltas freeze with it. */
export type PreviousMonthSummary = {
  month: string;
  spendReporting: number;
  activePeople: number;
  costInHours: number;
  breakEvenMinutesPerPerson: number;
  medianActiveDays: number;
  apiRequests: number;
  failureRatePct: number;
  attributionCoveragePct: number;
  spendByTeam: Record<string, number>;
  spendByProject: Record<string, number>;
  spendByTool: Record<string, number>;
};

/** One point on the multi-month trend charts. Oldest first. */
export type HistoryPoint = {
  month: string;
  spendReporting: number;
  activePeople: number;
};
```

and add these two fields to `Snapshot`:

```ts
  previous: PreviousMonthSummary | null;
  history: HistoryPoint[];
```

- [ ] **Step 2: Write the failing test**

Create `tests/snapshot/prior.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { summarise, loadPriorContext } from "../../src/snapshot/prior";
import { makeSnapshotFixture } from "../fixtures/snapshot";

describe("summarise", () => {
  it("extracts the comparable scalars", () => {
    const p = summarise(makeSnapshotFixture());
    expect(p.month).toBe("2026-07");
    expect(p.spendReporting).toBeCloseTo(4847, 2);
    expect(p.activePeople).toBe(41);
  });

  it("keys team and tool spend by label", () => {
    const p = summarise(makeSnapshotFixture());
    expect(p.spendByTeam["Engineering"]).toBeCloseTo(3600, 2);
    expect(p.spendByTool["claude-cli"]).toBeCloseTo(3777.33, 2);
  });
});

describe("loadPriorContext", () => {
  const snapFor = (month: string, spend: number) => {
    const s = makeSnapshotFixture();
    s.month = month;
    s.bar.spendReporting = spend;
    return s;
  };

  it("returns the immediately preceding month as previous", async () => {
    const db = { __snapshots: { "2026-06": snapFor("2026-06", 100) } } as never;
    const read = vi.fn(async (_db: unknown, m: string) =>
      (m === "2026-06" ? snapFor("2026-06", 100) : null));
    const ctx = await loadPriorContext(db, "2026-07", 6, read);
    expect(ctx.previous?.month).toBe("2026-06");
    expect(ctx.previous?.spendReporting).toBe(100);
  });

  it("returns previous:null when the preceding month was never frozen", async () => {
    const read = vi.fn(async () => null);
    const ctx = await loadPriorContext({} as never, "2026-07", 6, read);
    expect(ctx.previous).toBeNull();
    expect(ctx.history).toEqual([]);
  });

  it("builds history oldest-first and skips gaps", async () => {
    const have: Record<string, number> = { "2026-04": 10, "2026-06": 30 };
    const read = vi.fn(async (_db: unknown, m: string) =>
      (m in have ? snapFor(m, have[m]!) : null));
    const ctx = await loadPriorContext({} as never, "2026-07", 6, read);
    expect(ctx.history.map((h) => h.month)).toEqual(["2026-04", "2026-06"]);
    expect(ctx.history[0]!.spendReporting).toBe(10);
  });

  it("does not include the reporting month itself in history", async () => {
    const read = vi.fn(async (_db: unknown, m: string) => snapFor(m, 1));
    const ctx = await loadPriorContext({} as never, "2026-07", 3, read);
    expect(ctx.history.some((h) => h.month === "2026-07")).toBe(false);
  });
});
```

- [ ] **Step 3: Run it to confirm it fails**

Run: `pnpm vitest run tests/snapshot/prior.test.ts`
Expected: FAIL — cannot find module `../../src/snapshot/prior`

- [ ] **Step 4: Implement `src/snapshot/prior.ts`**

```ts
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { HistoryPoint, PreviousMonthSummary, Snapshot } from "../metrics/types";
import { readSnapshot } from "./freeze";

export type PriorContext = {
  previous: PreviousMonthSummary | null;
  history: HistoryPoint[];
};

type Db = NodePgDatabase<Record<string, unknown>>;
type Reader = (db: Db, month: string) => Promise<Snapshot | null>;

function addMonths(month: string, n: number): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

const byLabel = <T>(rows: T[], label: (r: T) => string, value: (r: T) => number) => {
  const out: Record<string, number> = {};
  for (const r of rows) out[label(r)] = value(r);
  return out;
};

export function summarise(s: Snapshot): PreviousMonthSummary {
  return {
    month: s.month,
    spendReporting: s.bar.spendReporting,
    activePeople: s.bar.activePeople,
    costInHours: s.bar.costInHours,
    breakEvenMinutesPerPerson: s.bar.breakEvenMinutesPerPerson,
    medianActiveDays: s.adoption.medianActiveDays,
    apiRequests: s.reliability.apiRequests,
    failureRatePct: s.reliability.failureRatePct,
    attributionCoveragePct: s.bar.attributionCoveragePct,
    spendByTeam: byLabel(s.adoption.teams, (t) => t.teamLabel, (t) => t.spendReporting),
    spendByProject: byLabel(s.adoption.projects, (p) => p.projectLabel, (p) => p.spendReporting),
    spendByTool: byLabel(s.adoption.clientTools, (t) => t.tool, (t) => t.spendReporting),
  };
}

/**
 * Reads previously-frozen snapshots to build the delta baseline and trend history.
 * `read` is injectable so the tests need no database.
 */
export async function loadPriorContext(
  db: Db, month: string, monthsBack: number, read: Reader = readSnapshot,
): Promise<PriorContext> {
  const history: HistoryPoint[] = [];
  for (let back = monthsBack; back >= 1; back--) {
    const m = addMonths(month, -back);
    const snap = await read(db, m);
    if (snap) {
      history.push({
        month: snap.month,
        spendReporting: snap.bar.spendReporting,
        activePeople: snap.bar.activePeople,
      });
    }
  }
  const prevSnap = await read(db, addMonths(month, -1));
  return { previous: prevSnap ? summarise(prevSnap) : null, history };
}
```

- [ ] **Step 5: Wire it into `buildSnapshot`**

In `src/snapshot/build.ts`, add the import and a fifth parameter, and include both fields
in the returned object:

```ts
import type { PriorContext } from "./prior";

export async function buildSnapshot(
  src: LiteLLMSource, cfg: AppConfig, month: string, now: Date,
  prior: PriorContext = { previous: null, history: [] },
): Promise<Snapshot> {
```

and in the returned object literal, alongside `minN`:

```ts
    previous: prior.previous,
    history: prior.history,
```

The default argument keeps every existing call site and test compiling unchanged.

- [ ] **Step 6: Wire it into the job**

In `src/jobs/monthly.ts`, inside `runMonthlyJob`, replace the `buildSnapshot` call with:

```ts
  const prior = await loadPriorContext(deps.db, month, HISTORY_MONTHS);
  const snapshot = await buildSnapshot(deps.src, deps.cfg, month, now, prior);
```

adding `import { loadPriorContext } from "../snapshot/prior";` and, near the top of the
file, `const HISTORY_MONTHS = 6;`.

The guard still runs first — do not move it.

- [ ] **Step 7: Update the snapshot fixture**

In `tests/fixtures/snapshot.ts`, add to the returned object:

```ts
    previous: null,
    history: [],
```

- [ ] **Step 8: Run the tests**

Run: `pnpm vitest run`
Expected: all pass, including the 4 new prior tests. `summarise` references
`s.adoption.projects`, which Task 2 adds — until then, TypeScript will error on that line.
**Implement Task 2 before running the full suite**, or temporarily stub `spendByProject: {}`
and restore it in Task 2. Prefer doing Task 2 first if you are executing out of order.

- [ ] **Step 9: Commit**

```bash
git add -A && git commit -m "feat: carry delta baseline and trend history inside the snapshot"
```

---

## Task 2: The project dimension

Projects are the cut management actually thinks in — real values in production look like
`fihavpr---fingerhaus-vertriebsportal-relaunch` and `tecsafe---shopify-app`. They cover
82.3% of spend and are entirely absent from the current report.

**Files:**
- Modify: `src/litellm/types.ts`, `src/litellm/source-sql.ts`, `src/litellm/source-fake.ts`
- Modify: `src/metrics/types.ts`
- Create: `src/metrics/projects.ts`
- Modify: `src/metrics/adoption.ts`
- Test: `tests/metrics/projects.test.ts`, and an addition to `tests/litellm/source-sql.integration.test.ts`

**Interfaces:**
- Consumes: `LiteLLMSource`, `median`/`rollUpBelowMinN` patterns from `src/metrics/min-n.ts`
- Produces: `ProjectRow` (source layer), `ProjectAdoption` (panel layer), `LiteLLMSource.projects()`, `buildProjects(rows, opts): ProjectAdoption[]`, `AdoptionPanel.projects`

### How G4 applies to projects — read before implementing

Min-N exists to stop the report identifying an individual. Applying it to projects the way
it is applied to teams would collapse almost everything into "Other": there are ~39 projects
across 45 people, so most have one or two active users, and the panel would say nothing.

But a project row *is* person-identifying in one specific column — the headcount. "One
person worked on Fingerhaus" plus internal knowledge names them.

So the rule for projects is different from teams, and deliberately so:

- **Always show** the project label, its spend and its request count. What a client project
  cost is a business fact, and it is the reason this panel exists.
- **Suppress the headcount** when it is below `minN`: emit `activePeople: null`, which the
  renderer shows as `<5` rather than a number.

Do not roll small projects into "Other" — that would defeat the purpose.

- [ ] **Step 1: Add the source-layer type and interface method**

In `src/litellm/types.ts`, beside `ClientToolRow`:

```ts
/** Per-project rollup from the `project_name_*` tag dimension. */
export type ProjectRow = {
  project: string;
  spendUsd: number;
  requests: number;
  activeUsers: number;
};
```

and add to the `LiteLLMSource` interface, beside `clientTools`:

```ts
  /** Spend and activity per project, from the project_name_* tag dimension. */
  projects(fromIso: string, toIso: string): Promise<ProjectRow[]>;
```

- [ ] **Step 2: Add the fake source field**

In `src/litellm/source-fake.ts`, add `projects?: ProjectRow[];` to `FakeData`, add
`ProjectRow` to the type import, and add to the returned object:

```ts
    async projects() { return data.projects ?? []; },
```

- [ ] **Step 3: Write the failing integration test**

Append to `tests/litellm/source-sql.integration.test.ts`, inside the existing `describe`:

```ts
  it("rolls up spend and distinct users per project", async () => {
    const rows = await created.source.projects(FROM, TO);
    const eng = rows.find((r) => r.project === "alpha")!;
    // r1 + r2 both carry project_name_alpha and user_id_1
    expect(eng.spendUsd).toBeCloseTo(3.0, 6);
    expect(eng.requests).toBe(2);
    expect(eng.activeUsers).toBe(1);
  });
```

and add the project tag to rows r1 and r2 in `tests/fixtures/seed-litellm.sql` by inserting
`"project_name_alpha",` immediately after `"team_name_eng",` in each of those two rows.

- [ ] **Step 4: Run it to confirm it fails**

Run: `pnpm vitest run tests/litellm/source-sql.integration.test.ts`
Expected: FAIL — `created.source.projects is not a function`

- [ ] **Step 5: Implement the SQL**

In `src/litellm/source-sql.ts`, add beside `clientTools`. `project_name_` is 13 characters,
so the offset is `from 14`:

```ts
    async projects(from, to) {
      const { rows } = await pool.query(
        `SELECT project,
                COALESCE(SUM(spend),0) AS spend,
                COUNT(*) AS requests,
                COUNT(DISTINCT user_id) AS users
         FROM (
           SELECT s.spend,
             (SELECT substring(x from 14) FROM jsonb_array_elements_text(s.request_tags::jsonb) x
              WHERE x LIKE 'project\\_name\\_%' LIMIT 1) AS project,
             (SELECT substring(x from 9) FROM jsonb_array_elements_text(s.request_tags::jsonb) x
              WHERE x LIKE 'user\\_id\\_%' LIMIT 1) AS user_id
           FROM "LiteLLM_SpendLogs" s
           WHERE s."startTime" >= $1 AND s."startTime" < $2
         ) z
         WHERE project IS NOT NULL
         GROUP BY 1 ORDER BY 2 DESC`,
        [from, to],
      );
      return rows.map((r) => ({
        project: r.project, spendUsd: num(r.spend),
        requests: num(r.requests), activeUsers: num(r.users),
      })) satisfies ProjectRow[];
    },
```

Add `ProjectRow` to the type import at the top of the file.

- [ ] **Step 6: Add the panel type**

In `src/metrics/types.ts`, beside `ClientToolAdoption`:

```ts
export type ProjectAdoption = {
  projectLabel: string;
  spendReporting: number;
  requests: number;
  /** null when the headcount is below minN — see the G4 note in Task 2 of the plan. */
  activePeople: number | null;
  shareOfSpendPct: number;
};
```

and add `projects: ProjectAdoption[];` to `AdoptionPanel`.

- [ ] **Step 7: Write the failing builder test**

Create `tests/metrics/projects.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildProjects } from "../../src/metrics/projects";

const rows = [
  { project: "fingerhaus", spendUsd: 800, requests: 4000, activeUsers: 9 },
  { project: "solo-thing", spendUsd: 200, requests: 500, activeUsers: 2 },
];

describe("buildProjects", () => {
  it("converts spend and computes share", () => {
    const out = buildProjects(rows, { fxRateUsdToReporting: 0.5, minN: 5 });
    expect(out[0]!.projectLabel).toBe("fingerhaus");
    expect(out[0]!.spendReporting).toBeCloseTo(400, 6);
    expect(out[0]!.shareOfSpendPct).toBeCloseTo(80, 6);
  });

  it("shows the headcount at or above minN", () => {
    const out = buildProjects(rows, { fxRateUsdToReporting: 1, minN: 5 });
    expect(out.find((p) => p.projectLabel === "fingerhaus")!.activePeople).toBe(9);
  });

  it("suppresses the headcount below minN but keeps spend visible", () => {
    // G4: what a client project cost is a business fact; who worked on it is not.
    const out = buildProjects(rows, { fxRateUsdToReporting: 1, minN: 5 });
    const solo = out.find((p) => p.projectLabel === "solo-thing")!;
    expect(solo.activePeople).toBeNull();
    expect(solo.spendReporting).toBeCloseTo(200, 6);
    expect(solo.requests).toBe(500);
  });

  it("does not roll small projects into Other", () => {
    const out = buildProjects(rows, { fxRateUsdToReporting: 1, minN: 5 });
    expect(out.map((p) => p.projectLabel)).toEqual(["fingerhaus", "solo-thing"]);
  });

  it("returns an empty array and no NaN when there is no project spend", () => {
    expect(buildProjects([], { fxRateUsdToReporting: 1, minN: 5 })).toEqual([]);
  });
});
```

- [ ] **Step 8: Run it to confirm it fails**

Run: `pnpm vitest run tests/metrics/projects.test.ts`
Expected: FAIL — cannot find module `../../src/metrics/projects`

- [ ] **Step 9: Implement `src/metrics/projects.ts`**

```ts
import type { ProjectRow } from "../litellm/types";
import type { ProjectAdoption } from "./types";

export type ProjectOptions = { fxRateUsdToReporting: number; minN: number };

/**
 * Projects are NOT rolled into "Other" the way teams are — with ~39 projects across 45
 * people almost every row would vanish and the panel would say nothing. Instead the
 * person-identifying column is the one suppressed: spend and requests are always shown,
 * the headcount only at or above minN. See the G4 note in the plan.
 */
export function buildProjects(
  rows: ProjectRow[], opts: ProjectOptions,
): ProjectAdoption[] {
  const total = rows.reduce((s, r) => s + r.spendUsd, 0);
  return rows.map((r) => ({
    projectLabel: r.project,
    spendReporting: r.spendUsd * opts.fxRateUsdToReporting,
    requests: r.requests,
    activePeople: r.activeUsers >= opts.minN ? r.activeUsers : null,
    shareOfSpendPct: total > 0 ? (r.spendUsd / total) * 100 : 0,
  }));
}
```

- [ ] **Step 10: Wire it into the adoption panel**

In `src/metrics/adoption.ts`, add the import, fetch the rows alongside the existing calls,
and include the result in the returned object:

```ts
import { buildProjects } from "./projects";
```

```ts
  const projectRows = await src.projects(opts.fromIso, opts.toIso);
```

```ts
    projects: buildProjects(projectRows, {
      fxRateUsdToReporting: opts.fxRateUsdToReporting, minN: opts.minN,
    }),
```

- [ ] **Step 11: Update the snapshot fixture**

In `tests/fixtures/snapshot.ts`, add to the `adoption` object:

```ts
      projects: [
        { projectLabel: "fingerhaus", spendReporting: 843.67, requests: 4594,
          activePeople: 7, shareOfSpendPct: 21.7 },
        { projectLabel: "ausschreibungs-agent", spendReporting: 518.73, requests: 6737,
          activePeople: null, shareOfSpendPct: 13.3 },
      ],
```

The second row deliberately has a suppressed headcount so the renderer's `<5` path is
exercised by the HTML tests in Task 5.

- [ ] **Step 12: Run the full suite**

Run: `docker compose -f docker-compose.test.yml up -d && pnpm vitest run && pnpm tsc --noEmit`
Expected: all pass, typecheck clean. Task 1's `summarise` now compiles.

- [ ] **Step 13: Commit**

```bash
git add -A && git commit -m "feat: project dimension with headcount suppression below min-n"
```

---

## Task 3: Delta rendering — and the Evidence-Lock trap in it

**Files:**
- Create: `src/report/delta.ts`
- Test: `tests/report/delta.test.ts`

**Interfaces:**
- Consumes: `NumberRegistry` from `src/report/registry.ts`
- Produces: `deltaLabel(n: NumberRegistry, now: number, before: number | null | undefined): string`, `DELTA_NONE`

### Read this before writing any code

The obvious implementation — `` `${d >= 0 ? "+" : "-"}${n.pct(Math.abs(d))}%` `` — **breaks
Evidence-Lock**, and in a way that will waste an hour if you discover it by trial.

Evidence-Lock's tokeniser is `/-?\d[\d,]*(?:\.\d+)?/g`. It captures a leading ASCII hyphen.
So `-18.2` in the output tokenises as `"-18.2"`, while the registry recorded `"18.2"` from
`n.pct(18.2)`. The token is not in the allowed set and the report fails to build.

This is the same class of bug that was already found and fixed once in Phase 1, in the
opposite direction. Do not reintroduce it.

**The fix is to use arrow glyphs, not signs.** `▲` and `▼` contain no digits, so the
tokeniser ignores them entirely and only the registered magnitude appears as a token. It
also reads better in an email than `+`/`-`.

- [ ] **Step 1: Write the failing test**

Create `tests/report/delta.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { NumberRegistry } from "../../src/report/registry";
import { assertEvidenceLock } from "../../src/report/evidence-lock";
import { deltaLabel, DELTA_NONE } from "../../src/report/delta";

const reg = () => new NumberRegistry("EUR");

describe("deltaLabel", () => {
  it("marks an increase with an up arrow", () => {
    expect(deltaLabel(reg(), 120, 100)).toBe("▲ 20.0%");
  });

  it("marks a decrease with a down arrow and no minus sign", () => {
    const out = deltaLabel(reg(), 80, 100);
    expect(out).toBe("▼ 20.0%");
    expect(out).not.toContain("-");
  });

  it("reports no baseline when the prior value is absent", () => {
    expect(deltaLabel(reg(), 120, null)).toBe(DELTA_NONE);
    expect(deltaLabel(reg(), 120, undefined)).toBe(DELTA_NONE);
  });

  it("calls a new line item new rather than an infinite increase", () => {
    expect(deltaLabel(reg(), 120, 0)).toBe("new");
  });

  it("treats an unchanged value as flat", () => {
    expect(deltaLabel(reg(), 100, 100)).toBe("unchanged");
  });

  it("survives Evidence-Lock in both directions", () => {
    const n = reg();
    const up = deltaLabel(n, 120, 100);
    const down = deltaLabel(n, 80, 100);
    expect(() => assertEvidenceLock(`<p>${up} and ${down}</p>`, n)).not.toThrow();
  });

  it("an ASCII-signed delta would NOT survive the lock", () => {
    // Documents why arrows are used. If this test ever starts passing, the
    // tokeniser changed and the arrow convention can be revisited.
    const n = reg();
    const bad = `-${n.pct(20)}`;
    expect(() => assertEvidenceLock(`<p>${bad}%</p>`, n)).toThrow();
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `pnpm vitest run tests/report/delta.test.ts`
Expected: FAIL — cannot find module `../../src/report/delta`

- [ ] **Step 3: Implement `src/report/delta.ts`**

```ts
import type { NumberRegistry } from "./registry";

/** Shown when there is no prior month to compare against. Contains no digits. */
export const DELTA_NONE = "–";

/**
 * Renders a month-over-month change.
 *
 * Arrows rather than +/- signs, deliberately: Evidence-Lock's tokeniser captures a leading
 * ASCII hyphen, so "-20.0" would be looked up as one token while the registry recorded
 * "20.0" — and the report would fail to build. "▲"/"▼" carry no digits, so only the
 * registered magnitude is ever tokenised.
 */
export function deltaLabel(
  n: NumberRegistry, now: number, before: number | null | undefined,
): string {
  if (before === null || before === undefined) return DELTA_NONE;
  if (before === 0) return now === 0 ? "unchanged" : "new";
  if (now === before) return "unchanged";
  const pct = ((now - before) / Math.abs(before)) * 100;
  return `${pct > 0 ? "▲" : "▼"} ${n.pct(Math.abs(pct))}%`;
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run tests/report/delta.test.ts`
Expected: 7 passed

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: month-over-month delta labels using arrows not signs"
```

---

## Task 4: CSS bar charts that survive a mail client

**Files:**
- Create: `src/report/chart.ts`
- Test: `tests/report/chart.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `barTrack(pct: number, colour?: string): string`, `barRow(cells: {label: string; bar: string; value: string}): string`, `CHART_INK`, `CHART_TRACK`

### Why CSS bars and not something better-looking

Gmail strips `<svg>` entirely. Images need CID attachments, which means generating PNGs and
inflating the message. A `<div>` with a background colour and a percentage width renders in
Gmail, Outlook, Apple Mail and everything else, needs no assets, and costs nothing.

Evidence-Lock interaction: the percentage lives in a `style` attribute, and `visibleText`
strips attributes before tokenising — verified during the Phase 1 adversarial probe. So bar
widths do **not** need registering. Every *visible* label still does.

- [ ] **Step 1: Write the failing test**

Create `tests/report/chart.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { NumberRegistry } from "../../src/report/registry";
import { assertEvidenceLock, visibleText } from "../../src/report/evidence-lock";
import { barTrack, barRow } from "../../src/report/chart";

describe("barTrack", () => {
  it("renders a filled width as a percentage", () => {
    expect(barTrack(59.3)).toContain("width:59.3%");
  });

  it("clamps out-of-range values", () => {
    expect(barTrack(140)).toContain("width:100%");
    expect(barTrack(-5)).toContain("width:0%");
  });

  it("emits no <svg> and no <img> — both fail in mail clients", () => {
    const out = barTrack(50);
    expect(out).not.toContain("<svg");
    expect(out).not.toContain("<img");
  });

  it("its width never reaches Evidence-Lock, because it lives in an attribute", () => {
    const n = new NumberRegistry("EUR");
    // 59.3 is never registered, yet the lock must not trip on it.
    expect(() => assertEvidenceLock(`<div>${barTrack(59.3)}</div>`, n)).not.toThrow();
    expect(visibleText(barTrack(59.3))).not.toContain("59.3");
  });
});

describe("barRow", () => {
  it("lays out label, bar and value as one table row", () => {
    const out = barRow({ label: "claude-cli", bar: barTrack(89), value: "EUR 3,777.33" });
    expect(out.startsWith("<tr>")).toBe(true);
    expect(out).toContain("claude-cli");
    expect(out).toContain("EUR 3,777.33");
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `pnpm vitest run tests/report/chart.test.ts`
Expected: FAIL — cannot find module `../../src/report/chart`

- [ ] **Step 3: Implement `src/report/chart.ts`**

```ts
/** Brand ink and track colours. Kept here so the palette is in one place. */
export const CHART_INK = "#0f3b3f";
export const CHART_TRACK = "#e3e8e8";

const clamp = (n: number) => (Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : 0);

/**
 * A horizontal bar as nested divs. No SVG (Gmail strips it) and no images (CID
 * attachments bloat the message). The width sits in a style attribute, which
 * `visibleText` strips before Evidence-Lock tokenises, so it needs no registration.
 */
export function barTrack(pct: number, colour: string = CHART_INK): string {
  const w = clamp(pct);
  return (
    `<div style="background:${CHART_TRACK};border-radius:3px;height:10px;width:100%">` +
    `<div style="background:${colour};width:${w}%;height:10px;border-radius:3px"></div>` +
    `</div>`
  );
}

/** One label / bar / value row. Tables, not flexbox — Outlook does not do flexbox. */
export function barRow(cells: { label: string; bar: string; value: string }): string {
  return (
    `<tr>` +
    `<td style="padding:3px 8px 3px 0;font-size:13px;white-space:nowrap">${cells.label}</td>` +
    `<td style="padding:3px 8px;width:55%">${cells.bar}</td>` +
    `<td style="padding:3px 0;font-size:13px;text-align:right;white-space:nowrap">${cells.value}</td>` +
    `</tr>`
  );
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run tests/report/chart.test.ts`
Expected: 6 passed

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: css bar chart helpers for email-safe charts"
```

---

## Task 5: Rebuild the report around the story

The current template opens with the headline and then becomes six tables. This task keeps
every existing figure but reorders and re-renders so the report reads as: **what changed →
is adoption real → what it was spent on → what to act on.**

**Files:**
- Modify: `src/report/html.ts`
- Test: `tests/report/html.test.ts`

**Interfaces:**
- Consumes: `deltaLabel`/`DELTA_NONE` (Task 3), `barTrack`/`barRow` (Task 4), `Snapshot.previous`/`history`/`adoption.projects` (Tasks 1–2)
- Produces: no new exports — `renderHtml(snapshot)` is unchanged in signature

- [ ] **Step 1: Write the failing tests**

Add to `tests/report/html.test.ts`:

```ts
describe("renderHtml — storytelling layer", () => {
  const withPrev = () => {
    const s = makeSnapshotFixture();
    s.previous = {
      month: "2026-06", spendReporting: 4000, activePeople: 32, costInHours: 28.6,
      breakEvenMinutesPerPerson: 53.6, medianActiveDays: 5, apiRequests: 50000,
      failureRatePct: 6.1, attributionCoveragePct: 99.0,
      spendByTeam: { Engineering: 3000 }, spendByProject: { fingerhaus: 500 },
      spendByTool: { "claude-cli": 3000 },
    };
    s.history = [
      { month: "2026-05", spendReporting: 1700, activePeople: 20 },
      { month: "2026-06", spendReporting: 4000, activePeople: 32 },
    ];
    return s;
  };

  it("states the movement on the headline figures", () => {
    const t = visibleText(renderHtml(withPrev()));
    expect(t).toMatch(/▲|▼/);
    expect(t).toContain("2026-06");
  });

  it("renders bars rather than only tables", () => {
    const html = renderHtml(withPrev());
    expect((html.match(/border-radius:3px/g) ?? []).length).toBeGreaterThan(3);
  });

  it("shows the project section with client-recognisable labels", () => {
    const t = visibleText(renderHtml(withPrev()));
    expect(t).toContain("fingerhaus");
    expect(t).toContain("ausschreibungs-agent");
  });

  it("shows <5 rather than a number for a suppressed project headcount", () => {
    const t = visibleText(renderHtml(withPrev()));
    expect(t).toContain("<5");
  });

  it("degrades to no-baseline markers on the very first report", () => {
    const s = makeSnapshotFixture();   // previous: null, history: []
    const t = visibleText(renderHtml(s));
    expect(t).toContain("–");
    expect(t).not.toMatch(/▲|▼/);
  });

  it("still passes its own Evidence-Lock with deltas and charts present", () => {
    expect(() => renderHtml(withPrev())).not.toThrow();
  });

  it("still names no individual", () => {
    expect(renderHtml(withPrev())).not.toMatch(/user_id_/);
  });
});
```

- [ ] **Step 2: Run them to confirm they fail**

Run: `pnpm vitest run tests/report/html.test.ts`
Expected: FAIL — no arrows, no project labels, no `<5`

- [ ] **Step 3: Import the new helpers**

At the top of `src/report/html.ts`:

```ts
import { deltaLabel, DELTA_NONE } from "./delta";
import { barTrack, barRow } from "./chart";
```

- [ ] **Step 4: Add a delta helper bound to the snapshot**

Inside `renderHtml`, after `const cur = ...`:

```ts
  const prev = s.previous;
  /** Delta against last month, or the no-baseline marker. */
  const d = (now: number, before: number | null | undefined) => deltaLabel(n, now, before);
  const prevLabel = prev ? re(n, prev.month) : DELTA_NONE;
```

- [ ] **Step 5: Add movement to the headline block**

In the `.bar` div, immediately after the existing `Coverage:` paragraph, add:

```html
  <p class="muted">Versus ${prevLabel}:
     spend ${d(s.bar.spendReporting, prev?.spendReporting)} ·
     people ${d(s.bar.activePeople, prev?.activePeople)} ·
     break-even ${d(s.bar.breakEvenMinutesPerPerson, prev?.breakEvenMinutesPerPerson)}</p>
```

- [ ] **Step 6: Add the spend trend chart**

Build the rows before the template, after the existing `const tools = ...`:

```ts
  const trendMax = Math.max(
    ...s.history.map((h) => h.spendReporting), s.bar.spendReporting, 1,
  );
  const trend = [...s.history, {
    month: s.month, spendReporting: s.bar.spendReporting, activePeople: s.bar.activePeople,
  }]
    .map((h) => barRow({
      label: re(n, h.month),
      bar: barTrack((h.spendReporting / trendMax) * 100),
      value: `${cur} ${n.currency(h.spendReporting)}`,
    }))
    .join("");
```

and render it as the first section after the headline:

```html
<h2>Spend over time</h2>
<table>${trend}</table>
```

- [ ] **Step 7: Turn retention into bars**

Replace the retention `<table>` in the Adoption section with a bar chart. Keep the existing
`retention` table variable in place for now and add beneath it:

```ts
  const retentionBars = s.adoption.retention
    .filter((c) => c.points.length > 0)
    .flatMap((c) => c.points.map((p) => barRow({
      label: `${re(n, c.cohortMonth)} → M+${n.int(p.monthOffset)}`,
      bar: barTrack(p.pct),
      value: `${n.pct(p.pct)}% of ${n.int(c.cohortSize)}`,
    })))
    .join("");
```

and in the template, directly after the existing retention table:

```html
<table>${retentionBars}</table>
```

- [ ] **Step 8: Add the project section**

Build the rows:

```ts
  const projectMax = Math.max(...s.adoption.projects.map((p) => p.spendReporting), 1);
  const projects = s.adoption.projects.length === 0
    ? `<p class="muted">No project-tagged spend this month.</p>`
    : `<table>` + s.adoption.projects.slice(0, 12).map((p) => barRow({
        label: re(n, p.projectLabel),
        bar: barTrack((p.spendReporting / projectMax) * 100),
        value: `${cur} ${n.currency(p.spendReporting)} · ` +
               `${p.activePeople === null ? "&lt;" + n.int(s.minN) : n.int(p.activePeople)} people · ` +
               `${d(p.spendReporting, prev?.spendByProject[p.projectLabel])}`,
      })).join("") + `</table>`;
```

and place it as its own section immediately after Adoption:

```html
<h2>Where it went — by project</h2>
<p class="muted">Projects carrying fewer than ${n.int(s.minN)} active people show a
   headcount range rather than a number; what a project cost is a business fact, who
   worked on it is not.</p>
${projects}
```

Note `&lt;` rather than a literal `<` — the label is interpolated into HTML, and a bare
`<5` would open a phantom tag.

- [ ] **Step 9: Add deltas to the team and tool rows**

In the existing `teams` map, append to the row a cell containing
`${d(t.spendReporting, prev?.spendByTeam[t.teamLabel])}`, and add a `<th>vs prev</th>` to
that table's header. Do the same for `tools` using `prev?.spendByTool[t.tool]`.

- [ ] **Step 10: Add movement to the reliability sentence**

After the existing requests/failure sentence, add:

```html
<p class="muted">Requests ${d(s.reliability.apiRequests, prev?.apiRequests)} ·
   failure rate ${d(s.reliability.failureRatePct, prev?.failureRatePct)} versus ${prevLabel}.</p>
```

- [ ] **Step 11: Run the tests**

Run: `pnpm vitest run tests/report/html.test.ts`
Expected: all pass, including the seven new ones

- [ ] **Step 12: Render against production and look at it**

```bash
docker start ll-probe
```

Then render a real report and open it, exactly as UAT Stage A did — build a snapshot from
`postgres://probe:probe@localhost:55441/litellm` for `2026-07`, pass a `PriorContext` loaded
from the `value_ledger` database (June is already frozen there), render, and write the HTML
to a file. Open it in a browser and confirm: the arrows appear, the bars have sensible
lengths, the project section lists recognisable client names, and nothing is visually broken.

If Evidence-Lock throws here but the unit tests passed, the cause is almost certainly a
data-derived label in the new project section that skipped `re()`.

- [ ] **Step 13: Commit**

```bash
git add -A && git commit -m "feat: narrative report with deltas, charts and project section"
```

---

## Task 6: Carry the new dimensions into the CSV

The CSV is both the machine-readable copy and the export used for splitting client-billable
spend, so the project dimension matters here more than anywhere.

**Files:**
- Modify: `src/report/csv.ts`
- Test: `tests/report/csv.test.ts`

**Interfaces:**
- Consumes: `Snapshot.adoption.projects`, `Snapshot.previous`, `Snapshot.history`
- Produces: no new exports

- [ ] **Step 1: Write the failing tests**

Add to `tests/report/csv.test.ts`:

```ts
it("emits one row per project", () => {
  const csv = renderCsv(makeSnapshotFixture());
  expect(csv).toContain("adoption,project_spend_reporting,fingerhaus,843.67");
  expect(csv).toContain("adoption,project_requests,fingerhaus,4594");
});

it("emits an empty value for a suppressed project headcount", () => {
  // null must not serialise as "null" — it is a suppression, not a zero.
  const csv = renderCsv(makeSnapshotFixture());
  const line = csv.split("\n")
    .find((l) => l.startsWith("adoption,project_active_people,ausschreibungs-agent"))!;
  expect(line).toBe("adoption,project_active_people,ausschreibungs-agent,");
});

it("emits the trend history", () => {
  const s = makeSnapshotFixture();
  s.history = [{ month: "2026-06", spendReporting: 4000, activePeople: 32 }];
  const csv = renderCsv(s);
  expect(csv).toContain("history,spend_reporting,2026-06,4000");
});

it("emits the prior-month baseline when present", () => {
  const s = makeSnapshotFixture();
  s.previous = {
    month: "2026-06", spendReporting: 4000, activePeople: 32, costInHours: 28.6,
    breakEvenMinutesPerPerson: 53.6, medianActiveDays: 5, apiRequests: 50000,
    failureRatePct: 6.1, attributionCoveragePct: 99.0,
    spendByTeam: {}, spendByProject: {}, spendByTool: {},
  };
  expect(renderCsv(s)).toContain("previous,spend_reporting,2026-06,4000");
});

it("omits previous rows entirely on the first report", () => {
  expect(renderCsv(makeSnapshotFixture())).not.toContain("previous,");
});
```

- [ ] **Step 2: Run them to confirm they fail**

Run: `pnpm vitest run tests/report/csv.test.ts`
Expected: FAIL — the project, history and previous rows are absent

- [ ] **Step 3: Implement**

In `src/report/csv.ts`, widen the row value type to allow an empty cell:

```ts
type Row = [section: string, metric: string, dimension: string, value: number | string];
```

(it already is — no change needed if so). Then, after the existing model-mix loop, add:

```ts
  for (const p of s.adoption.projects) {
    rows.push(["adoption", "project_spend_reporting", p.projectLabel, p.spendReporting]);
    rows.push(["adoption", "project_requests", p.projectLabel, p.requests]);
    // Empty, not "null": the headcount is suppressed, not zero.
    rows.push(["adoption", "project_active_people", p.projectLabel,
      p.activePeople === null ? "" : p.activePeople]);
  }
  for (const h of s.history) {
    rows.push(["history", "spend_reporting", h.month, h.spendReporting]);
    rows.push(["history", "active_people", h.month, h.activePeople]);
  }
  if (s.previous) {
    const p = s.previous;
    rows.push(["previous", "spend_reporting", p.month, p.spendReporting]);
    rows.push(["previous", "active_people", p.month, p.activePeople]);
    rows.push(["previous", "api_requests", p.month, p.apiRequests]);
    rows.push(["previous", "failure_rate_pct", p.month, p.failureRatePct]);
  }
```

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run tests/report/csv.test.ts`
Expected: all pass

- [ ] **Step 5: Run the whole suite and typecheck**

Run: `pnpm vitest run && pnpm tsc --noEmit`
Expected: all pass, typecheck clean

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat: project, history and baseline rows in the csv export"
```

---

## Self-review notes

**Driver coverage.** Deltas → Tasks 1, 3, 5, 6. Project split → Tasks 2, 5, 6. Charts →
Tasks 4, 5. All three of Daniel's complaints have tasks.

**Constraint coverage.** G3: the baseline is copied into the snapshot at build time, so a
frozen report's deltas are frozen (Task 1). G4: projects suppress the headcount rather than
the row, with the reasoning stated where an implementer will read it (Task 2). G5: Task 3
opens with the trap and Task 4 explains why bar widths are exempt. G8: `spendUsd` stays in
the source layer, `spendReporting` in panels (Task 2).

**Deliberately not done.** Per-user figures (Daniel reaffirmed C2). The no-LLM tool
co-occurrence clustering (deprioritised in favour of Phase 3). The Phase 2 dashboard.

**Known interface change.** `buildSnapshot` gains a fifth parameter with a default, so
existing callers and tests compile unchanged; only `runMonthlyJob` passes it (Task 1).

**Cross-task ordering.** Task 1's `summarise` references `adoption.projects` from Task 2.
Execute Task 2 first, or accept one transient typecheck error between the two. Task 1 Step 8
says so explicitly.
