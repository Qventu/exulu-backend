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

/** `id` is matching metadata only -- it is never sent to a create/update mutation. */
function cellValues(row: ImportRow): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  for (const [name, cell] of Object.entries(row.cells)) {
    if (name === "id") continue;
    input[name] = cell.value;
  }
  return input;
}

/**
 * Create-mutation input: the mapped values plus the batch's rights_mode
 * (always sent) and RBAC grants (only for grant-based modes -- private and
 * public carry no grant list).
 */
export function buildCreateInput(row: ImportRow, access: BatchAccess): Record<string, unknown> {
  const input = cellValues(row);
  input.rights_mode = access.rights_mode;
  const hasGrants =
    access.rights_mode === "users" ||
    access.rights_mode === "roles" ||
    access.rights_mode === "teams";
  if (hasGrants) {
    input.RBAC = { users: access.users, roles: access.roles, teams: access.teams };
  }
  return input;
}

/** Partial update input: only the mapped values; never rights_mode, RBAC, or created_by. */
export function buildUpdateInput(row: ImportRow): Record<string, unknown> {
  return cellValues(row);
}
