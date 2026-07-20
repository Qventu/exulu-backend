/**
 * Unit tests for the assertAllowedField / groupableFields helpers.
 *
 * These cover the security contract: hidden fields and unknown fields are
 * rejected; non-hidden fields and the synthetic id/createdAt/updatedAt
 * columns are always accepted.
 */

import { assertAllowedField, groupableFields } from "./field-allow-list";
import type { ExuluTableDefinition } from "@EXULU_TYPES/exulu-table-definition";

// ---------------------------------------------------------------------------
// Fixture table that mirrors a cut-down users table with hidden secrets.
// ---------------------------------------------------------------------------

const usersTable: ExuluTableDefinition = {
  name: { singular: "user", plural: "users" },
  fields: [
    { name: "email", type: "text" },
    { name: "name", type: "text" },
    { name: "role", type: "text" },
    // write-only secrets — must be rejected
    { name: "password", type: "text", hidden: true },
    { name: "apikey", type: "text", hidden: true },
    { name: "anthropic_token", type: "text", hidden: true },
    { name: "temporary_token", type: "text", hidden: true },
  ],
};

// ---------------------------------------------------------------------------
// groupableFields
// ---------------------------------------------------------------------------

describe("groupableFields", () => {
  let allowed: Set<string>;

  beforeAll(() => {
    allowed = groupableFields(usersTable);
  });

  test("non-hidden field 'email' is in the allow-list", () => {
    expect(allowed.has("email")).toBe(true);
  });

  test("non-hidden field 'name' is in the allow-list", () => {
    expect(allowed.has("name")).toBe(true);
  });

  test("'id' is always in the allow-list", () => {
    expect(allowed.has("id")).toBe(true);
  });

  test("'createdAt' is always in the allow-list", () => {
    expect(allowed.has("createdAt")).toBe(true);
  });

  test("'updatedAt' is always in the allow-list", () => {
    expect(allowed.has("updatedAt")).toBe(true);
  });

  test("hidden field 'password' is NOT in the allow-list", () => {
    expect(allowed.has("password")).toBe(false);
  });

  test("hidden field 'apikey' is NOT in the allow-list", () => {
    expect(allowed.has("apikey")).toBe(false);
  });

  test("hidden field 'anthropic_token' is NOT in the allow-list", () => {
    expect(allowed.has("anthropic_token")).toBe(false);
  });

  test("unknown field 'nonexistent_column' is NOT in the allow-list", () => {
    expect(allowed.has("nonexistent_column")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// assertAllowedField — group label
// ---------------------------------------------------------------------------

describe("assertAllowedField (label: group)", () => {
  test("non-hidden field 'name' is accepted", () => {
    expect(() => assertAllowedField(usersTable, "name", "group")).not.toThrow();
  });

  test("'id' is accepted", () => {
    expect(() => assertAllowedField(usersTable, "id", "group")).not.toThrow();
  });

  test("'createdAt' is accepted", () => {
    expect(() => assertAllowedField(usersTable, "createdAt", "group")).not.toThrow();
  });

  test("'updatedAt' is accepted", () => {
    expect(() => assertAllowedField(usersTable, "updatedAt", "group")).not.toThrow();
  });

  test("hidden field 'password' throws with correct message", () => {
    expect(() => assertAllowedField(usersTable, "password", "group")).toThrow(
      'Cannot group by "password".',
    );
  });

  test("hidden field 'apikey' throws", () => {
    expect(() => assertAllowedField(usersTable, "apikey", "group")).toThrow(
      'Cannot group by "apikey".',
    );
  });

  test("unknown field 'secret_col' throws", () => {
    expect(() => assertAllowedField(usersTable, "secret_col", "group")).toThrow(
      'Cannot group by "secret_col".',
    );
  });
});

// ---------------------------------------------------------------------------
// assertAllowedField — sort label
// ---------------------------------------------------------------------------

describe("assertAllowedField (label: sort)", () => {
  test("non-hidden field 'email' is accepted for sort", () => {
    expect(() => assertAllowedField(usersTable, "email", "sort")).not.toThrow();
  });

  test("hidden field 'temporary_token' throws with sort message", () => {
    expect(() => assertAllowedField(usersTable, "temporary_token", "sort")).toThrow(
      'Cannot sort by "temporary_token".',
    );
  });

  test("unknown field 'unknown_field' throws with sort message", () => {
    expect(() => assertAllowedField(usersTable, "unknown_field", "sort")).toThrow(
      'Cannot sort by "unknown_field".',
    );
  });
});
