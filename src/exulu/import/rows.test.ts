import { buildCreateInput, buildRow, buildUpdateInput, rbacGrantsFor, rowAction, rowIsValid } from "./rows";
import type { ImportField } from "./mapping";

const fields: ImportField[] = [
  { name: "name", type: "shortText", required: true, core: true },
  { name: "external_id", type: "text", core: true },
  { name: "qty", type: "number" },
];

describe("buildRow / rowIsValid / rowAction / buildCreateInput / buildUpdateInput", () => {
  it("coerces every mapped cell and classifies a valid row as an external_id update", () => {
    const row = buildRow(3, ["Shoe", "X1", "1,5"], ["name", "external_id", "qty"], fields);
    expect(rowIsValid(row)).toBe(true);
    expect(rowAction(row)).toEqual({ action: "update", by: "external_id", key: "X1" });
    expect(buildUpdateInput(row)).toEqual({ name: "Shoe", external_id: "X1", qty: 1.5 });
    expect(buildCreateInput(row, { rights_mode: "public" })).toEqual({
      name: "Shoe",
      external_id: "X1",
      qty: 1.5,
      rights_mode: "public",
    });
  });

  it("collects a required-field error and a coercion error, in field order", () => {
    const row = buildRow(4, ["", "X2", "abc"], ["name", "external_id", "qty"], fields);
    expect(rowIsValid(row)).toBe(false);
    expect(row.errors).toEqual(["required:name", "qty:number"]);
  });

  it("classifies a row with no id/external_id as a create", () => {
    const row = buildRow(5, ["N", "", ""], ["name", "external_id", "qty"], fields);
    expect(rowAction(row)).toEqual({ action: "create" });
  });

  it("id wins over external_id when both are present", () => {
    const withId: ImportField[] = [...fields, { name: "id", type: "text", core: true }];
    const row = buildRow(6, ["N", "X3", "2", "id-9"], ["name", "external_id", "qty", "id"], withId);
    expect(rowAction(row)).toEqual({ action: "update", by: "id", key: "id-9" });
  });

  it("never sends id in a create or update input", () => {
    const withId: ImportField[] = [...fields, { name: "id", type: "text", core: true }];
    const row = buildRow(7, ["N", "", "2", "id-9"], ["name", "external_id", "qty", "id"], withId);
    expect(buildUpdateInput(row)).toEqual({ name: "N", qty: 2 });
    expect(buildCreateInput(row, { rights_mode: "private" })).toEqual({
      name: "N",
      qty: 2,
      rights_mode: "private",
    });
  });

  it("I7: drops a blank external_id entirely (it is UNIQUE), while other blank text fields stay \"\"", () => {
    const withText: ImportField[] = [...fields, { name: "note", type: "text" }];
    const row = buildRow(12, ["N", "   ", "2", ""], ["name", "external_id", "qty", "note"], withText);

    expect(buildUpdateInput(row)).toEqual({ name: "N", qty: 2, note: "" });
    expect(buildUpdateInput(row)).not.toHaveProperty("external_id");
    expect(buildCreateInput(row, { rights_mode: "private" })).not.toHaveProperty("external_id");
  });

  it("I7: keeps a non-blank external_id", () => {
    const row = buildRow(13, ["N", "X7", "2"], ["name", "external_id", "qty"], fields);
    expect(buildUpdateInput(row)).toEqual({ name: "N", external_id: "X7", qty: 2 });
  });

  it("C2: never puts RBAC on the create input -- item tables have no such column", () => {
    const row = buildRow(8, ["N", "", ""], ["name", "external_id", "qty"], fields);
    expect(buildCreateInput(row, { rights_mode: "private" })).not.toHaveProperty("RBAC");
    expect(
      buildCreateInput(row, {
        rights_mode: "users",
        users: [{ id: 1, rights: "write" }],
        roles: [],
        teams: [],
      }),
    ).not.toHaveProperty("RBAC");
  });

  it("C2: exposes the batch's grants separately, for grant-based rights modes only", () => {
    expect(rbacGrantsFor({ rights_mode: "private" })).toBeUndefined();
    expect(rbacGrantsFor({ rights_mode: "public", users: [{ id: 1, rights: "write" }] })).toBeUndefined();
    expect(
      rbacGrantsFor({
        rights_mode: "users",
        users: [{ id: 1, rights: "write" }],
        roles: [],
        teams: [],
      }),
    ).toEqual({ users: [{ id: 1, rights: "write" }], roles: [], teams: [] });
    expect(rbacGrantsFor({ rights_mode: "roles", roles: [{ id: "r1", rights: "read" }] })).toEqual({
      users: undefined,
      roles: [{ id: "r1", rights: "read" }],
      teams: undefined,
    });
  });

  it("allows an unmapped required column on an update row (only touched columns need to be present)", () => {
    // external_id is mapped and set -> this row is a tentative update; name
    // is not mapped at all, so it is not this CSV's concern.
    const row = buildRow(9, ["X9"], ["external_id"], fields);
    expect(rowAction(row)).toEqual({ action: "update", by: "external_id", key: "X9" });
    expect(rowIsValid(row)).toBe(true);
    expect(row.errors).toEqual([]);
  });

  it("flags an unmapped required column on a create row (no id/external_id present)", () => {
    const row = buildRow(10, ["2"], ["qty"], fields);
    expect(rowAction(row)).toEqual({ action: "create" });
    expect(rowIsValid(row)).toBe(false);
    expect(row.errors).toEqual(["required:name"]);
  });

  it("still flags a mapped-but-blank required column on an update row", () => {
    const row = buildRow(11, ["", "X5", "3"], ["name", "external_id", "qty"], fields);
    expect(rowAction(row)).toEqual({ action: "update", by: "external_id", key: "X5" });
    expect(rowIsValid(row)).toBe(false);
    expect(row.errors).toEqual(["required:name"]);
  });
});
