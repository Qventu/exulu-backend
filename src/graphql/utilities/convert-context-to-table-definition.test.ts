/**
 * Task 4 fix round 2, Critical: convertContextToTableDefinition mapped each
 * field through an explicit allowlist with no spread -- `schema` was not in
 * it, so every context item table reaching createMutations/createQueries
 * (and vector-search.ts's filter path, Task 5) saw `schema: undefined`
 * regardless of what the context actually declared. The GraphQL write path
 * therefore never validated or refused anything on a context field: it
 * merged and stored unvalidated values while the tool path (which reads
 * `field.schema` directly off `this.fields`, never through this converter)
 * refused the identical input. This is the second time this function has
 * silently dropped a field property with consequences -- `hidden` (a
 * write-only-secret flag) was the first, and it leaked secrets (see
 * reference_context_hidden_fields_not_enforced.md) -- so this file exists
 * to pin `schema` down the same way, and to make the allowlist's shape
 * itself visible so the NEXT dropped property gets caught here too.
 */
jest.mock("@SRC/exulu/context", () => ({
  getTableName: (id: string) => `${id}_items`,
}));
jest.mock("@SRC/postgres/core-schema", () => ({
  // addCoreFields appends platform-managed columns (rbac, timestamps, ...);
  // irrelevant to what this test is about, so pass the definition through
  // unchanged rather than pulling in @EE/schemas for real.
  addCoreFields: (def: any) => def,
}));

import { z } from "zod";
import { convertContextToTableDefinition } from "./convert-context-to-table-definition";

describe("convertContextToTableDefinition", () => {
  it("carries a field's declared schema through to the table definition", () => {
    const felderSchema = z.record(z.string(), z.object({ wert: z.string() }));
    const context: any = {
      id: "docs",
      processor: undefined,
      fields: [
        { name: "felder", type: "json", schema: felderSchema },
        { name: "notes", type: "json" }, // no schema -- still undefined, correctly
      ],
    };

    const table = convertContextToTableDefinition(context);

    const felder = table.fields.find((f) => f.name === "felder");
    const notes = table.fields.find((f) => f.name === "notes");
    expect(felder?.schema).toBe(felderSchema); // same reference, not a rebuild
    expect(notes?.schema).toBeUndefined();
  });

  it("every other allowlisted property still survives (this file does not regress the rest of the mapping)", () => {
    const context: any = {
      id: "docs",
      processor: undefined,
      fields: [
        {
          name: "Category",
          type: "enum",
          required: true,
          default: "A",
          index: true,
          enumValues: ["A", "B"],
          allowedFileTypes: ["pdf"],
          unique: true,
        },
      ],
    };

    const table = convertContextToTableDefinition(context);
    const field = table.fields.find((f) => f.name === "category"); // sanitizeName lowercases

    expect(field).toMatchObject({
      type: "enum",
      required: true,
      default: "A",
      index: true,
      enumValues: ["A", "B"],
      allowedFileTypes: ["pdf"],
      unique: true,
    });
  });
});
