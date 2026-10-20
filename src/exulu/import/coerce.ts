import type { ImportField } from "./mapping";

export type CellError = { code: string; params?: Record<string, string> };

export type ImportCell = {
  raw: string;
  value: string | number | boolean | null;
  error?: CellError;
};

/** Types whose blank raw value coerces to "" rather than null. */
const TEXTUAL = new Set(["text", "longText", "shortText", "markdown", "code"]);

function err(raw: string, code: string, params?: Record<string, string>): ImportCell {
  return { raw, value: null, error: { code, params } };
}

/**
 * Coerce a raw CSV cell to the field's value type. Never throws -- invalid
 * input comes back as a cell with `error` set and `value: null`.
 *
 * Ported from frontend/lib/import/coerce.ts. The server validates exactly as
 * the browser preview does (same outcomes, same error codes) for every type
 * except "file": file cells are excluded entirely, since importFieldsFor
 * never produces a field of type "file" here -- there is no local file to
 * upload against a streamed server-side import. Any other, truly unknown
 * field type degrades to a plain text passthrough, same as the frontend does
 * for types it does not recognize.
 */
export function coerceValue(field: ImportField, raw: string): ImportCell {
  const trimmed = raw.trim();
  if (trimmed === "") {
    return { raw, value: TEXTUAL.has(field.type) ? "" : null };
  }
  switch (field.type) {
    case "number": {
      const hasComma = trimmed.includes(",");
      const hasDot = trimmed.includes(".");
      if (hasComma && hasDot) return err(raw, "number");
      let candidate = trimmed;
      if (hasComma) {
        const parts = trimmed.split(",");
        // A single comma with 1-2 decimals is an unambiguous decimal comma
        // (German CSV exports); "1,500" is indistinguishable from a
        // thousands separator, so it is rejected rather than guessed.
        if (parts.length !== 2 || (parts[1]?.length ?? 0) === 3) return err(raw, "numberAmbiguous");
        candidate = parts.join(".");
      }
      const n = Number(candidate);
      if (!Number.isFinite(n)) return err(raw, "number");
      return { raw, value: n };
    }
    case "boolean": {
      const v = trimmed.toLowerCase();
      if (["true", "yes", "ja", "1"].includes(v)) return { raw, value: true };
      if (["false", "no", "nein", "0"].includes(v)) return { raw, value: false };
      return err(raw, "boolean");
    }
    case "enum": {
      const match = (field.enumValues ?? []).find((e) => e.toLowerCase() === trimmed.toLowerCase());
      if (!match) return err(raw, "enum", { values: (field.enumValues ?? []).join(", ") });
      return { raw, value: match };
    }
    case "date": {
      if (/^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/.test(trimmed)) {
        return Number.isNaN(Date.parse(trimmed)) ? err(raw, "date") : { raw, value: trimmed };
      }
      if (trimmed.includes("/")) return err(raw, "date");
      return Number.isNaN(Date.parse(trimmed))
        ? err(raw, "date")
        : { raw, value: new Date(trimmed).toISOString() };
    }
    case "json": {
      try {
        JSON.parse(trimmed);
        return { raw, value: trimmed };
      } catch {
        return err(raw, "json");
      }
    }
    case "uuid": {
      return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(trimmed)
        ? { raw, value: trimmed }
        : err(raw, "uuid");
    }
    default:
      return { raw, value: raw };
  }
}
