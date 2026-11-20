/**
 * The generic agent mutations keep the WhatsApp channel consistent with the agent through
 * the REAL channels/api wrappers (afterAgentWrite / afterAgentDelete): an agent write that
 * touches guest_access / guest_auth_mode disables channels the agent can no longer carry,
 * and an agent delete removes its channels and links (no foreign keys). Without the channels
 * licence the channel tables do not exist and are never queried; a failing channel query
 * never changes the mutation's outcome. Same module mocks as create-rights-mode.test.ts.
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
  finalizeRequestedFields: jest.fn(({ result }: any) => result),
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

import { createMutations } from "./index";

const LICENSED = "EXULU_EE_test";
const AGENT_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const OTHER_AGENT = "bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const agentsTable: any = { name: { singular: "agent", plural: "agents" }, type: "agents", RBAC: true, fields: [] };
const presetsTable: any = { name: { singular: "preset", plural: "presets" }, type: "presets", RBAC: true, fields: [] };

const CHANNEL_TABLES = new Set(["agent_channels", "channel_links"]);

/**
 * knex-like fake. The agent/preset table answers the mutations' own reads and writes with
 * `stored`; the channel tables keep rows in memory (or throw, as Postgres does when they do
 * not exist). Every write is recorded as "<table>:<op>".
 */
function makeDb(opts: { stored: Record<string, unknown>; channelsFail?: boolean }) {
  const queries: string[] = [];
  const channels = {
    agent_channels: [
      { id: "c1", agent: AGENT_ID, type: "whatsapp", enabled: true },
      { id: "c2", agent: OTHER_AGENT, type: "whatsapp", enabled: true },
    ] as any[],
    channel_links: [
      { id: "l1", channel: "c1" },
      { id: "l2", channel: "c2" },
    ] as any[],
  };

  const channelQuery = (
    table: "agent_channels" | "channel_links",
    w: Record<string, unknown> = {},
    ins?: [string, unknown[]],
  ) => {
    const rows = channels[table];
    const sel = () =>
      rows.filter((r) => Object.entries(w).every(([k, v]) => r[k] === v) && (!ins || ins[1].includes(r[ins[0]])));
    const q: any = {
      where: (w2: any) => channelQuery(table, { ...w, ...w2 }, ins),
      whereIn: (col: string, vs: unknown[]) => channelQuery(table, w, [col, vs]),
      select: () => {
        queries.push(`${table}:select`);
        return q;
      },
      then: (res: any, rej: any) => Promise.resolve(sel()).then(res, rej),
      update: async (v: any) => {
        queries.push(`${table}:update`);
        sel().forEach((r) => Object.assign(r, v));
      },
      del: async () => {
        queries.push(`${table}:del`);
        sel().forEach((r) => rows.splice(rows.indexOf(r), 1));
      },
    };
    return q;
  };

  const recordQuery = (table: string) => {
    const q: any = {
      select: () => q,
      where: () => q,
      first: async () => ({ ...opts.stored }),
      columnInfo: async () => ({ id: {}, guest_access: {}, guest_auth_mode: {} }),
      update: () => {
        queries.push(`${table}:update`);
        const p: any = Promise.resolve(1);
        p.returning = async () => [{ ...opts.stored }];
        return p;
      },
      del: async () => {
        queries.push(`${table}:del`);
        return 1;
      },
      // insert(...).returning(cols), optionally .onConflict().merge(), then awaited
      insert: () => {
        queries.push(`${table}:insert`);
        const built: any = {
          onConflict: () => ({ merge: () => built }),
          then: (res: any, rej: any) => Promise.resolve([{ ...opts.stored }]).then(res, rej),
        };
        return { returning: () => built };
      },
    };
    return q;
  };

  const query = (table: string) => {
    if (CHANNEL_TABLES.has(table)) {
      queries.push(`${table}:query`);
      if (opts.channelsFail) throw new Error(`relation "${table}" does not exist`);
      return channelQuery(table as "agent_channels" | "channel_links");
    }
    return recordQuery(table);
  };
  const db = Object.assign((t: string) => query(t), { from: (t: string) => query(t), fn: { uuid: () => AGENT_ID } });
  const channelQueries = () => queries.filter((q) => CHANNEL_TABLES.has(q.split(":")[0]!));
  return { db, queries, channels, channelQueries };
}

const unpublished = { id: AGENT_ID, guest_access: false, guest_auth_mode: "regular", rights_mode: "private" };
const published = { id: AGENT_ID, guest_access: true, guest_auth_mode: "regular", rights_mode: "private" };

const ctx = (db: any) => ({ db, user: { id: 1, super_admin: true, role: { id: "r" } }, req: {} });
const agents = createMutations(agentsTable, [], [], [], {} as any);
const presets = createMutations(presetsTable, [], [], [], {} as any);

const writes: [string, Record<string, unknown>][] = [
  ["agentsUpdateOneById", { id: AGENT_ID }],
  ["agentsUpdateOne", { where: [{ id: { eq: AGENT_ID } }] }],
  ["agentsCreateOne", { upsert: true }],
];
const deletes: [string, Record<string, unknown>][] = [
  ["agentsRemoveOneById", { id: AGENT_ID }],
  ["agentsRemoveOne", { where: [{ id: { eq: AGENT_ID } }] }],
];

let errors: unknown[][];
beforeEach(() => {
  process.env.EXULU_ENTERPRISE_LICENSE = LICENSED;
  errors = [];
  jest.spyOn(console, "error").mockImplementation((...a: unknown[]) => void errors.push(a));
  jest.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  jest.restoreAllMocks();
  delete process.env.EXULU_ENTERPRISE_LICENSE;
});

describe("(a) without the channels licence the channel tables are never queried", () => {
  beforeEach(() => {
    process.env.EXULU_ENTERPRISE_LICENSE = "";
  });

  it.each(writes)("%s that unpublishes", async (name, extra) => {
    const { db, channelQueries, queries } = makeDb({ stored: unpublished });
    await agents[name](null, { ...extra, input: { guest_access: false } }, ctx(db), {});
    expect(channelQueries()).toEqual([]);
    expect(queries.length).toBeGreaterThan(0);
  });

  it.each(deletes)("%s", async (name, args) => {
    const { db, channelQueries } = makeDb({ stored: unpublished });
    await agents[name](null, args, ctx(db), {});
    expect(channelQueries()).toEqual([]);
  });
});

describe("(b) a failing channel query never changes the mutation's outcome", () => {
  it.each(writes)("%s returns its normal result and logs one safe line", async (name, extra) => {
    const { db, queries } = makeDb({ stored: unpublished, channelsFail: true });
    const out = await agents[name](null, { ...extra, input: { guest_access: false } }, ctx(db), {});
    expect(out.item).toMatchObject({ id: AGENT_ID });
    expect(queries).toContain("agent_channels:query");
    expect(errors).toHaveLength(1);
    expect(String(errors[0]![0])).toContain(AGENT_ID);
    expect(JSON.stringify(errors)).not.toContain("does not exist");
  });

  it("agentsRemoveOneById still runs the RBAC clean-up first and returns the deleted agent", async () => {
    const { db, queries } = makeDb({ stored: unpublished, channelsFail: true });
    const out = await agents["agentsRemoveOneById"](null, { id: AGENT_ID }, ctx(db), {});
    expect(out).toMatchObject({ id: AGENT_ID });
    // the existing clean-up runs before the channel clean-up, exactly as before
    expect(queries).toEqual(["agents:del", "rbac:del", "agent_channels:query"]);
    expect(errors).toHaveLength(1);
    expect(String(errors[0]![0])).toContain(AGENT_ID);
  });

  it("agentsRemoveOne returns the deleted agent", async () => {
    const { db, queries } = makeDb({ stored: unpublished, channelsFail: true });
    const out = await agents["agentsRemoveOne"](null, { where: [{ id: { eq: AGENT_ID } }] }, ctx(db), {});
    expect(out).toMatchObject({ id: AGENT_ID });
    expect(queries).toEqual(["agents:del", "agent_channels:query"]);
    expect(errors).toHaveLength(1);
  });
});

describe("(c) licensed, normal", () => {
  it.each(writes)("%s that unpublishes disables only that agent's channels", async (name, extra) => {
    const { db, channels } = makeDb({ stored: unpublished });
    await agents[name](null, { ...extra, input: { guest_access: false } }, ctx(db), {});
    expect(channels.agent_channels.map((c) => [c.id, c.enabled])).toEqual([
      ["c1", false],
      ["c2", true],
    ]);
    expect(channels.agent_channels[0].updatedAt).toBeInstanceOf(Date);
  });

  it("switching guest_auth_mode away from regular disables too", async () => {
    const { db, channels } = makeDb({ stored: { ...published, guest_auth_mode: "public" } });
    await agents["agentsUpdateOneById"](null, { id: AGENT_ID, input: { guest_auth_mode: "public" } }, ctx(db), {});
    expect(channels.agent_channels[0].enabled).toBe(false);
  });

  it("a write that keeps the agent published in regular mode makes no channel query", async () => {
    const { db, channels, channelQueries } = makeDb({ stored: published });
    await agents["agentsUpdateOneById"](null, { id: AGENT_ID, input: { guest_access: true } }, ctx(db), {});
    expect(channels.agent_channels[0].enabled).toBe(true);
    expect(channelQueries()).toEqual([]);
  });

  it("a write without guest fields and a plain create make no channel query", async () => {
    const { db, channelQueries } = makeDb({ stored: unpublished });
    await agents["agentsUpdateOneById"](null, { id: AGENT_ID, input: { name: "x" } }, ctx(db), {});
    await agents["agentsCreateOne"](null, { input: { guest_access: false } }, ctx(db), {});
    expect(channelQueries()).toEqual([]);
  });

  it.each(deletes)("%s removes the agent's channels with their links", async (name, args) => {
    const { db, channels } = makeDb({ stored: unpublished });
    await agents[name](null, args, ctx(db), {});
    expect(channels.agent_channels.map((c) => c.id)).toEqual(["c2"]);
    expect(channels.channel_links.map((l) => l.id)).toEqual(["l2"]);
  });
});

describe("(d) other tables make no channel query at all", () => {
  it("update, upsert and delete on presets", async () => {
    const { db, channelQueries } = makeDb({ stored: unpublished });
    await presets["presetsUpdateOneById"](null, { id: AGENT_ID, input: { guest_access: false } }, ctx(db), {});
    await presets["presetsUpdateOne"](null, { where: [{ id: { eq: AGENT_ID } }], input: { guest_access: false } }, ctx(db), {});
    await presets["presetsCreateOne"](null, { upsert: true, input: { guest_access: false } }, ctx(db), {});
    await presets["presetsRemoveOneById"](null, { id: AGENT_ID }, ctx(db), {});
    await presets["presetsRemoveOne"](null, { where: [{ id: { eq: AGENT_ID } }] }, ctx(db), {});
    expect(channelQueries()).toEqual([]);
  });
});
