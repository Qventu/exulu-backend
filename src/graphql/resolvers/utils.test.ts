import { getRequestedFields } from "./utils";

// GraphQL meta-fields (__typename, __schema, …) must never reach the SQL
// SELECT: this backend forwards requested fields straight into Knex, and an
// Apollo client with addTypename:true injects __typename into every selection
// set. Pins the strip so a client's cache config can't break these resolvers.

/** Builds the `info` shape getRequestedFields reads from a flat field list. */
const infoWith = (
  fieldNames: string[],
  wrapper?: "item" | "items",
): any => {
  const leafSelections = fieldNames.map((value) => ({
    name: { value },
    // A scalar field has no nested selectionSet.
  }));
  const inner = wrapper
    ? [{ name: { value: wrapper }, selectionSet: { selections: leafSelections } }]
    : leafSelections;
  return {
    operation: {
      selectionSet: {
        selections: [{ selectionSet: { selections: inner } }],
      },
    },
  };
};

describe("getRequestedFields — meta-field stripping", () => {
  test("strips __typename from an items pagination selection", () => {
    const fields = getRequestedFields(
      infoWith(["id", "title", "__typename"], "items"),
    );
    expect(fields).toContain("id");
    expect(fields).toContain("title");
    expect(fields).not.toContain("__typename");
  });

  test("strips __typename from an item (single) selection", () => {
    const fields = getRequestedFields(
      infoWith(["id", "name", "__typename"], "item"),
    );
    expect(fields).toEqual(["id", "name"]);
  });

  test("strips __typename from a bare selection (no item/items wrapper)", () => {
    const fields = getRequestedFields(infoWith(["id", "__typename"]));
    expect(fields).toEqual(["id"]);
  });

  test("still filters the existing pageInfo/items/RBAC meta selections", () => {
    const fields = getRequestedFields(
      infoWith(["id", "pageInfo", "items", "RBAC", "__typename"], "items"),
    );
    expect(fields).toEqual(["id"]);
  });

  test("leaves ordinary fields untouched when no meta-fields present", () => {
    const fields = getRequestedFields(infoWith(["id", "title"], "items"));
    expect(fields).toEqual(["id", "title"]);
  });
});
