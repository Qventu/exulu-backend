/**
 * The initialiser must never destroy data.
 *
 * Every deployment runs `ExuluDatabase.init` through its own `init-db` script,
 * against whatever database that deployment points at — including production.
 * A one-time migration written while picturing one set of databases is the
 * shape that bites: the author knows their own rows are disposable, the
 * condition tests whether the SCHEMA is old rather than whether the DATA
 * matters, and the statement runs anywhere the schema happens to be old.
 *
 * Three such statements shipped here and were removed on 2026-10-05: a delete
 * of every `workflow_triggers` row, an unconditional delete of a retired
 * `platform_configurations` row, and a `DROP TABLE … CASCADE`. None was
 * necessary — see the comments at their former call sites.
 *
 * So this is an invariant over the file, not a unit test of a function. If a
 * migration genuinely needs to destroy something, change this test in the same
 * commit and let a reviewer see the decision.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = readFileSync(join(__dirname, "init-exulu-db.ts"), "utf8");

/** Comments explain the absence of these statements; only code counts. */
const code = source
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n")
  .map((line) => line.replace(/\/\/.*$/, ""))
  .join("\n");

describe("init-exulu-db destroys nothing", () => {
  test.each([
    ["deletes rows (knex .del())", /\.del\s*\(\s*\)/],
    ["deletes rows (knex .delete())", /\.delete\s*\(\s*\)/],
    ["deletes rows (raw DELETE)", /\bDELETE\s+FROM\b/i],
    ["drops a column", /\.dropColumn\s*\(/],
    ["drops a table", /\bDROP\s+TABLE\b/i],
    ["truncates a table", /\bTRUNCATE\b/i],
  ])("never %s", (_label, pattern) => {
    expect(code).not.toMatch(pattern);
  });

  test("the guard reads the file it claims to", () => {
    // Without this, a renamed or moved file would make every assertion above
    // pass against an empty string.
    expect(code).toMatch(/export const execute/);
    expect(code.length).toBeGreaterThan(1000);
  });
});
