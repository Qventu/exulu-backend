import { autoMapColumns, importFieldsFor, normalizeHeader, resolveMapping } from "./mapping";

describe("normalizeHeader", () => {
  it("lowercases, trims, and unifies space/dash separators to underscores", () => {
    expect(normalizeHeader(" Description_Long-de_ch ")).toBe("description_long_de_ch");
  });
});

describe("autoMapColumns", () => {
  it("matches headers to fields by name, leaving unmatched columns null", () => {
    expect(
      autoMapColumns(
        ["Item Number", "brand", "unknown"],
        [
          { name: "item_number", type: "shortText" },
          { name: "brand", type: "shortText" },
        ],
      ),
    ).toEqual([
      { header: "Item Number", fieldName: "item_number" },
      { header: "brand", fieldName: "brand" },
      { header: "unknown", fieldName: null },
    ]);
  });

  it("matches by label when the name does not match", () => {
    expect(
      autoMapColumns(["Brand Name"], [{ name: "brand", label: "Brand Name", type: "shortText" }]),
    ).toEqual([{ header: "Brand Name", fieldName: "brand" }]);
  });

  it("never maps the same field to two columns", () => {
    expect(autoMapColumns(["brand", "brand"], [{ name: "brand", type: "shortText" }])).toEqual([
      { header: "brand", fieldName: "brand" },
      { header: "brand", fieldName: null },
    ]);
  });
});

describe("resolveMapping", () => {
  it("auto-maps when no mapping is given", () => {
    expect(resolveMapping(["brand"], [{ name: "brand", type: "shortText" }])).toEqual({
      byIndex: ["brand"],
      unknownFields: [],
    });
  });

  it("validates a given mapping against the headers/fields, collecting unknown field names", () => {
    expect(
      resolveMapping(
        ["a", "b"],
        [{ name: "a", type: "text" }],
        [
          { header: "a", fieldName: "a" },
          { header: "b", fieldName: "nope" },
        ],
      ),
    ).toEqual({ byIndex: ["a", null], unknownFields: ["nope"] });
  });

  it("leaves a header unmapped when the given mapping has no entry for it", () => {
    expect(
      resolveMapping(["a", "b"], [{ name: "a", type: "text" }], [{ header: "a", fieldName: "a" }]),
    ).toEqual({ byIndex: ["a", null], unknownFields: [] });
  });
});

describe("importFieldsFor", () => {
  it("prepends the built-in fields and drops calculated/hidden/file context fields", () => {
    expect(
      importFieldsFor([
        { name: "report", type: "text", calculated: true },
        { name: "secret", type: "text", hidden: true },
        { name: "photo", type: "file" },
        { name: "x", type: "shortText" },
      ]).map((f) => f.name),
    ).toEqual(["id", "external_id", "name", "description", "tags", "x"]);
  });

  it("marks name as required and everything else as not required by default", () => {
    const fields = importFieldsFor([]);
    const byName = new Map(fields.map((f) => [f.name, f]));
    expect(byName.get("name")?.required).toBe(true);
    expect(byName.get("external_id")?.required).toBeFalsy();
  });

  it("carries required and enumValues through from context field definitions", () => {
    const fields = importFieldsFor([
      { name: "size", type: "enum", enumValues: ["S", "M"], required: true },
    ]);
    const size = fields.find((f) => f.name === "size");
    expect(size).toMatchObject({
      name: "size",
      type: "enum",
      required: true,
      enumValues: ["S", "M"],
      core: false,
    });
  });

  it("marks built-in fields as core", () => {
    const fields = importFieldsFor([]);
    expect(fields.every((f) => f.core)).toBe(true);
  });
});
