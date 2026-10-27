/**
 * Wiring gate for agentSessionMarkSeen: the SDL declaration and the resolver
 * have to exist together, and the resolver has to be registered on the
 * agent_sessions pass of createMutations (that is also how it gets the table
 * definition applyAccessControl needs).
 *
 * The declaration is asserted against the source text, the way
 * core-schema.test.ts asserts routes.ts's createSDL list: the generated SDL
 * cannot be built from a subset of tables (the global defs reference types
 * from every other table), and nothing in the tree builds the full one.
 *
 * The mock block below is the createMutations import harness copied from
 * set-transcripts-settings.test.ts — index.ts pulls in the whole platform.
 */
jest.mock("@SRC/exulu/context", () => ({
  getChunksTableName: (id: string) => `${id}_chunks`,
  getTableName: (id: string) => id,
}));
jest.mock("@SRC/exulu/entities", () => ({
  resolveEntityModel: jest.fn(),
  setEntityModelSetting: jest.fn(),
}));
jest.mock("@SRC/exulu/statistics", () => ({ updateStatistic: jest.fn() }));
jest.mock("@SRC/graphql/resolvers/utils", () => ({
  contextItemsProcessorHandler: jest.fn(),
  getRequestedFields: jest.fn(() => []),
}));
jest.mock("@SRC/auth/generate-key.ts", () => ({ SALT_ROUNDS: 10 }));
jest.mock("@SRC/graphql/resolvers/apply-filters.ts", () => ({ applyFilters: jest.fn() }));
jest.mock("@SRC/graphql/utilities/validate-super-admin-update.ts", () => ({
  validateCreateOrRemoveSuperAdminPermission: jest.fn(async () => {}),
}));
jest.mock("@SRC/graphql/utilities/encrypt-sensitive-fields.ts", () => ({
  encryptSensitiveFields: (input: any) => input,
}));
jest.mock("@SRC/graphql/utilities/sanitize-and-hydrate-fields.ts", () => ({
  finalizeRequestedFields: jest.fn((f: any) => f),
}));
jest.mock("@SRC/exulu/routines/run-state.ts", () => ({ cancelRoutineRunRow: jest.fn() }));
jest.mock("@EE/queues/queues", () => ({ queues: {} }));
jest.mock("@SRC/graphql/resolvers/index.ts", () => ({
  itemsPaginationRequest: jest.fn(),
  sanitizeRequestedFields: jest.fn((f: any) => f),
}));
jest.mock("@EE/rbac-update.ts", () => ({ handleRBACUpdate: jest.fn() }));

const updates: any[] = [];
let sessionIsVisible = true;

jest.mock("@SRC/postgres/client", () => ({
  postgresClient: jest.fn(async () => {
    const query: any = {
      where: () => query,
      select: () => query,
      first: async () => (sessionIsVisible ? { id: "session-1" } : undefined),
    };
    const db: any = (_table: string) => ({
      where: () => ({
        update: async (patch: any) => {
          updates.push(patch);
          return 1;
        },
      }),
    });
    db.from = () => query;
    return { db };
  }),
}));

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createMutations } from "./index";

const agentSessionsTable: any = {
  name: { singular: "agent_session", plural: "agent_sessions" },
  type: "model",
  RBAC: true,
  fields: [],
};
const otherTable: any = {
  name: { singular: "agent", plural: "agents" },
  type: "model",
  fields: [],
};

afterEach(() => {
  updates.length = 0;
  sessionIsVisible = true;
});

describe("agentSessionMarkSeen wiring", () => {
  it("is declared in the generated SDL", () => {
    const source = readFileSync(join(__dirname, "..", "schemas", "index.ts"), "utf8");
    expect(source).toContain("agentSessionMarkSeen(id: ID!): Boolean!");
  });

  it("is registered on the agent_sessions pass", () => {
    const mutations = createMutations(agentSessionsTable, [], [], {} as any);
    expect(typeof mutations["agentSessionMarkSeen"]).toBe("function");
  });

  it("is not registered for unrelated tables", () => {
    const mutations = createMutations(otherTable, [], [], {} as any);
    expect(mutations["agentSessionMarkSeen"]).toBeUndefined();
  });

  it("stamps last_seen_at for a caller who can open the session", async () => {
    const mutations = createMutations(agentSessionsTable, [], [], {} as any);

    await expect(
      mutations["agentSessionMarkSeen"](null, { id: "session-1" }, { user: { id: 7 } }, {}),
    ).resolves.toBe(true);
    expect(updates).toHaveLength(1);
    expect(updates[0].last_seen_at).toBeInstanceOf(Date);
  });

  it("stamps nothing for a caller who cannot open the session", async () => {
    sessionIsVisible = false;
    const mutations = createMutations(agentSessionsTable, [], [], {} as any);

    await expect(
      mutations["agentSessionMarkSeen"](null, { id: "session-1" }, { user: { id: 7 } }, {}),
    ).resolves.toBe(false);
    expect(updates).toEqual([]);
  });
});
