import { createLinkStore, expiryFor, linkState, type ChannelLink } from "./links";

const base: ChannelLink = {
  id: "l1",
  channel: "c1",
  identity: "whatsapp:+4915112345678",
  user: 7,
  linked_at: new Date("2026-11-16T10:00:00Z"),
  expires_at: new Date("2026-11-23T10:00:00Z"),
  revoked_at: null,
  last_seen_at: null,
};

describe("linkState", () => {
  it("is none without a link", () => {
    expect(linkState(undefined, new Date())).toEqual({ state: "none" });
  });
  it("is valid before expiry", () => {
    expect(linkState(base, new Date("2026-11-23T09:59:59.999Z"))).toEqual({ state: "valid", link: base });
  });
  it("is expired exactly at expires_at", () => {
    expect(linkState(base, new Date("2026-11-23T10:00:00Z"))).toEqual({ state: "expired" });
  });
  it("is expired after expiry", () => {
    expect(linkState(base, new Date("2027-01-01T00:00:00Z"))).toEqual({ state: "expired" });
  });
  it("revoked wins over an unexpired date", () => {
    const revoked = { ...base, revoked_at: new Date("2026-11-17T00:00:00Z") };
    expect(linkState(revoked, new Date("2026-11-18T00:00:00Z"))).toEqual({ state: "revoked" });
  });
  it("revoked wins over an expired date too", () => {
    const revoked = { ...base, revoked_at: new Date("2026-11-17T00:00:00Z") };
    expect(linkState(revoked, new Date("2027-01-01T00:00:00Z"))).toEqual({ state: "revoked" });
  });
  it("an unreadable expiry is expired, never valid (fails closed)", () => {
    expect(linkState({ ...base, expires_at: new Date("not a date") }, new Date("2026-11-18T00:00:00Z"))).toEqual({
      state: "expired",
    });
    expect(linkState({ ...base, expires_at: undefined as any }, new Date("2026-11-18T00:00:00Z"))).toEqual({
      state: "expired",
    });
    expect(linkState({ ...base, expires_at: "2099-01-01" as any }, new Date("2026-11-18T00:00:00Z"))).toEqual({
      state: "expired",
    });
  });
  it("an unreadable now is expired, never valid", () => {
    expect(linkState(base, new Date("not a date"))).toEqual({ state: "expired" });
  });
  it("an unreadable revoked_at on a row that has one counts as revoked", () => {
    for (const revoked_at of [new Date("not a date"), "garbage" as any, 0 as any, "" as any]) {
      expect(linkState({ ...base, revoked_at }, new Date("2026-11-18T00:00:00Z"))).toEqual({ state: "revoked" });
    }
  });
  it("a row read from the database with unreadable dates fails closed", async () => {
    const row = { ...base, expires_at: "garbage", revoked_at: null };
    const db: any = () => ({ where: () => ({ first: async () => row }) });
    const found = await createLinkStore(db).find("c1", "i");
    expect(linkState(found, new Date("2026-11-18T00:00:00Z")).state).toBe("expired");
    const revokedRow = { ...base, revoked_at: "garbage" };
    const db2: any = () => ({ where: () => ({ first: async () => revokedRow }) });
    expect(linkState(await createLinkStore(db2).find("c1", "i"), new Date("2026-11-18T00:00:00Z")).state).toBe("revoked");
  });
});

describe("expiryFor", () => {
  it("adds whole days", () => {
    expect(expiryFor(new Date("2026-11-16T10:00:00Z"), 7)).toEqual(new Date("2026-11-23T10:00:00Z"));
  });
});

// In-memory stand-in for the one table, honouring the unique (channel, identity)
// index the way Postgres' ON CONFLICT ... DO UPDATE does. No database is
// available to unit tests in this repo (see email-inbound/intake.test.ts), so the
// real SQL is not exercised here.
const fakeDb = () => {
  const rows: any[] = [];
  let seq = 0;
  const matches = (r: any, w: Record<string, unknown>) => Object.entries(w).every(([k, v]) => r[k] === v);
  const query = (w: Record<string, unknown> = {}) => {
    const sel = () => rows.filter((r) => matches(r, w));
    const q: any = {
      where: (w2: any) => query({ ...w, ...w2 }),
      first: async () => sel()[0],
      orderBy: () => q,
      update: async (v: any) => (sel().forEach((r) => Object.assign(r, v)), sel().length),
      del: async () => {
        const hit = sel();
        hit.forEach((r) => rows.splice(rows.indexOf(r), 1));
        return hit.length;
      },
      then: (res: any, rej: any) => Promise.resolve(sel()).then(res, rej),
      insert: (v: any) => ({
        onConflict: (cols: string[]) => ({
          merge: (m: any) => ({
            returning: async () => {
              const existing = rows.find((r) => cols.every((c) => r[c] === v[c]));
              if (existing) return [Object.assign(existing, m)];
              const row = { id: `id-${++seq}`, ...v };
              rows.push(row);
              return [row];
            },
          }),
        }),
      }),
    };
    return q;
  };
  const db: any = (_t: string) => query();
  return { db, rows };
};

describe("createLinkStore", () => {
  const T0 = new Date("2026-11-16T10:00:00Z");
  const args = { channelId: "c1", identity: "whatsapp:+49 151/123", userId: 7, linkTtlDays: 7, now: T0 };

  it("upsert stores a link with a fixed expiry and returns Dates", async () => {
    const { db } = fakeDb();
    const store = createLinkStore(db);
    const link = await store.upsert(args);
    expect(link.expires_at).toEqual(new Date("2026-11-23T10:00:00Z"));
    expect(link.linked_at).toEqual(T0);
    expect(link.revoked_at).toBeNull();
    expect(link.last_seen_at).toBeNull();
    expect(await store.find("c1", args.identity)).toEqual(link);
    expect(await store.find("c1", "whatsapp:+49151123")).toBeUndefined();
  });

  it("upsert replaces an existing (channel, identity) row instead of adding one", async () => {
    const { db, rows } = fakeDb();
    const store = createLinkStore(db);
    const first = await store.upsert(args);
    const later = new Date("2026-11-20T10:00:00Z");
    const second = await store.upsert({ ...args, userId: 9, linkTtlDays: 30, now: later });
    expect(rows).toHaveLength(1);
    expect(second.id).toBe(first.id);
    expect(second.user).toBe(9);
    expect(second.linked_at).toEqual(later);
    expect(second.expires_at).toEqual(new Date("2026-12-20T10:00:00Z"));
  });

  it("re-linking a revoked identity makes it valid again", async () => {
    const { db } = fakeDb();
    const store = createLinkStore(db);
    const link = await store.upsert(args);
    await store.touch(link.id, new Date("2026-11-17T10:00:00Z"));
    await store.revoke(link.id, new Date("2026-11-18T10:00:00Z"));
    expect(linkState(await store.find("c1", args.identity), new Date("2026-11-19T10:00:00Z")).state).toBe("revoked");
    const relinked = await store.upsert({ ...args, now: new Date("2026-11-19T10:00:00Z") });
    expect(relinked.revoked_at).toBeNull();
    expect(relinked.last_seen_at).toBeNull();
    expect(linkState(relinked, new Date("2026-11-20T10:00:00Z")).state).toBe("valid");
  });

  it("touch records last_seen_at and never extends expires_at", async () => {
    const { db } = fakeDb();
    const store = createLinkStore(db);
    const link = await store.upsert(args);
    const seen = new Date("2026-11-22T10:00:00Z");
    await store.touch(link.id, seen);
    const after = (await store.find("c1", args.identity))!;
    expect(after.last_seen_at).toEqual(seen);
    expect(after.expires_at).toEqual(link.expires_at);
  });

  it("converts string dates from the driver to Dates", async () => {
    const db: any = () => ({
      where: () => ({
        first: async () => ({
          ...base,
          linked_at: "2026-11-16T10:00:00.000Z",
          expires_at: "2026-11-23T10:00:00.000Z",
          revoked_at: null,
          last_seen_at: "2026-11-17T10:00:00.000Z",
        }),
      }),
    });
    const link = (await createLinkStore(db).find("c1", "x"))!;
    expect(link.expires_at).toBeInstanceOf(Date);
    expect(link.last_seen_at).toBeInstanceOf(Date);
    expect(linkState(link, new Date("2026-11-23T10:00:00Z")).state).toBe("expired");
  });

  it("lists and deletes by user", async () => {
    const { db } = fakeDb();
    const store = createLinkStore(db);
    await store.upsert(args);
    await store.upsert({ ...args, identity: "b", userId: 8 });
    expect(await store.listForChannel("c1")).toHaveLength(2);
    expect((await store.listForUser("c1", 7)).map((l) => l.identity)).toEqual([args.identity]);
    expect(await store.deleteForUser(7)).toBe(1);
    expect(await store.listForChannel("c1")).toHaveLength(1);
  });

  it("listAllForUser returns the user's links across channels", async () => {
    const { db } = fakeDb();
    const store = createLinkStore(db);
    await store.upsert(args);
    await store.upsert({ ...args, channelId: "c2", identity: "c" });
    await store.upsert({ ...args, identity: "b", userId: 8 });
    const all = await store.listAllForUser(7);
    expect(all.map((l) => l.channel).sort()).toEqual(["c1", "c2"]);
  });
});
