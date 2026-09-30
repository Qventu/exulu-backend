import knex from "knex";
import { getTableName } from "@SRC/exulu/table-names";
import { loadVisibleMemoryRows, MEMORY_ITEM_FIELDS } from "./recall-collector";

// Silence applyAccessControl's console.log output during tests
beforeAll(() => {
  jest.spyOn(console, "log").mockImplementation(() => undefined);
});

// Connectionless builder: knex only needs a client to compile SQL. Overriding `then`
// on the builder lets `await` resolve without a database while we capture the query.
const k = knex({ client: "pg" });
type Captured = { sql: string; bindings: unknown[] };

function fakeDb(rows: unknown[]) {
  const captured: Captured[] = [];
  const db = (table: string) => {
    const qb: any = k(table);
    qb.then = (resolve: (v: unknown) => void) => {
      const { sql, bindings } = qb.toSQL().toNative();
      captured.push({ sql, bindings });
      resolve(rows);
    };
    return qb;
  };
  return { db, captured };
}

const context: any = { id: "mem", name: "Memory", fields: [] };
const table = getTableName("mem");

describe("loadVisibleMemoryRows — real access control", () => {
  it("scopes a signed-in user to public rows, their own rows, and rows shared with them", async () => {
    const { db, captured } = fakeDb([{ id: "a" }]);
    const rows = await loadVisibleMemoryRows(context, ["a", "b"], { id: 4 } as any, db);
    expect(rows).toEqual([{ id: "a" }]);
    expect(captured).toHaveLength(1);
    const { sql, bindings } = captured[0]!;
    expect(sql).toContain(`from "${table}"`);
    expect(sql).toContain(`"id" in ($1, $2)`);
    expect(sql).toContain(`not "archived" = $3`);
    expect(sql).toContain(`"rights_mode" = $4`); // public clause
    expect(sql).toContain(`"created_by" = $5`); // own rows clause
    expect(sql).toContain(`"rbac"."user_id" = $`); // shared rows clause
    expect(bindings.slice(0, 5)).toEqual(["a", "b", true, "public", 4]);
    for (const f of MEMORY_ITEM_FIELDS) expect(sql).toContain(`"${f}"`);
  });

  it("scopes a guest (no user) to public rows only", async () => {
    const { db, captured } = fakeDb([]);
    await loadVisibleMemoryRows(context, ["a"], undefined, db);
    expect(captured).toHaveLength(1);
    const { sql, bindings } = captured[0]!;
    expect(sql).toContain(`"rights_mode" = $`); // public clause present
    expect(sql).not.toContain(`"created_by" =`); // own rows WHERE clause absent (not in WHERE condition)
    expect(sql).not.toContain(`"rbac"`); // shared rows clause absent
    expect(bindings).toEqual(["a", true, "public"]);
  });

  it("adds the role and team share branches only when the user has them", async () => {
    const withRole = fakeDb([]);
    await loadVisibleMemoryRows(context, ["a"], { id: 4, role: { id: "r1" } } as any, withRole.db);
    expect(withRole.captured).toHaveLength(1);
    expect(withRole.captured[0]!.sql).toContain(`"rbac"."role_id" = $`);
    expect(withRole.captured[0]!.sql).not.toContain(`"rbac"."team_id"`);

    const withTeam = fakeDb([]);
    await loadVisibleMemoryRows(context, ["a"], { id: 4, team: { id: "t1" } } as any, withTeam.db);
    expect(withTeam.captured).toHaveLength(1);
    expect(withTeam.captured[0]!.sql).toContain(`"rbac"."team_id" = $`);
  });

  it("returns [] for no ids without building a query", async () => {
    const { db, captured } = fakeDb([]);
    expect(await loadVisibleMemoryRows(context, [], { id: 4 } as any, db)).toEqual([]);
    expect(captured).toHaveLength(0);
  });
});
