/**
 * Regression gate for a near-miss in this branch's history: a stray backtick
 * inside the `itemName` field's docstring terminated the `genericTypes`
 * template literal early. The symptom was NOT a failing test — nothing in the
 * test tree imports `src/graphql/schemas/index.ts` or parses the generated
 * SDL, and `createSDL` is only ever exercised indirectly through
 * `makeExecutableSchema`, which no test builds. The only visible signal was
 * the typecheck error count moving from 8 to 2 — a truncated,
 * syntactically-broken schema read as an *improvement*, because a terminated
 * literal stops type-checking the ~3,000 lines after it and the count was
 * being compared as a bare number rather than by error identity.
 *
 * `genericTypes()` is the slice of the generated SDL that takes no argument
 * from `createSDL`, so it can be parsed directly with the `graphql` package's
 * own `parse()` — cheaply, without building an executable schema and without
 * touching a resolver.
 *
 * It is called, not read: see its own comment. It interpolates runtime state,
 * so evaluating it at import time silently empties `QueueEnum`.
 */
import { parse } from "graphql";
import { genericTypes } from "./index";

describe("graphql/schemas genericTypes — parses as valid GraphQL SDL", () => {
  test("parses without throwing", () => {
    expect(() => parse(genericTypes())).not.toThrow();
  });

  test("the parsed document is non-empty", () => {
    expect(parse(genericTypes()).definitions.length).toBeGreaterThan(0);
  });

  /**
   * The enum is rendered from `ExuluQueues.list`, which is populated at
   * runtime. This pins the evaluation point: as a module-level `const` the
   * list is always empty at import, so the enum rendered its `NO_QUEUES`
   * fallback and every operation taking a `QueueEnum!` became uncallable —
   * while parsing, type-checking and testing clean.
   */
  test("QueueEnum is rendered per call, not frozen at import", () => {
    const { queues } = require("@EE/queues/queues") as {
      queues: { list: Map<string, unknown> };
    };
    const before = genericTypes();
    expect(/enum QueueEnum \{\s*NO_QUEUES\s*\}/.test(before)).toBe(true);

    queues.list.set("probe_queue", {});
    try {
      const after = genericTypes();
      expect(after).toContain("probe_queue");
      expect(/enum QueueEnum \{\s*NO_QUEUES\s*\}/.test(after)).toBe(false);
    } finally {
      queues.list.delete("probe_queue");
    }
  });
});
