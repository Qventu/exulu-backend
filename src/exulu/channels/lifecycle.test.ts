import { afterUserDelete, afterUserDeleteBestEffort, channelLinksForExport } from "./lifecycle";

const LICENCE = "EXULU_ENTERPRISE_LICENSE";
let saved: string | undefined;
beforeEach(() => {
  saved = process.env[LICENCE];
});
afterEach(() => {
  if (saved === undefined) delete process.env[LICENCE];
  else process.env[LICENCE] = saved;
});
const licensed = () => {
  process.env[LICENCE] = "EXULU_EE_test";
};
const unlicensed = () => {
  delete process.env[LICENCE];
};

/** Records every query; throws like Postgres when the channel table does not exist. */
const strictDb = (rows: any[] = []) => {
  const queries: string[] = [];
  const db: any = (table: string) => {
    queries.push(table);
    if (table !== "channel_links") throw new Error(`unexpected table ${table}`);
    let where: Record<string, unknown> = {};
    const q: any = {
      where: (w: any) => ((where = { ...where, ...w }), q),
      orderBy: () => q,
      del: async () => {
        const hit = rows.filter((r) => Object.entries(where).every(([k, v]) => r[k] === v));
        hit.forEach((r) => rows.splice(rows.indexOf(r), 1));
        return hit.length;
      },
      then: (res: any, rej: any) =>
        Promise.resolve(rows.filter((r) => Object.entries(where).every(([k, v]) => r[k] === v))).then(res, rej),
    };
    return q;
  };
  return { db, queries, rows };
};
const throwingDb = () => {
  const queries: string[] = [];
  const db: any = (table: string) => {
    queries.push(table);
    throw new Error(`relation "channel_links" does not exist`);
  };
  return { db, queries };
};

const row = (o: any) => ({
  id: "l1",
  channel: "c1",
  identity: "4915112345678",
  user: 7,
  linked_at: new Date("2026-11-16T10:00:00Z"),
  expires_at: new Date("2026-11-23T10:00:00Z"),
  revoked_at: null,
  last_seen_at: null,
  ...o,
});

describe("channelLinksForExport", () => {
  it("returns the user's links across channels with the FULL identity", async () => {
    licensed();
    const { db } = strictDb([row({}), row({ id: "l2", channel: "c2" }), row({ id: "l3", user: 8 })]);
    const out = await channelLinksForExport(db, 7);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({
      channel: "c1",
      identity: "4915112345678",
      linked_at: new Date("2026-11-16T10:00:00Z"),
      expires_at: new Date("2026-11-23T10:00:00Z"),
      revoked_at: null,
      last_seen_at: null,
    });
    expect(out.map((l: any) => l.channel).sort()).toEqual(["c1", "c2"]);
  });

  it("without the licence makes zero queries and returns an empty section", async () => {
    unlicensed();
    const { db, queries } = throwingDb();
    await expect(channelLinksForExport(db, 7)).resolves.toEqual([]);
    expect(queries).toEqual([]);
  });

  it("a failing query yields an empty section and logs only name/code", async () => {
    licensed();
    const error = jest.spyOn(console, "error").mockImplementation(() => {});
    const { db } = throwingDb();
    await expect(channelLinksForExport(db, 7)).resolves.toEqual([]);
    expect(error).toHaveBeenCalled();
    expect(JSON.stringify(error.mock.calls)).not.toContain("channel_links");
    error.mockRestore();
  });
});

describe("afterUserDelete", () => {
  it("hard-deletes every link of the user, in every channel, and only theirs", async () => {
    licensed();
    const { db, rows } = strictDb([row({}), row({ id: "l2", channel: "c2" }), row({ id: "l3", user: 8 })]);
    await afterUserDelete(db, 7);
    expect(rows.map((r) => r.id)).toEqual(["l3"]);
  });

  it("without the licence makes zero queries and never throws", async () => {
    unlicensed();
    const { db, queries } = throwingDb();
    await expect(afterUserDelete(db, 7)).resolves.toBeUndefined();
    await expect(afterUserDeleteBestEffort(db, 7)).resolves.toBeUndefined();
    expect(queries).toEqual([]);
  });

  it("licensed: errors propagate (so the surrounding transaction rolls back)", async () => {
    licensed();
    const { db } = throwingDb();
    await expect(afterUserDelete(db, 7)).rejects.toThrow();
  });

  it("best-effort variant swallows the error and logs only name/code", async () => {
    licensed();
    const error = jest.spyOn(console, "error").mockImplementation(() => {});
    const { db } = throwingDb();
    await expect(afterUserDeleteBestEffort(db, 7)).resolves.toBeUndefined();
    expect(error).toHaveBeenCalled();
    expect(JSON.stringify(error.mock.calls)).not.toContain("channel_links");
    error.mockRestore();
  });

  it("ignores a non-numeric user id without querying", async () => {
    licensed();
    const { db, queries } = throwingDb();
    await afterUserDelete(db, "abc" as any);
    expect(queries).toEqual([]);
  });
});
