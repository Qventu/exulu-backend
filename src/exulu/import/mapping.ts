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
 */
export function importFieldsFor(fields: ExuluContextFieldDefinition[]): ImportField[] {
  const custom: ImportField[] = fields
    .filter((f) => !f.calculated && !f.hidden && f.type !== "file")
    .map((f) => ({
      name: f.name,
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
  const byHeader = new Map(given.map((g) => [g.header, g.fieldName]));
  const unknownFields = new Set<string>();
  const byIndex = headers.map((header) => {
    const fieldName = byHeader.get(header);
    if (fieldName == null) return null;
    if (!fieldNames.has(fieldName)) {
      unknownFields.add(fieldName);
      return null;
    }
    return fieldName;
  });
  return { byIndex, unknownFields: [...unknownFields] };
}
