import { contextFieldsForSync } from "./context-fields-for-sync";

const ctx = (fields: any[]) => ({ fields }) as any;

describe("contextFieldsForSync", () => {
  it("suffixes file fields with _s3key to match createItemsTable", () => {
    expect(contextFieldsForSync(ctx([{ name: "document", type: "file" }]))).toEqual([
      { name: "document_s3key", type: "file" },
    ]);
  });

  it("leaves non-file fields untouched", () => {
    expect(contextFieldsForSync(ctx([{ name: "language", type: "text" }]))).toEqual([
      { name: "language", type: "text" },
    ]);
  });

  it("drops fields missing a name or a type", () => {
    const out = contextFieldsForSync(
      ctx([
        { name: "keep", type: "text" },
        { name: "", type: "text" },
        { name: "no_type" },
        { type: "text" },
      ]),
    );
    expect(out).toEqual([{ name: "keep", type: "text" }]);
  });

  it("preserves default and unique so mapType can apply them", () => {
    const out = contextFieldsForSync(
      ctx([{ name: "code", type: "text", unique: true, default: "x" }]),
    );
    expect(out[0]).toMatchObject({ name: "code", unique: true, default: "x" });
  });

  it("returns an empty array for a context with no fields", () => {
    expect(contextFieldsForSync(ctx([]))).toEqual([]);
  });
});
