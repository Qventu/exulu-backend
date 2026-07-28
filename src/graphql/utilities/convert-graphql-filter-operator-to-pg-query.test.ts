import Knex from "knex";

import { convertGraphqlOperatorToPostgresQuery } from "./convert-graphql-filter-operator-to-pg-query";

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
