import { sanitizeName } from "@SRC/utils/sanitize-name";
import type { ExuluContextFieldDefinition } from "@SRC/exulu/context";

/** One importable column: a core item field or a context custom field. */
export type ImportField = {
  name: string;
  label?: string;
  type: string;
  required?: boolean;
  core?: boolean;
  enumValues?: string[];
};

export type ColumnMapping = { header: string; fieldName: string | null };

/** Lowercase, trim, and unify space/dash separators to underscores. */
export function normalizeHeader(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
}

function headerMatchesField(field: ImportField, normalizedHeader: string): boolean {
  if (normalizeHeader(field.name) === normalizedHeader) return true;
  return field.label != null && normalizeHeader(field.label) === normalizedHeader;
}

/** Best-effort header -> field auto-match; unmatched columns map to null. */
export function autoMapColumns(headers: string[], fields: ImportField[]): ColumnMapping[] {
  const used = new Set<string>();
  return headers.map((header) => {
    const normalized = normalizeHeader(header);
    const match = fields.find((f) => !used.has(f.name) && headerMatchesField(f, normalized));
    if (!match) return { header, fieldName: null };
    used.add(match.name);
    return { header, fieldName: match.name };
  });
}

/** Core item columns every context supports. `id` is matching metadata only. */
const CORE_FIELDS: ImportField[] = [
  { name: "id", type: "text", core: true },
  { name: "external_id", type: "text", core: true },
  { name: "name", type: "shortText", required: true, core: true },
  { name: "description", type: "longText", core: true },
  { name: "tags", type: "text", core: true },
];

/**
 * Importable columns: the built-in item fields plus editable context fields.
 * Calculated, hidden, and file-typed fields are excluded -- file cells are not
 * importable through this server path (no local file to upload against).
 *
 * `name` is the *physical* column (`sanitizeName(field.name)`, the same
 * transform `createItemsTable` applies when it creates the column and
 * `convertContextToTableDefinition` applies when it exposes it over GraphQL),
 * so the write input's keys are real columns; the raw field name is kept as
 * `label`, so a header matches whichever spelling the file uses (nothing
 * validates that a context field name is already lowercase/underscore -- only
 * context *ids* are checked).
 */
export function importFieldsFor(fields: ExuluContextFieldDefinition[]): ImportField[] {
  const custom: ImportField[] = fields
    .filter((f) => !f.calculated && !f.hidden && f.type !== "file")
    .map((f) => ({
      name: sanitizeName(f.name),
      label: f.name,
      type: f.type,
      required: f.required === true,
      core: false,
      enumValues: f.enumValues,
    }));
  return [...CORE_FIELDS, ...custom];
}

/**
 * Validate a previously-saved column mapping against the current headers and
 * fields. Entries whose `fieldName` is not among `fields` are dropped (and
 * reported in `unknownFields`); a header with no entry in `given` stays
 * unmapped. When `given` is omitted entirely, auto-map instead.
 *
 * Headers are matched through `normalizeHeader` on BOTH sides: csv-stream
 * trims the file's header cells, so a stored mapping whose headers carry
 * surrounding whitespace (or differ only in case) would otherwise match
 * nothing and abort the run with NO_MAPPABLE_COLUMNS -- including on the
 * documented retry flow, which re-reads a header the backend itself trimmed.
 */
export function resolveMapping(
  headers: string[],
  fields: ImportField[],
  given?: ColumnMapping[],
): { byIndex: Array<string | null>; unknownFields: string[] } {
  if (!given) {
    return { byIndex: autoMapColumns(headers, fields).map((m) => m.fieldName), unknownFields: [] };
  }
  const fieldNames = new Set(fields.map((f) => f.name));
  const byHeader = new Map(given.map((g) => [normalizeHeader(g.header), g.fieldName]));
  const unknownFields = new Set<string>();
  const byIndex = headers.map((header) => {
    const fieldName = byHeader.get(normalizeHeader(header));
    if (fieldName == null) return null;
    if (!fieldNames.has(fieldName)) {
      unknownFields.add(fieldName);
      return null;
    }
    return fieldName;
  });
  return { byIndex, unknownFields: [...unknownFields] };
}
