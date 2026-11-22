/**
 * utils:initdb runs on every server and worker boot, and a throwing step is fatal there. The
 * chat SDK step (WhatsApp channels) must therefore never stop the rest of the initialiser.
 * `up` needs a live Postgres; here it runs against a permissive knex stand-in in which every
 * table and column already exists, so only the channel step can fail — and it does: the SDK
 * module cannot be loaded (jest runs CommonJS; the packages are ESM only).
 */
// licensed, as on an installation with channels: the channel tables and the SDK step are in play
const savedLicence = process.env.EXULU_ENTERPRISE_LICENSE;
process.env.EXULU_ENTERPRISE_LICENSE = "EXULU_EE_test";
afterAll(() => {
  if (savedLicence === undefined) delete process.env.EXULU_ENTERPRISE_LICENSE;
  else process.env.EXULU_ENTERPRISE_LICENSE = savedLicence;
});
const ended: unknown[] = [];
jest.mock("pg", () => ({
  Pool: jest.fn().mockImplementation(() => {
    const pool = { query: jest.fn(async () => ({ rows: [] })), end: jest.fn(async () => void ended.push(pool)), on: jest.fn() };
    return pool;
  }),
}));
jest.mock("@chat-adapter/state-pg", () => {
  throw new Error("Cannot find module '@chat-adapter/state-pg'");
}, { virtual: true });
const hydrate = jest.fn(async () => {});
jest.mock("@SRC/exulu/hydrate-embedders", () => ({ hydrateContextEmbedders: (...a: unknown[]) => hydrate(...a) }));

/** Every call and property returns the same thenable-free proxy; awaiting it yields the proxy. */
const permissiveKnex = (): any => {
  const target = function () {};
  const proxy: any = new Proxy(target, {
    get: (_t, prop) => {
      if (prop === "then") return undefined;
      if (prop === "rows") return [];
      if (prop === Symbol.iterator) return [][Symbol.iterator];
      if (prop === "length") return 0;
      if (prop === Symbol.toPrimitive) return () => "";
      return proxy;
    },
    apply: (_t, _this, args) => {
      // createTable/alterTable callbacks receive a table builder
      for (const a of args) if (typeof a === "function") a(proxy);
      return proxy;
    },
  });
  return proxy;
};
const knex = permissiveKnex();
jest.mock("./client", () => ({ postgresClient: async () => ({ db: knex }) }));

import { execute } from "./init-exulu-db";

it("a chat state step that cannot load the SDK logs one line, ends its pool, and initdb continues", async () => {
  const error = jest.spyOn(console, "error").mockImplementation(() => {});
  const log = jest.spyOn(console, "log").mockImplementation(() => {});
  try {
    await expect(execute({ contexts: [] })).resolves.toBeUndefined();
    const channelLines = error.mock.calls.filter((c) => String(c[0]).startsWith("[EXULU-CHANNEL]"));
    expect(channelLines).toHaveLength(1);
    expect(channelLines[0][0]).toBe(
      "[EXULU-CHANNEL] chat state tables not created; WhatsApp channels will not work until this succeeds",
    );
    expect(ended).toHaveLength(1);
    // the step after `up` ran
    expect(hydrate).toHaveBeenCalledWith([]);
  } finally {
    error.mockRestore();
    log.mockRestore();
  }
});
