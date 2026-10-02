import { sanitizeItemRightsMode } from "./context";

/**
 * Guards createItem() — a low-level path (tools/workers/sync jobs call it
 * directly, bypassing the GraphQL mutation's own rights_mode validation).
 * Root-caused an ALGI incident (2026-09-22): ~68% of ersatzteil_katalog_items
 * had rights_mode literally set to the table's own name, making them
 * invisible to every non-super-admin caller with no error anywhere.
 */
describe("sanitizeItemRightsMode — never lets a bad rights_mode reach the DB", () => {
  it("passes through every valid mode unchanged", () => {
    for (const mode of ["private", "users", "roles", "teams", "public"] as const) {
      expect(sanitizeItemRightsMode(mode)).toBe(mode);
    }
  });

  it("falls back to the context default when given garbage (the actual incident shape)", () => {
    expect(sanitizeItemRightsMode("ersatzteil_katalog_items", "roles")).toBe("roles");
  });

  it("falls back to 'private' when no context default is configured", () => {
    expect(sanitizeItemRightsMode("garbage")).toBe("private");
  });

  it("leaves null/undefined alone — the DB column default applies, not this function's", () => {
    expect(sanitizeItemRightsMode(null)).toBeNull();
    expect(sanitizeItemRightsMode(undefined)).toBeUndefined();
  });

  it("rejects a non-string value (e.g. an accidental object) the same as any other invalid value", () => {
    expect(sanitizeItemRightsMode({ not: "a mode" }, "roles")).toBe("roles");
  });
});
