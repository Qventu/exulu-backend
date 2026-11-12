import Knex from "knex";
import type { ExuluTableDefinition } from "@EXULU_TYPES/exulu-table-definition";

import { applyFilters, applyFiltersGrouped } from "./apply-filters";

// SQL-builder only (no connection): Knex compiles queries to strings without pg.
const knex = Knex({ client: "pg" });

const table: ExuluTableDefinition = {
  name: { singular: "products_items", plural: "products_items" },
  RBAC: true,
  fields: [
    { name: "chunks_count", type: "number" },
    { name: "name", type: "text" },
  ],
} as ExuluTableDefinition;

/**
 * `applyFiltersGrouped` is the chokepoint for ONE structural guarantee: every
 * caller applies filters before the access predicate, so a filter that
 * compiles to an OR must not be able to reach across it. `{ lte: 0 }` is the
 * one operator that does today (`col IS NULL OR col = 0`); the group is what
 * keeps the next one harmless (fix round 1 F1, fix round 2).
 */
describe("applyFiltersGrouped", () => {
  it("wraps an OR-compiling filter so a predicate added after it stays AND-ed", () => {
    let query = applyFiltersGrouped(knex("products_items"), [{ chunks_count: { lte: 0 } }], table);
    query = query.where("rights_mode", "public");
    const sql = query.toString().toLowerCase();
    expect(sql).toBe(
      'select * from "products_items" where (("chunks_count" is null or "chunks_count" = 0)) and "rights_mode" = \'public\'',
    );
  });

  it("adds a group the bare call does not: safety stops depending on each operator", () => {
    // Bare applyFilters is safe for `lte: 0` only because that operator now
    // parenthesises itself (one level). The helper adds the outer group (two
    // levels), which is what makes the guarantee structural rather than
    // per-operator — the difference that matters for the next operator
    // somebody compiles to an OR.
    const bare = applyFilters(knex("products_items"), [{ chunks_count: { lte: 0 } }], table)
      .toString()
      .toLowerCase();
    const grouped = applyFiltersGrouped(knex("products_items"), [{ chunks_count: { lte: 0 } }], table)
      .toString()
      .toLowerCase();
    expect(bare).toContain('where ("chunks_count" is null or "chunks_count" = 0)');
    expect(grouped).toContain('where (("chunks_count" is null or "chunks_count" = 0))');
  });

  it("emits no SQL for no filters (an empty group is dropped by knex)", () => {
    for (const filters of [[], undefined as any]) {
      const sql = applyFiltersGrouped(knex("products_items"), filters, table).toString().toLowerCase();
      expect(sql).toBe('select * from "products_items"');
    }
  });

  it("still ANDs several filters inside the group", () => {
    const sql = applyFiltersGrouped(
      knex("products_items"),
      [{ name: { contains: "widget" } }, { chunks_count: { gte: 2 } }],
      table,
    )
      .toString()
      .toLowerCase();
    expect(sql).toBe(
      'select * from "products_items" where ("name" ilike \'%widget%\' and "chunks_count" >= 2)',
    );
  });

  it("keeps an explicit or-group working inside it", () => {
    const sql = applyFiltersGrouped(
      knex("products_items"),
      [{ name: { or: [{ eq: "a" }, { eq: "b" }] } }],
      table,
    )
      .toString()
      .toLowerCase();
    expect(sql).toContain('"name" = \'a\'');
    expect(sql).toContain('or ');
    expect(sql.startsWith('select * from "products_items" where (')).toBe(true);
  });
});
