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
