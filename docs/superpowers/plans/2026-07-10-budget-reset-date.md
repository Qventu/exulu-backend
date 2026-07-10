# Budget Reset Date Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a budget's reset date an explicit, editable field with a standardized smart default, so changing a duration (e.g. weekly→monthly) moves the reset date immediately and correctly.

**Architecture:** The frontend budget editor gains a date picker prefilled with a standardized default (next Monday / 1st of next month / next midnight, computed at UTC boundaries) that the admin can override. The chosen `budget_reset_at` flows through the existing `/admin/budgets` REST endpoints into `upsertBudget`, which — because LiteLLM's tag endpoints silently strip the field — applies it via a dedicated follow-up call to LiteLLM's `/budget/update` using the tag's resolved `budget_id`.

**Tech Stack:** Backend TypeScript (Express, ts-jest); frontend Next.js/React + TypeScript (vitest), shadcn `Popover`+`Calendar` (react-day-picker v9), `date-fns`, `next-intl`.

## Global Constraints

- Backend budget durations are the string set `"1d" | "7d" | "30d"` (`BudgetDuration`); `BUDGET_ALLOWED_DURATIONS` already gates them in `routes.ts`.
- LiteLLM's tag endpoints (`/tag/new`, `/tag/update`) **cannot** carry `budget_reset_at` — it is filtered out by `handle_budget_for_entity`. The reset date MUST be written via `/budget/update` with a `budget_id`.
- Reset dates are computed/normalized at **UTC** day boundaries so the monthly default lands on the 1st in UTC, keeping `windowStartYmd`'s `getUTCDate() === 1` calendar-month heuristic valid.
- Change is additive: an omitted `budget_reset_at` preserves today's behavior (no `/budget/update` call).
- `BudgetEditor`'s prop API stays additive — internal state only, no prop renames (component contract in its file header).
- All new UI copy is i18n'd under the `budgets.editor.*` namespace, with German translations in `messages/de.json`.
- Do not modify anything under `ee/python/.venv/` (vendored LiteLLM).

---

### Task 1: Backend admin-client — expose `budget_id` and add `budgetUpdate`

**Files:**
- Modify: `src/exulu/litellm/admin-client.ts`
- Test: `src/exulu/litellm/admin-client.test.ts` (create)

**Interfaces:**
- Consumes: `litellmBase()`, `LiteLLMAdminError` from `./env`.
- Produces:
  - `type TagBudgetInput = { name: string; max_budget: number; budget_duration: BudgetDuration | string; budget_reset_at?: string }`
  - `type TagInfo = { name; spend; max_budget; budget_duration; budget_reset_at; budget_id: string | null }`
  - `budgetUpdate(budget_id: string, patch: { budget_reset_at?: string }): Promise<void>` → `POST /budget/update`

- [ ] **Step 1: Write the failing test**

Create `src/exulu/litellm/admin-client.test.ts`:

```typescript
const OK = (body: unknown) =>
  Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body), text: () => Promise.resolve("") } as Response);

describe("admin-client", () => {
  const origFetch = global.fetch;
  beforeAll(() => { process.env.LITELLM_MASTER_KEY = "test-key"; });
  afterEach(() => { global.fetch = origFetch; jest.resetModules(); });

  it("tagInfo surfaces budget_id from litellm_budget_table", async () => {
    global.fetch = jest.fn(() =>
      OK({ "team_id_5": { litellm_budget_table: { budget_id: "bud_123", max_budget: 100, budget_duration: "30d", budget_reset_at: "2026-08-01T00:00:00Z" } } }),
    ) as unknown as typeof fetch;
    const { tagInfo } = await import("./admin-client");
    const info = await tagInfo(["team_id_5"]);
    expect(info["team_id_5"]?.budget_id).toBe("bud_123");
  });

  it("budgetUpdate POSTs budget_id + patch to /budget/update", async () => {
    const spy = jest.fn(() => OK({})) as unknown as typeof fetch;
    global.fetch = spy;
    const { budgetUpdate } = await import("./admin-client");
    await budgetUpdate("bud_123", { budget_reset_at: "2026-08-01T00:00:00.000Z" });
    const [url, init] = (spy as unknown as jest.Mock).mock.calls[0];
    expect(String(url)).toContain("/budget/update");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      budget_id: "bud_123",
      budget_reset_at: "2026-08-01T00:00:00.000Z",
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/exulu/litellm/admin-client.test.ts`
Expected: FAIL — `budgetUpdate` is not exported / `budget_id` is undefined.

- [ ] **Step 3: Implement**

In `src/exulu/litellm/admin-client.ts`:

Add `budget_reset_at` to `TagBudgetInput`:

```typescript
export type TagBudgetInput = {
  name: string;
  max_budget: number;
  budget_duration: BudgetDuration | string;
  budget_reset_at?: string;
};
```

Add `budget_id` to `TagInfo`:

```typescript
export type TagInfo = {
  name: string;
  spend: number;
  max_budget: number | null;
  budget_duration: string | null;
  budget_reset_at: string | null;
  budget_id: string | null;
};
```

In `extractBudget`, pull and return `budget_id` (add to the return type and object):

```typescript
function extractBudget(raw: any): {
  max_budget: number | null;
  budget_duration: string | null;
  budget_reset_at: string | null;
  budget_id: string | null;
  spend: number;
} {
  const bt = raw?.litellm_budget_table ?? {};
  const max_budget = bt.max_budget ?? raw?.max_budget ?? null;
  const budget_duration = bt.budget_duration ?? raw?.budget_duration ?? null;
  const budget_reset_at = bt.budget_reset_at ?? raw?.budget_reset_at ?? null;
  const budget_id = bt.budget_id ?? raw?.budget_id ?? null;
  const spend =
    typeof raw?.spend === "number"
      ? raw.spend
      : typeof bt.spend === "number"
        ? bt.spend
        : 0;
  return { max_budget, budget_duration, budget_reset_at, budget_id, spend };
}
```

In `listTagBudgets` and `tagInfo`, add `budget_id: b.budget_id` to every `TagInfo` object they build (three build sites — the `map[name] = {…}` in `listTagBudgets` and the two `out[name] = {…}` in `tagInfo`). Example for one site:

```typescript
      map[name] = {
        name,
        spend: b.spend,
        max_budget: b.max_budget,
        budget_duration: b.budget_duration,
        budget_reset_at: b.budget_reset_at,
        budget_id: b.budget_id,
      };
```

Add `budgetUpdate` next to `tagUpdate`:

```typescript
/**
 * Set fields on a budget row directly via LiteLLM's /budget/update. Used for
 * budget_reset_at, which the /tag/* endpoints silently strip (they filter to
 * LiteLLM_BudgetTable.model_fields, which omits budget_reset_at). Requires the
 * budget_id — read it from tagInfo(...).budget_id.
 */
export async function budgetUpdate(
  budget_id: string,
  patch: { budget_reset_at?: string },
): Promise<void> {
  await call("/budget/update", { budget_id, ...patch });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/exulu/litellm/admin-client.test.ts`
Expected: PASS (2 passing).

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors (every `TagInfo` literal now includes `budget_id`).

- [ ] **Step 6: Commit**

```bash
git add src/exulu/litellm/admin-client.ts src/exulu/litellm/admin-client.test.ts
git commit -m "feat(budgets): expose budget_id + add budgetUpdate for reset date"
```

---

### Task 2: Backend budget-service — apply reset date in `upsertBudget`

**Files:**
- Modify: `src/exulu/litellm/budget-service.ts`
- Test: `src/exulu/litellm/budget-service.test.ts` (create)

**Interfaces:**
- Consumes: `tagInfo`, `tagNew`, `tagUpdate`, `budgetUpdate` (Task 1) from `./admin-client`.
- Produces:
  - `upsertBudget(tag: string, max_budget: number, budget_duration: BudgetDuration | string, budget_reset_at?: string): Promise<void>`
  - `parseResetAt(raw: unknown): { valid: boolean; value?: string }` — validates an optional ISO date; `{ valid: true, value: undefined }` when absent, `{ valid: true, value: <ISO> }` when a parseable date, `{ valid: false }` otherwise.

- [ ] **Step 1: Write the failing test**

Create `src/exulu/litellm/budget-service.test.ts`:

```typescript
jest.mock("@SRC/postgres/client", () => ({ postgresClient: jest.fn() }));
jest.mock("./activity-client", () => ({ getTagSpendByWindow: jest.fn() }));
jest.mock("./admin-client", () => ({
  tagInfo: jest.fn(),
  tagNew: jest.fn(),
  tagUpdate: jest.fn(),
  budgetUpdate: jest.fn(),
  listTagBudgets: jest.fn(),
}));

import { tagInfo, tagNew, tagUpdate, budgetUpdate } from "./admin-client";
import { upsertBudget, parseResetAt, __resetBudgetCachesForTesting } from "./budget-service";

const asMock = (fn: unknown) => fn as jest.Mock;

describe("upsertBudget reset date", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    __resetBudgetCachesForTesting();
  });

  it("applies budget_reset_at via budgetUpdate using the resolved budget_id", async () => {
    // pre-write existence check → exists; post-write read → budget_id
    asMock(tagInfo)
      .mockResolvedValueOnce({ "team_id_5": { max_budget: 10 } })
      .mockResolvedValueOnce({ "team_id_5": { budget_id: "bud_9" } });
    await upsertBudget("team_id_5", 300, "30d", "2026-08-01T00:00:00.000Z");
    expect(tagUpdate).toHaveBeenCalledWith({ name: "team_id_5", max_budget: 300, budget_duration: "30d" });
    expect(budgetUpdate).toHaveBeenCalledWith("bud_9", { budget_reset_at: "2026-08-01T00:00:00.000Z" });
  });

  it("does not call budgetUpdate when no reset date is given", async () => {
    asMock(tagInfo).mockResolvedValueOnce({ "team_id_5": { max_budget: 10 } });
    await upsertBudget("team_id_5", 300, "30d");
    expect(budgetUpdate).not.toHaveBeenCalled();
  });

  it("parseResetAt validates ISO dates", () => {
    expect(parseResetAt(undefined)).toEqual({ valid: true, value: undefined });
    expect(parseResetAt(null)).toEqual({ valid: true, value: undefined });
    expect(parseResetAt("2026-08-01T00:00:00.000Z")).toEqual({ valid: true, value: "2026-08-01T00:00:00.000Z" });
    expect(parseResetAt("not-a-date")).toEqual({ valid: false });
    expect(parseResetAt(12345)).toEqual({ valid: false });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/exulu/litellm/budget-service.test.ts`
Expected: FAIL — `parseResetAt` not exported; `budgetUpdate` not called.

- [ ] **Step 3: Implement**

In `src/exulu/litellm/budget-service.ts`, add `budgetUpdate` to the `./admin-client` import:

```typescript
import {
  listTagBudgets,
  tagInfo,
  tagNew,
  tagUpdate,
  budgetUpdate,
  type BudgetDuration,
  type TagInfo,
} from "./admin-client";
```

Add the pure validator (near the other top-level helpers):

```typescript
/**
 * Validate an optional budget_reset_at from an untrusted request body. Absent
 * (undefined/null) is valid and means "leave the reset date to LiteLLM". A
 * parseable date string is normalised to an ISO string. Anything else is
 * invalid so the route can 400 before touching LiteLLM.
 */
export function parseResetAt(raw: unknown): { valid: boolean; value?: string } {
  if (raw === undefined || raw === null || raw === "") {
    return { valid: true, value: undefined };
  }
  if (typeof raw !== "string") return { valid: false };
  const t = Date.parse(raw);
  if (Number.isNaN(t)) return { valid: false };
  return { valid: true, value: new Date(t).toISOString() };
}
```

Replace `upsertBudget` with the reset-date-aware version:

```typescript
export async function upsertBudget(
  tag: string,
  max_budget: number,
  budget_duration: BudgetDuration | string,
  budget_reset_at?: string,
): Promise<void> {
  const info = await tagInfo([tag]);
  try {
    if (info[tag]) {
      await tagUpdate({ name: tag, max_budget, budget_duration });
    } else {
      await tagNew({ name: tag, max_budget, budget_duration });
    }
  } catch {
    // Fallback: flip the operation in case the existence check raced.
    if (info[tag]) {
      await tagNew({ name: tag, max_budget, budget_duration });
    } else {
      await tagUpdate({ name: tag, max_budget, budget_duration });
    }
  }

  // The /tag/* endpoints strip budget_reset_at, so apply it directly on the
  // budget row via /budget/update. Re-read the tag to get the (possibly newly
  // created) budget_id. A failure here surfaces to the caller so the admin
  // retries rather than silently keeping a stale reset date.
  if (budget_reset_at) {
    const after = await tagInfo([tag]);
    const budgetId = after[tag]?.budget_id ?? null;
    if (budgetId) {
      await budgetUpdate(budgetId, { budget_reset_at });
    } else {
      console.warn(`[EXULU] upsertBudget: no budget_id for ${tag}; reset date not applied`);
    }
  }

  invalidateBudgetCaches(tag);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/exulu/litellm/budget-service.test.ts`
Expected: PASS (3 passing).

- [ ] **Step 5: Commit**

```bash
git add src/exulu/litellm/budget-service.ts src/exulu/litellm/budget-service.test.ts
git commit -m "feat(budgets): upsertBudget applies budget_reset_at via /budget/update"
```

---

### Task 3: Backend routes — accept & forward `budget_reset_at`

**Files:**
- Modify: `src/exulu/routes.ts` (`parseBudgetBody` ~2389-2397; single PUT ~2534-2541; bulk PUT ~2489-2505)

**Interfaces:**
- Consumes: `parseResetAt`, `upsertBudget` (Task 2).
- Produces: the two `PUT /admin/budgets/*` endpoints now accept an optional `budget_reset_at` and pass it to `upsertBudget`.

- [ ] **Step 1: Add `parseResetAt` to the budget-service import**

Find the existing `budget-service` import in `routes.ts` and add `parseResetAt` to it (it already imports `upsertBudget`, `getBudgetSettings`, etc.):

```typescript
// add parseResetAt to the existing "../litellm/budget-service" (or equivalent path) import
```

- [ ] **Step 2: Widen `parseBudgetBody` to carry a validated reset date**

Replace `parseBudgetBody` (lines ~2389-2397):

```typescript
  const parseBudgetBody = (
    body: any,
  ): { max_budget: number; budget_duration: BudgetDuration; budget_reset_at?: string } | null => {
    const max_budget = Number(body?.max_budget);
    const budget_duration = String(body?.budget_duration ?? "") as BudgetDuration;
    if (!Number.isFinite(max_budget) || max_budget <= 0) return null;
    if (!BUDGET_ALLOWED_DURATIONS.has(budget_duration)) return null;
    const reset = parseResetAt(body?.budget_reset_at);
    if (!reset.valid) return null;
    return { max_budget, budget_duration, budget_reset_at: reset.value };
  };
```

- [ ] **Step 3: Forward the reset date in the single upsert**

In the single `PUT /admin/budgets/:entityType/:entityId` handler (line ~2541), change the call:

```typescript
        await upsertBudget(tag, body.max_budget, body.budget_duration, body.budget_reset_at);
```

- [ ] **Step 4: Forward the reset date in the bulk upsert**

In the bulk `PUT /admin/budgets/:entityType/bulk` handler (line ~2505), change the call:

```typescript
          await upsertBudget(tag, body.max_budget, body.budget_duration, body.budget_reset_at);
```

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/exulu/routes.ts
git commit -m "feat(budgets): accept budget_reset_at on budget upsert endpoints"
```

---

### Task 4: Frontend — `defaultResetDate` helper

**Files:**
- Modify: `frontend/lib/budget.ts`
- Test: `frontend/lib/budget.test.ts` (create)

**Interfaces:**
- Produces: `defaultResetDate(duration: BudgetDuration, now?: Date): Date` — a Date at a **UTC** day boundary matching LiteLLM's standardized scheme: `1d` → next UTC midnight; `7d` → next Monday UTC midnight; `30d` → 1st of next month UTC midnight.

- [ ] **Step 1: Write the failing test**

Create `frontend/lib/budget.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { defaultResetDate } from "./budget";

// 2026-07-10 is a Friday.
const FRI = new Date("2026-07-10T12:00:00.000Z");

describe("defaultResetDate", () => {
  it("daily → next UTC midnight", () => {
    expect(defaultResetDate("1d", FRI).toISOString()).toBe("2026-07-11T00:00:00.000Z");
  });
  it("weekly → next Monday UTC midnight", () => {
    expect(defaultResetDate("7d", FRI).toISOString()).toBe("2026-07-13T00:00:00.000Z");
  });
  it("monthly → 1st of next month UTC midnight", () => {
    expect(defaultResetDate("30d", FRI).toISOString()).toBe("2026-08-01T00:00:00.000Z");
  });
  it("weekly on a Monday jumps a full week", () => {
    const mon = new Date("2026-07-13T09:00:00.000Z");
    expect(defaultResetDate("7d", mon).toISOString()).toBe("2026-07-20T00:00:00.000Z");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/budget.test.ts`
Expected: FAIL — `defaultResetDate` is not exported.

- [ ] **Step 3: Implement**

Append to `frontend/lib/budget.ts`:

```typescript
/**
 * The standardized reset date a duration defaults to, mirroring LiteLLM's
 * scheme (duration_parser._handle_day_reset): daily → next midnight, weekly →
 * next Monday, monthly → 1st of next month. Computed at UTC day boundaries so
 * the monthly default lands on the 1st in UTC — the backend's window math keys
 * calendar-month alignment off `budget_reset_at.getUTCDate() === 1`.
 */
export function defaultResetDate(duration: BudgetDuration, now: Date = new Date()): Date {
  const y = now.getUTCFullYear();
  const mo = now.getUTCMonth();
  const d = now.getUTCDate();
  if (duration === "30d") {
    return new Date(Date.UTC(y, mo + 1, 1));
  }
  if (duration === "7d") {
    const dow = now.getUTCDay(); // Sun=0 … Sat=6
    const daysUntilMonday = ((1 - dow + 7) % 7) || 7; // next Monday; if Monday, +7
    return new Date(Date.UTC(y, mo, d + daysUntilMonday));
  }
  // "1d" and any fallback → next UTC midnight
  return new Date(Date.UTC(y, mo, d + 1));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/budget.test.ts`
Expected: PASS (4 passing).

- [ ] **Step 5: Commit**

```bash
git add lib/budget.ts lib/budget.test.ts
git commit -m "feat(budgets): add defaultResetDate helper (standardized, UTC)"
```

---

### Task 5: Frontend — thread `budget_reset_at` through the API client

**Files:**
- Modify: `frontend/lib/api/budgets.ts` (`upsert` ~25-36, `bulkUpsert` ~39-50)

**Interfaces:**
- Produces: `budgetsApi.upsert` / `budgetsApi.bulkUpsert` accept `budget_reset_at?: string` in their `input`.

- [ ] **Step 1: Widen the input types**

In `frontend/lib/api/budgets.ts`, update both signatures' `input` type to:

```typescript
        input: { max_budget: number; budget_duration: BudgetDuration | string; budget_reset_at?: string },
```

(No body changes needed — `input` is already spread/forwarded verbatim: `upsert` passes `input`, `bulkUpsert` passes `{ entityIds, ...input }`.)

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add lib/api/budgets.ts
git commit -m "feat(budgets): accept budget_reset_at in budgets API client"
```

---

### Task 6: Frontend — reset-date picker in `BudgetEditor`

**Files:**
- Modify: `frontend/components/budget-editor.tsx`

**Interfaces:**
- Consumes: `defaultResetDate` (Task 4), `budgetsApi.upsert/bulkUpsert` with `budget_reset_at` (Task 5), `Popover`/`PopoverTrigger`/`PopoverContent`, `Calendar`, `format` from `date-fns`.

- [ ] **Step 1: Add imports**

At the top of `frontend/components/budget-editor.tsx`, add:

```typescript
import { format } from "date-fns"
import { CalendarIcon } from "lucide-react"
import { Calendar } from "@/components/ui/calendar"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
```

Add `defaultResetDate` to the existing `@/lib/budget` import:

```typescript
import {
    BUDGET_DURATIONS,
    defaultResetDate,
    type BudgetDuration,
    type BudgetEntityType,
    type BudgetInfo,
} from "@/lib/budget"
```

- [ ] **Step 2: Add reset-date state, normalized to a UTC calendar day**

Below the `duration` state (line ~93-95), add a helper + state. The Calendar returns a local-midnight Date; normalize any selected day to UTC midnight so what we send matches the backend's UTC window math:

```typescript
    const toUtcDay = (d: Date): Date =>
        new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()))

    const [resetAt, setResetAt] = useState<Date>(() => {
        const iso = existing?.budget_reset_at
        if (iso) {
            const parsed = new Date(iso)
            if (!Number.isNaN(parsed.getTime())) return parsed
        }
        return defaultResetDate(
            (existing?.budget_duration as BudgetDuration) || "30d",
        )
    })
```

- [ ] **Step 3: Reset the date to the new default when duration changes**

Replace the duration `Select`'s `onValueChange` (line ~203) so it also resets the date (approved behavior — a duration change overwrites any custom pick):

```typescript
                    onValueChange={(v) => {
                        const next = v as BudgetDuration
                        setDuration(next)
                        setResetAt(defaultResetDate(next))
                    }}
```

- [ ] **Step 4: Render the date picker below the duration select**

Immediately after the duration `<div className="space-y-2"> … </div>` block (closes at line ~217), add:

```tsx
            <div className="space-y-2">
                <Label>{t("editor.resetDateLabel")}</Label>
                <Popover>
                    <PopoverTrigger asChild>
                        <Button
                            type="button"
                            variant="outline"
                            className="w-full justify-start text-left font-normal"
                            disabled={busy}
                        >
                            <CalendarIcon className="mr-2 h-4 w-4" />
                            {format(resetAt, "PPP")}
                        </Button>
                    </PopoverTrigger>
                    <PopoverContent className="w-auto p-0" align="start">
                        <Calendar
                            mode="single"
                            selected={resetAt}
                            onSelect={(d) => d && setResetAt(toUtcDay(d))}
                            autoFocus
                        />
                    </PopoverContent>
                </Popover>
                <p className="text-xs text-muted-foreground">
                    {t("editor.resetHint")}
                </p>
            </div>
```

- [ ] **Step 5: Include `budget_reset_at` in both save payloads**

In `handleSave`, add `budget_reset_at: resetAt.toISOString()` to both the single `budgetsApi.upsert` call (line ~108-111) and the bulk `budgetsApi.bulkUpsert` call (line ~117-120):

```typescript
                await budgetsApi.upsert(entityType, props.entityId, {
                    max_budget: amountValue,
                    budget_duration: duration,
                    budget_reset_at: resetAt.toISOString(),
                })
```

```typescript
                const results = await budgetsApi.bulkUpsert(entityType, props.entityIds, {
                    max_budget: amountValue,
                    budget_duration: duration,
                    budget_reset_at: resetAt.toISOString(),
                })
```

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add components/budget-editor.tsx
git commit -m "feat(budgets): add reset-date picker to BudgetEditor"
```

---

### Task 7: Frontend — i18n copy (en + de)

**Files:**
- Modify: `frontend/messages/en.json` (`budgets.editor` block ~1009-1038)
- Modify: `frontend/messages/de.json` (corresponding `budgets.editor` block)

**Interfaces:**
- Produces: `budgets.editor.resetDateLabel`, `budgets.editor.resetHint`.

- [ ] **Step 1: Add English keys**

In `frontend/messages/en.json`, inside the `budgets.editor` block (after `"resetLabel"` at line ~1016), add:

```json
      "resetDateLabel": "Reset date",
      "resetHint": "By default the budget resets at the start of each day, week, or month. Pick a date to set a custom reset.",
```

- [ ] **Step 2: Add German keys**

In `frontend/messages/de.json`, inside the matching `budgets.editor` block (next to its `"resetLabel"`), add:

```json
      "resetDateLabel": "Reset-Datum",
      "resetHint": "Standardmäßig wird das Budget zum Beginn des Tages, der Woche oder des Monats zurückgesetzt. Wähle ein Datum für ein eigenes Reset-Datum.",
```

- [ ] **Step 3: Verify JSON validity**

Run: `cd frontend && node -e "require('./messages/en.json'); require('./messages/de.json'); console.log('ok')"`
Expected: `ok`

- [ ] **Step 4: Commit**

```bash
git add messages/en.json messages/de.json
git commit -m "i18n(budgets): reset-date label + hint (en, de)"
```

---

### Task 8: Manual verification

**Files:** none (verification only).

- [ ] **Step 1: Backend suite**

Run: `cd backend && npx jest src/exulu/litellm`
Expected: PASS (admin-client + budget-service).

- [ ] **Step 2: Frontend suite**

Run: `cd frontend && npx vitest run lib/budget.test.ts`
Expected: PASS.

- [ ] **Step 3: Reproduce the original report end-to-end**

With a local LiteLLM sidecar running (per the newlkiag dev loop): create a **weekly** budget for a project, confirm the reset date shows next Monday. Change it to **monthly** and save. Confirm the reset date now reads the 1st of next month (not the old Monday), and that re-opening the editor shows the same date. Pick a **custom** date, save, reopen — confirm it persists. Verify via `POST /tag/info` (master key) that `litellm_budget_table.budget_reset_at` matches what the UI shows.

- [ ] **Step 4: Commit (if any verification fixups were needed)**

```bash
git add -A && git commit -m "test(budgets): verification fixups for reset date"
```

---

## Self-Review

**Spec coverage:**
- Root cause (tag endpoints strip reset date) → handled by `/budget/update` path (Tasks 1-2). ✓
- Smart default (next Mon / 1st / next midnight) → `defaultResetDate` (Task 4). ✓
- Custom override + picker → Task 6. ✓
- Duration change overwrites to new default → Task 6 Step 3. ✓
- Applies on create AND edit → `resetAt` initialized from default on create, sent on every save (Task 6). ✓
- Single + bulk → Tasks 3 & 6. ✓
- Backend validation / 400 on bad date → `parseResetAt` + `parseBudgetBody` (Tasks 2-3). ✓
- Failed `/budget/update` surfaces as failed save → `upsertBudget` lets it throw; route returns 502 (Task 2). ✓
- Additive/back-compat → omitted `budget_reset_at` skips `/budget/update` (Task 2). ✓
- i18n en+de → Task 7. ✓
- No vendored-LiteLLM edits → constraint honored (only `src/` + `frontend/`). ✓

**Placeholder scan:** No TBD/TODO; every code step shows concrete code.

**Type consistency:** `budgetUpdate(budget_id, { budget_reset_at })`, `TagInfo.budget_id`, `TagBudgetInput.budget_reset_at`, `upsertBudget(…, budget_reset_at?)`, `parseResetAt`, `defaultResetDate(duration, now?)` are used consistently across tasks. Every `TagInfo` literal updated to include `budget_id` (Task 1 Step 3). UTC normalization (`toUtcDay`, `Date.UTC`) is consistent between default and custom-pick paths.
