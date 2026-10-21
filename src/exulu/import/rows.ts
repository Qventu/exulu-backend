import { coerceValue } from "./coerce";
import type { ImportCell } from "./coerce";
import type { ImportField } from "./mapping";

export type ImportRow = {
  index: number;
  cells: Record<string, ImportCell>;
  errors: string[];
};

export type BatchAccess = {
  rights_mode: "private" | "users" | "roles" | "teams" | "public";
  users?: Array<{ id: number; rights: "read" | "write" }>;
  roles?: Array<{ id: string; rights: "read" | "write" }>;
  teams?: Array<{ id: string; rights: "read" | "write" }>;
};

/** Non-empty `id` wins over non-empty `external_id`; neither means create. */
function tentativeAction(cells: Record<string, ImportCell>): "create" | "update" {
  const id = cells.id?.value;
  if (typeof id === "string" && id !== "") return "update";
  const externalId = cells.external_id?.value;
  if (typeof externalId === "string" && externalId !== "") return "update";
  return "create";
}

/**
 * Coerce every mapped cell in a CSV data row and collect its errors.
 *
 * A cell that coerced with an error reports `<field>:<code>`. A required
 * field reports `required:<field>` when the row is a create (derived from
 * its own `id`/`external_id` cells, the same rule as `rowAction`), or when
 * the column is mapped but blank; an unmapped required column is allowed on
 * an update row -- a CSV that only touches a subset of columns does not need
 * to re-supply every required field for rows it merely updates. Mirrors the
 * frontend's `validateRow` (`mustHaveValue = action === "create" || cell !==
 * undefined`).
 */
export function buildRow(
  index: number,
  cells: string[],
  byIndex: Array<string | null>,
  fields: ImportField[],
): ImportRow {
  const byName = new Map(fields.map((f) => [f.name, f]));
  const rowCells: Record<string, ImportCell> = {};
  for (let i = 0; i < byIndex.length; i++) {
    const fieldName = byIndex[i];
    if (!fieldName) continue;
    const field = byName.get(fieldName);
    if (!field) continue;
    rowCells[fieldName] = coerceValue(field, cells[i] ?? "");
  }

  const action = tentativeAction(rowCells);
  const errors: string[] = [];
  for (const f of fields) {
    const cell = rowCells[f.name];
    const mustHaveValue = action === "create" || cell !== undefined;
    if (f.required && mustHaveValue && (cell === undefined || cell.raw.trim() === "")) {
      errors.push(`required:${f.name}`);
      continue;
    }
    if (cell?.error) {
      errors.push(`${f.name}:${cell.error.code}`);
    }
  }

  return { index, cells: rowCells, errors };
}

export function rowIsValid(row: ImportRow): boolean {
  return row.errors.length === 0;
}

/**
 * Classification: an `id` column wins over `external_id`; a row with neither
 * is a create. Pure -- the actual id/external_id lookup against existing
 * items happens in the run loop, not here.
 */
export function rowAction(
  row: ImportRow,
): { action: "update"; by: "id" | "external_id"; key: string } | { action: "create" } {
  const id = row.cells.id?.value;
  if (typeof id === "string" && id !== "") {
    return { action: "update", by: "id", key: id };
  }
  const externalId = row.cells.external_id?.value;
  if (typeof externalId === "string" && externalId !== "") {
    return { action: "update", by: "external_id", key: externalId };
  }
  return { action: "create" };
}

/**
 * `id` is matching metadata only -- it is never sent to a create/update
 * mutation.
 *
 * A blank `external_id` cell is dropped rather than written: a textual blank
 * coerces to `""` (coerce.ts, frontend parity, kept for every other text
 * field) but `external_id` is declared `.unique()` on item tables, so the
 * *second* created row with a blank cell would hit a unique violation, and an
 * `id`-matched update would blank (or collide with) an existing row's key.
 */
function cellValues(row: ImportRow): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  for (const [name, cell] of Object.entries(row.cells)) {
    if (name === "id") continue;
    if (name === "external_id" && (cell.value == null || cell.value === "")) continue;
    input[name] = cell.value;
  }
  return input;
}

/**
 * The grant payload `handleRBACUpdate` (ee/rbac-update.ts) expects: all three
 * lists always present and always arrays. `handleRBACUpdate` destructures
 * them with `= []` defaults, and a default does NOT apply to `null` -- so a
 * `null` list reaching it throws `null.map is not a function` and fails every
 * create row of a grant-mode import.
 */
export type RbacGrantInput = {
  users: NonNullable<BatchAccess["users"]>;
  roles: NonNullable<BatchAccess["roles"]>;
  teams: NonNullable<BatchAccess["teams"]>;
};

/**
 * Coerces one grant list to an array. The lists arrive from GraphQL `JSON`
 * fields (`StartImportAccessInput.users/roles/teams`), where `null` is an
 * ordinary value -- the operator notes' own example sends exactly that -- and
 * an API caller can send anything at all.
 */
export function asGrantList<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

/**
 * The batch's grant payload, for grant-based modes only (`private` and
 * `public` carry no grant list, so they get `undefined` and no grant write).
 *
 * Deliberately NOT part of `buildCreateInput`'s output: item tables have no
 * `RBAC` column (grants live in the shared `rbac` table, written by
 * `handleRBACUpdate`), and `context.createItem` inserts exactly the keys it
 * is handed -- an `RBAC` key on the column input makes Postgres reject every
 * create row with `column "RBAC" ... does not exist`. The create path pairs
 * `buildCreateInput` (columns) with this accessor (grants), the same split
 * the `CreateOne` resolver makes when it pulls `input.RBAC` off before the
 * insert and calls `handleRBACUpdate` after it.
 */
export function rbacGrantsFor(access: BatchAccess): RbacGrantInput | undefined {
  const hasGrants =
    access.rights_mode === "users" ||
    access.rights_mode === "roles" ||
    access.rights_mode === "teams";
  if (!hasGrants) return undefined;
  // Normalised a second time (startImport already does it before storing the
  // batch in trigger_metadata): this is the last point before the grants
  // reach handleRBACUpdate, and a row of an import started before that
  // normalisation existed would otherwise still carry a stored `null`.
  return {
    users: asGrantList(access.users),
    roles: asGrantList(access.roles),
    teams: asGrantList(access.teams),
  };
}

/**
 * Create-mutation input: the mapped values plus the batch's rights_mode
 * (always sent). Real item columns only -- the batch's grants travel
 * separately, via `rbacGrantsFor`.
 */
export function buildCreateInput(row: ImportRow, access: BatchAccess): Record<string, unknown> {
  const input = cellValues(row);
  input.rights_mode = access.rights_mode;
  return input;
}

/** Partial update input: only the mapped values; never rights_mode, RBAC, or created_by. */
export function buildUpdateInput(row: ImportRow): Record<string, unknown> {
  return cellValues(row);
}
