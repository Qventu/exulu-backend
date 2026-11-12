import Knex from "knex";
import { z } from "zod";
import type { ExuluTableDefinition } from "@EXULU_TYPES/exulu-table-definition";

import {
  convertGraphqlOperatorToPostgresQuery,
  UnknownFilterPathError,
} from "./convert-graphql-filter-operator-to-pg-query";

// SQL-builder only (no connection): Knex compiles queries to strings without pg.
const knex = Knex({ client: "pg" });

describe("convertGraphqlOperatorToPostgresQuery", () => {
  it("compiles { eq: null } to an IS NULL clause (no dedicated null operator needed)", () => {
    const query = convertGraphqlOperatorToPostgresQuery(
      knex("agent_sessions"),
      "run",
      { eq: null },
    );
    const sql = query.toString().toLowerCase();
    expect(sql).toContain('"run" is null');
  });

  it("compiles { eq: value } to an equality clause", () => {
    const query = convertGraphqlOperatorToPostgresQuery(
      knex("agent_sessions"),
      "run",
      { eq: "wf-1" },
    );
    const sql = query.toString().toLowerCase();
    expect(sql).toContain('"run" =');
    expect(sql).not.toContain("is null");
  });
});

// ---------------------------------------------------------------------------
// `contains` on a `json` field that declares a schema (Task 5).
//
// Same M&V fixture as json-field-schema.test.ts / item-write.test.ts: a json
// field that is a record of entries, each entry a small fixed object. Kept
// identical on purpose so a reader who has seen one of those files
// recognises the shape here. `felder`'s real paths are `<key>.wert` /
// `<key>.konfidenz` — `<key>` is a caller-chosen record id, never a literal
// schema member.
// ---------------------------------------------------------------------------
const feld = z.object({ wert: z.string(), konfidenz: z.enum(["low", "medium", "high"]) });
const felderSchema = z.record(z.string(), feld);

const table: ExuluTableDefinition = {
  name: { singular: "test_item", plural: "test_items" },
  fields: [
    { name: "felder", type: "json", schema: felderSchema },
    { name: "notes", type: "json" }, // no schema declared — opaque, as today
  ],
};

describe("convertGraphqlOperatorToPostgresQuery — contains on a schema-carrying json field", () => {
  test("a contains filter on a declared path still compiles to @>", () => {
    const query = convertGraphqlOperatorToPostgresQuery(
      knex("items"),
      "felder",
      { contains: { budget_gesamt: { konfidenz: "low" } } },
      table,
    );
    const sql = query.toString().toLowerCase();
    expect(sql).toContain("@>");
    expect(sql).toContain("'{\"budget_gesamt\":{\"konfidenz\":\"low\"}}'");
  });

  test("a contains filter on an undeclared path is refused, not answered", () => {
    // The spec's core finding: today (before this task) this compiled to a
    // valid, always-true-shaped @> clause via JSON.stringify and matched
    // zero rows with no error — the model would read that as "there are
    // none" instead of "the path was wrong". `felder`'s real shape is
    // `<key>.konfidenz`, not a bare top-level `konfidenz` key, so this must
    // throw instead of silently compiling a query.
    expect(() =>
      convertGraphqlOperatorToPostgresQuery(
        knex("items"),
        "felder",
        { contains: { konfidenz: "low" } },
        table,
      ),
    ).toThrow(UnknownFilterPathError);
  });

  test("the refusal lists the valid paths", () => {
    try {
      convertGraphqlOperatorToPostgresQuery(
        knex("items"),
        "felder",
        { contains: { konfidenz: "low" } },
        table,
      );
      throw new Error("expected convertGraphqlOperatorToPostgresQuery to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(UnknownFilterPathError);
      const err = error as UnknownFilterPathError;
      expect(err.field).toBe("felder");
      expect(err.offendingPaths).toEqual(["konfidenz"]);
      expect(err.validPaths).toEqual(expect.arrayContaining(["<key>.wert", "<key>.konfidenz"]));
      // The message itself -- what a model actually reads -- must carry the
      // "what's available instead" list, not just the structured fields.
      expect(err.message).toContain("<key>.wert");
      expect(err.message).toContain("<key>.konfidenz");
      // No Postgres/SQL/database vocabulary leaks into a message a model reads.
      expect(err.message.toLowerCase()).not.toContain("jsonb");
      expect(err.message.toLowerCase()).not.toContain("sql");
    }
  });

  test("a json field with no schema filters exactly as before", () => {
    // `notes` declares no schema, so ANY path (including one that would be
    // refused on `felder`) must filter exactly as it always has -- backward
    // compatibility is absolute.
    const query = convertGraphqlOperatorToPostgresQuery(
      knex("items"),
      "notes",
      { contains: { konfidenz: "low" } },
      table,
    );
    const sql = query.toString().toLowerCase();
    expect(sql).toContain("@>");
  });
});

// ---------------------------------------------------------------------------
// Final review, Important 5: the path check applies to every operator that
// compiles a json VALUE, not only `contains`.
//
// `eq` compiles to `?? = ?::jsonb` and `in` to an OR of the same; `ne`
// compiles to `?? IS DISTINCT FROM ?::jsonb`. JSON.stringify never throws
// and the cast never fails, so an undeclared path on any of them matched
// zero rows (every row, for `ne`) with no error -- the identical silence
// `contains` was fixed for.
// ---------------------------------------------------------------------------
describe("convertGraphqlOperatorToPostgresQuery — eq / ne / in on a schema-carrying json field", () => {
  test("an eq filter on an undeclared path is refused, not compiled to a zero-row query", () => {
    expect(() =>
      convertGraphqlOperatorToPostgresQuery(knex("items"), "felder", { eq: { konfidenz: "low" } }, table),
    ).toThrow(UnknownFilterPathError);
  });

  test("an ne filter on an undeclared path is refused -- it would otherwise match EVERY row", () => {
    expect(() =>
      convertGraphqlOperatorToPostgresQuery(knex("items"), "felder", { ne: { konfidenz: "low" } }, table),
    ).toThrow(UnknownFilterPathError);
  });

  test("an in filter is checked per element -- one bad entry among good ones is still refused", () => {
    expect(() =>
      convertGraphqlOperatorToPostgresQuery(
        knex("items"),
        "felder",
        { in: [{ budget_gesamt: { konfidenz: "low" } }, { konfidenz: "low" }] },
        table,
      ),
    ).toThrow(UnknownFilterPathError);
  });

  test("the same bad path across two operators is reported once, not twice", () => {
    try {
      convertGraphqlOperatorToPostgresQuery(
        knex("items"),
        "felder",
        { eq: { konfidenz: "low" }, contains: { konfidenz: "low" } },
        table,
      );
      throw new Error("expected convertGraphqlOperatorToPostgresQuery to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(UnknownFilterPathError);
      expect((error as UnknownFilterPathError).offendingPaths).toEqual(["konfidenz"]);
    }
  });

  test("eq / ne / in on a DECLARED path still compile exactly as before", () => {
    const eqSql = convertGraphqlOperatorToPostgresQuery(
      knex("items"),
      "felder",
      { eq: { budget_gesamt: { konfidenz: "low" } } },
      table,
    )
      .toString()
      .toLowerCase();
    expect(eqSql).toContain("::jsonb");

    const neSql = convertGraphqlOperatorToPostgresQuery(
      knex("items"),
      "felder",
      { ne: { budget_gesamt: { konfidenz: "low" } } },
      table,
    )
      .toString()
      .toLowerCase();
    expect(neSql).toContain("is distinct from");

    const inSql = convertGraphqlOperatorToPostgresQuery(
      knex("items"),
      "felder",
      { in: [{ budget_gesamt: { konfidenz: "low" } }] },
      table,
    )
      .toString()
      .toLowerCase();
    expect(inSql).toContain("::jsonb");
  });

  test("a json field with NO schema is unaffected by any of them -- backward compatibility is absolute", () => {
    for (const operators of [{ eq: { konfidenz: "low" } }, { ne: { konfidenz: "low" } }, { in: [{ konfidenz: "low" }] }]) {
      expect(() =>
        convertGraphqlOperatorToPostgresQuery(knex("items"), "notes", operators, table),
      ).not.toThrow();
    }
  });

  test("lte / gte are not path-checked -- they compile a scalar comparison, not a path lookup", () => {
    // Deliberate scope note, asserted so a later change has to be
    // deliberate too: the spec's non-goals close the door on new json
    // operators, and these two carry no path to be wrong.
    expect(() =>
      convertGraphqlOperatorToPostgresQuery(knex("items"), "felder", { gte: 5 }, table),
    ).not.toThrow();
    expect(() =>
      convertGraphqlOperatorToPostgresQuery(knex("items"), "felder", { lte: 5 }, table),
    ).not.toThrow();
  });

  test("a non-json field with the same name shape is untouched (the check is gated on type json)", () => {
    const textTable: ExuluTableDefinition = {
      name: { singular: "test_item", plural: "test_items" },
      fields: [{ name: "felder", type: "text", schema: felderSchema } as any],
    };
    expect(() =>
      convertGraphqlOperatorToPostgresQuery(knex("items"), "felder", { eq: "anything" }, textTable),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// The `lte: 0` branch is the only operator that compiles to an OR. Ungrouped,
// that OR escapes its own filter: every caller applies filters BEFORE access
// control (ExuluContext.getItems, the generated list resolvers), so
// `col IS NULL OR col = 0 AND <access control>` binds as
// `col IS NULL OR (col = 0 AND <access control>)` — i.e. every row with NULL
// in that column comes back with no access control at all. Found reviewing
// the generated `find_<ctx>_items` tool, which hands a model the operator
// directly (fix round 1, F1).
// ---------------------------------------------------------------------------
describe("convertGraphqlOperatorToPostgresQuery — the OR branch cannot escape its own filter", () => {
  test("{ lte: 0 } compiles to a PARENTHESISED null-or-zero group", () => {
    const query = convertGraphqlOperatorToPostgresQuery(knex("items"), "chunks_count", { lte: 0 });
    expect(query.toString().toLowerCase()).toContain(
      'where ("chunks_count" is null or "chunks_count" = 0)',
    );
  });

  test("a predicate added after it stays AND-ed to the whole group, not to the zero branch", () => {
    let query = convertGraphqlOperatorToPostgresQuery(knex("items"), "chunks_count", { lte: 0 });
    query = query.where("rights_mode", "public");
    const sql = query.toString().toLowerCase();
    expect(sql).toBe(
      'select * from "items" where ("chunks_count" is null or "chunks_count" = 0) and "rights_mode" = \'public\'',
    );
    // The bypass shape: the access predicate must never sit inside the OR.
    expect(sql).not.toContain('"chunks_count" is null or "chunks_count" = 0 and');
  });

  test('{ lte: "0" } (the string form) is grouped too', () => {
    const query = convertGraphqlOperatorToPostgresQuery(knex("items"), "chunks_count", { lte: "0" });
    expect(query.toString().toLowerCase()).toContain(
      'where ("chunks_count" is null or "chunks_count" = 0)',
    );
  });
});
