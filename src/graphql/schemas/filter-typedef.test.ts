/**
 * Security regression: guest_password_hash must never appear in any
 * generated GraphQL Filter input type (spec §7).  A queryable filter
 * criterion would allow clients to use boolean / timing oracles to
 * enumerate or probe stored bcrypt hashes.
 */
import { createExuluContextsFilterTypeDefs } from "./index";
import type { ExuluTableDefinition } from "@EXULU_TYPES/exulu-table-definition";

const agentTable: ExuluTableDefinition = {
  name: { singular: "agent", plural: "agents" },
  fields: [
    { name: "id", type: "string" },
    { name: "name", type: "string" },
    { name: "guest_access", type: "string" },
    { name: "guest_auth_mode", type: "string" },
    // The hash must be excluded from filter types even though it is a real DB column.
    { name: "guest_password_hash", type: "string" },
  ],
};

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
