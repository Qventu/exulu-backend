/**
 * The generic agent mutations keep the WhatsApp channel consistent with the agent:
 * a write touching guest_access / guest_auth_mode re-checks whether the agent can still
 * carry a channel (syncChannelsWithGuestAccess), and deleting an agent removes its
 * channels and links (no foreign keys). Same mocking approach as create-rights-mode.test.ts.
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
jest.mock("@SRC/graphql/utilities/access-control", () => ({
  applyAccessControl: jest.fn((_t: any, q: any) => q),
}));
jest.mock("@SRC/auth/generate-key.ts", () => ({ SALT_ROUNDS: 10 }));
jest.mock("@SRC/postgres/client", () => ({ postgresClient: jest.fn() }));
jest.mock("@SRC/graphql/resolvers/apply-filters.ts", () => ({
  applyFilters: jest.fn((q: any) => q),
}));
jest.mock("@SRC/graphql/utilities/validate-super-admin-update.ts", () => ({
  validateCreateOrRemoveSuperAdminPermission: jest.fn(async () => {}),
}));
jest.mock("@SRC/graphql/utilities/encrypt-sensitive-fields.ts", () => ({
  encryptSensitiveFields: (input: any) => input,
}));
jest.mock("@SRC/graphql/utilities/sanitize-and-hydrate-fields.ts", () => ({
  finalizeRequestedFields: jest.fn((f: any) => f),
}));
jest.mock("@SRC/exulu/routines/run-state.ts", () => ({
  cancelRoutineRunRow: jest.fn(),
}));
jest.mock("@EE/queues/queues", () => ({ queues: {} }));
jest.mock("@SRC/graphql/resolvers/index.ts", () => ({
  itemsPaginationRequest: jest.fn(),
  sanitizeRequestedFields: jest.fn((f: any) => f),
}));
jest.mock("@EE/rbac-update.ts", () => ({ handleRBACUpdate: jest.fn() }));
jest.mock("@SRC/exulu/channels/api", () => ({
  syncChannelsWithGuestAccess: jest.fn(async () => {}),
  deleteChannelsForAgent: jest.fn(async () => {}),
}));

import { deleteChannelsForAgent, syncChannelsWithGuestAccess } from "@SRC/exulu/channels/api";
import { createMutations } from "./index";

const AGENT_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const agentsTable: any = { name: { singular: "agent", plural: "agents" }, type: "agents", RBAC: true, fields: [] };
const presetsTable: any = { name: { singular: "preset", plural: "presets" }, type: "presets", RBAC: true, fields: [] };

const stored = { id: AGENT_ID, guest_access: false, guest_auth_mode: "regular", rights_mode: "private" };

// Chainable knex-like mock covering the reads and writes of the four mutations.
function makeDb() {
  const query = (_table: string) => {
    const q: any = {
      select: () => q,
      where: () => q,
      first: async () => ({ ...stored }),
      columnInfo: async () => ({ id: {}, guest_access: {}, guest_auth_mode: {} }),
      update: () => {
        const p: any = Promise.resolve(1);
        p.returning = async () => [{ ...stored }];
        return p;
      },
      del: async () => 1,
      // insert(...).returning(cols), optionally .onConflict().merge(), then awaited
      insert: () => {
        const built: any = {
          onConflict: () => ({ merge: () => built }),
          then: (res: any, rej: any) => Promise.resolve([{ ...stored }]).then(res, rej),
        };
        return { returning: () => built };
      },
    };
    return q;
  };
  return Object.assign((t: string) => query(t), { from: (t: string) => query(t), fn: { uuid: () => AGENT_ID } });
}

const ctx = (db: any) => ({ db, user: { id: 1, super_admin: true, role: { id: "r" } }, req: {} });
const agents = createMutations(agentsTable, [], [], [], {} as any);
const presets = createMutations(presetsTable, [], [], [], {} as any);

beforeEach(() => jest.clearAllMocks());

describe("agent writes re-check the channel", () => {
  it.each([
    ["agentsUpdateOneById", { id: AGENT_ID }],
    ["agentsUpdateOne", { where: [{ id: { eq: AGENT_ID } }] }],
    ["agentsCreateOne", { upsert: true }],
  ])("%s with guest_access syncs the channel with the stored agent row", async (name, extra) => {
    const db = makeDb();
    await agents[name](null, { ...extra, input: { guest_access: false } }, ctx(db), {});
    expect(syncChannelsWithGuestAccess).toHaveBeenCalledWith(db, expect.objectContaining({ id: AGENT_ID, guest_access: false }));
  });

  it("guest_auth_mode alone also triggers it", async () => {
    const db = makeDb();
    await agents["agentsUpdateOneById"](null, { id: AGENT_ID, input: { guest_auth_mode: "public" } }, ctx(db), {});
    expect(syncChannelsWithGuestAccess).toHaveBeenCalledTimes(1);
  });

  it("an update without guest fields, a plain create and another table do not", async () => {
    const db = makeDb();
    await agents["agentsUpdateOneById"](null, { id: AGENT_ID, input: { name: "x" } }, ctx(db), {});
    await agents["agentsCreateOne"](null, { input: { guest_access: true } }, ctx(db), {});
    await presets["presetsUpdateOneById"](null, { id: AGENT_ID, input: { guest_access: false } }, ctx(db), {});
    expect(syncChannelsWithGuestAccess).not.toHaveBeenCalled();
  });
});

describe("agent deletion removes its channels", () => {
  it.each([
    ["agentsRemoveOneById", { id: AGENT_ID }],
    ["agentsRemoveOne", { where: [{ id: { eq: AGENT_ID } }] }],
  ])("%s", async (name, args) => {
    const db = makeDb();
    await agents[name](null, args, ctx(db), {});
    expect(deleteChannelsForAgent).toHaveBeenCalledWith(db, AGENT_ID);
  });

  it("not for other tables", async () => {
    const db = makeDb();
    await presets["presetsRemoveOneById"](null, { id: AGENT_ID }, ctx(db), {});
    expect(deleteChannelsForAgent).not.toHaveBeenCalled();
  });
});
