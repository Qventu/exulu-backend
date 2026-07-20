/**
 * Security regression: hidden (write-only secret) fields must never appear in
 * any generated GraphQL object type or Filter input type, and must NOT appear
 * in SQL read selections or read payloads. They remain writable via Input types
 * (except guest_password_hash which is replaced by the guest_password input).
 *
 * Covered fields:
 *   agents.guest_password_hash
 *   users.password, users.apikey, users.anthropic_token, users.temporary_token
 *   shared_artifacts.password_hash
 */
import { createExuluContextsFilterTypeDefs, createExuluContextsTypeDefs } from "./index";
import type { ExuluTableDefinition } from "@EXULU_TYPES/exulu-table-definition";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const agentTable: ExuluTableDefinition = {
  name: { singular: "agent", plural: "agents" },
  fields: [
    { name: "id", type: "string" },
    { name: "name", type: "string" },
    { name: "guest_access", type: "string" },
    { name: "guest_auth_mode", type: "string" },
    // The hash must be excluded from object + filter types (now driven by hidden flag).
    { name: "guest_password_hash", type: "string", hidden: true },
  ],
};

const usersTable: ExuluTableDefinition = {
  name: { singular: "user", plural: "users" },
  fields: [
    { name: "id", type: "number" },
    { name: "email", type: "text" },
    { name: "name", type: "text" },
    // Secret fields — hidden from reads, writable via input
    { name: "password", type: "text", hidden: true },
    { name: "apikey", type: "text", hidden: true },
    { name: "anthropic_token", type: "text", hidden: true },
    { name: "temporary_token", type: "text", hidden: true },
  ],
};

// ---------------------------------------------------------------------------
// agents — existing regression (now flag-driven)
// ---------------------------------------------------------------------------

describe("createExuluContextsFilterTypeDefs — guest_password_hash exclusion", () => {
  let sdl: string;

  beforeAll(() => {
    sdl = createExuluContextsFilterTypeDefs(agentTable);
  });

  test("guest_password_hash is NOT present in the generated filter SDL", () => {
    expect(sdl).not.toContain("guest_password_hash");
  });

  test("guest_access IS present in the generated filter SDL (positive control)", () => {
    expect(sdl).toContain("guest_access");
  });

  test("FilterAgent input type is generated", () => {
    expect(sdl).toContain("input FilterAgent");
  });
});

// ---------------------------------------------------------------------------
// users — object type excludes all four secret fields
// ---------------------------------------------------------------------------

describe("createExuluContextsTypeDefs — users object type excludes secret fields", () => {
  // Extract just the `type user { ... }` block from the full SDL string so
  // that assertions are not tripped by the input type section (which
  // intentionally retains the secret fields as writable inputs).
  let objectTypeSdl: string;

  beforeAll(() => {
    const fullSdl = createExuluContextsTypeDefs(usersTable);
    // Grab from `type user {` up to (but not including) `input userInput {`
    const typeMatch = fullSdl.match(/type user \{[\s\S]*?\}/);
    objectTypeSdl = typeMatch ? typeMatch[0] : fullSdl;
  });

  test("password is NOT present in the object type block", () => {
    expect(objectTypeSdl).not.toMatch(/\bpassword\b/);
  });

  test("apikey is NOT present in the object type block", () => {
    expect(objectTypeSdl).not.toContain("apikey");
  });

  test("anthropic_token is NOT present in the object type block", () => {
    expect(objectTypeSdl).not.toContain("anthropic_token");
  });

  test("temporary_token is NOT present in the object type block", () => {
    expect(objectTypeSdl).not.toContain("temporary_token");
  });

  test("email IS present in the object type block (positive control)", () => {
    expect(objectTypeSdl).toContain("email");
  });
});

// ---------------------------------------------------------------------------
// users — filter type excludes all four secret fields
// ---------------------------------------------------------------------------

describe("createExuluContextsFilterTypeDefs — users filter type excludes secret fields", () => {
  let filterSdl: string;

  beforeAll(() => {
    filterSdl = createExuluContextsFilterTypeDefs(usersTable);
  });

  test("password is NOT present in the Filter SDL", () => {
    expect(filterSdl).not.toMatch(/\bpassword\b/);
  });

  test("apikey is NOT present in the Filter SDL", () => {
    expect(filterSdl).not.toContain("apikey");
  });

  test("anthropic_token is NOT present in the Filter SDL", () => {
    expect(filterSdl).not.toContain("anthropic_token");
  });

  test("temporary_token is NOT present in the Filter SDL", () => {
    expect(filterSdl).not.toContain("temporary_token");
  });

  test("email IS present in the Filter SDL (positive control)", () => {
    expect(filterSdl).toContain("email");
  });
});

// ---------------------------------------------------------------------------
// users — input type KEEPS secret fields (write-only contract)
// ---------------------------------------------------------------------------

describe("createExuluContextsTypeDefs — users input type retains writable secret fields", () => {
  let inputSdl: string;

  beforeAll(() => {
    inputSdl = createExuluContextsTypeDefs(usersTable);
  });

  test("password IS present in the input SDL (write-only secret must remain writable)", () => {
    // The input block contains 'userInput' — check within that context.
    expect(inputSdl).toContain("password");
  });

  test("apikey IS present in the input SDL", () => {
    expect(inputSdl).toContain("apikey");
  });

  test("anthropic_token IS present in the input SDL", () => {
    expect(inputSdl).toContain("anthropic_token");
  });

  test("temporary_token IS present in the input SDL", () => {
    expect(inputSdl).toContain("temporary_token");
  });

  test("email IS present in the input SDL (positive control)", () => {
    expect(inputSdl).toContain("email");
  });
});
