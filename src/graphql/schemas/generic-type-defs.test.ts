/**
 * Regression gate for a near-miss in this branch's history: a stray
 * backtick inside the `itemName` field's docstring terminated the
 * `genericTypes` template literal early. The symptom was NOT a failing
 * test — nothing in the test tree imports `src/graphql/schemas/index.ts`
 * or parses the generated SDL (see `jest src/graphql`), and `createSDL`
 * is only ever exercised indirectly through `makeExecutableSchema`, which
 * no test builds either. The only visible signal was the typecheck error
 * count moving from 8 to 2 — a truncated, syntactically-broken schema
 * read as an *improvement* because a dropped error count was being
 * compared as a bare number, not by error identity.
 *
 * `genericTypes` is the one slice of the generated SDL that does not
 * depend on any table/context/tool/config/eval argument to `createSDL`
 * (see its export comment in `./index.ts`), so it can be parsed directly
 * with the `graphql` package's own `parse()` — cheaply, without building
 * an executable schema and without touching a single resolver. A
 * truncated or syntactically broken SDL string throws out of `parse()`
 * and fails this test, instead of silently shifting a count the wrong
 * way.
 */
import { parse } from "graphql";
import { genericTypes } from "./index";

describe("graphql/schemas genericTypes — parses as valid GraphQL SDL", () => {
  test("parses without throwing", () => {
    expect(() => parse(genericTypes)).not.toThrow();
  });

  test("the parsed document is non-empty", () => {
    const document = parse(genericTypes);
    expect(document.definitions.length).toBeGreaterThan(0);
  });
});
