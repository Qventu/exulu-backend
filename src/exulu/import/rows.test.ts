import { buildCreateInput, buildRow, buildUpdateInput, rowAction, rowIsValid } from "./rows";
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
    expect(buildUpdateInput(row)).toEqual({ name: "N", external_id: "", qty: 2 });
    expect(buildCreateInput(row, { rights_mode: "private" })).toEqual({
      name: "N",
      external_id: "",
      qty: 2,
      rights_mode: "private",
    });
  });

  it("merges RBAC grants for grant-based rights modes only", () => {
    const row = buildRow(8, ["N", "", ""], ["name", "external_id", "qty"], fields);
    expect(buildCreateInput(row, { rights_mode: "private" })).not.toHaveProperty("RBAC");
    expect(
      buildCreateInput(row, {
        rights_mode: "users",
        users: [{ id: 1, rights: "write" }],
        roles: [],
        teams: [],
      }),
    ).toMatchObject({
      rights_mode: "users",
      RBAC: { users: [{ id: 1, rights: "write" }], roles: [], teams: [] },
    });
  });

  it("flags a required field that was never mapped at all", () => {
    const row = buildRow(9, ["X9"], ["external_id"], fields);
    expect(rowIsValid(row)).toBe(false);
    expect(row.errors).toEqual(["required:name"]);
  });
});
