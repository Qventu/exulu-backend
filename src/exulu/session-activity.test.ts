import {
  markSessionGenerating,
  markSessionAnswered,
  markSessionIdle,
  markSessionSeen,
} from "./session-activity";

type Update = { where: any; patch: any };

const createFakeDb = (onUpdate?: () => never) => {
  const updates: Update[] = [];
  const db: any = (table: string) => {
    if (table !== "agent_sessions") throw new Error("unexpected table " + table);
    return {
      where(where: any) {
        return {
          async update(patch: any) {
            if (onUpdate) onUpdate();
            updates.push({ where, patch });
            return 1;
          },
        };
      },
    };
  };
  return { db, updates };
};

const failingDb = () =>
  createFakeDb(() => {
    throw new Error("connection terminated unexpectedly");
  });

describe("markSessionGenerating", () => {
  it("stamps generating_since on the session so the list can show it working", async () => {
    const { db, updates } = createFakeDb();
    await markSessionGenerating(db, "session-1");

    expect(updates).toHaveLength(1);
    expect(updates[0]!.where).toEqual({ id: "session-1" });
    expect(updates[0]!.patch.generating_since).toBeInstanceOf(Date);
  });

  it("touches nothing but generating_since", async () => {
    const { db, updates } = createFakeDb();
    await markSessionGenerating(db, "session-1");

    expect(Object.keys(updates[0]!.patch)).toEqual(["generating_since"]);
  });
});

describe("markSessionAnswered", () => {
  it("stamps last_answer_at and clears generating_since in one write", async () => {
    const { db, updates } = createFakeDb();
    await markSessionAnswered(db, "session-1");

    expect(updates).toHaveLength(1);
    expect(updates[0]!.patch.last_answer_at).toBeInstanceOf(Date);
    expect(updates[0]!.patch.generating_since).toBeNull();
  });
});

describe("markSessionIdle", () => {
  it("clears generating_since without claiming an answer arrived", async () => {
    const { db, updates } = createFakeDb();
    await markSessionIdle(db, "session-1");

    expect(updates[0]!.patch).toEqual({ generating_since: null });
  });
});

describe("markSessionSeen", () => {
  it("stamps last_seen_at from the server clock", async () => {
    const { db, updates } = createFakeDb();
    await markSessionSeen(db, "session-1");

    expect(updates[0]!.patch.last_seen_at).toBeInstanceOf(Date);
  });
});

describe("every stamp is best-effort", () => {
  // The failure path logs on purpose; keep it out of the suite output.
  let logged: jest.SpyInstance;
  beforeEach(() => {
    logged = jest.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    logged.mockRestore();
  });

  it.each([
    ["markSessionGenerating", markSessionGenerating],
    ["markSessionAnswered", markSessionAnswered],
    ["markSessionIdle", markSessionIdle],
    ["markSessionSeen", markSessionSeen],
  ])("%s never lets a database failure reach the chat turn", async (_name, stamp) => {
    const { db } = failingDb();
    await expect(stamp(db, "session-1")).resolves.toBeUndefined();
  });

  it.each([
    ["markSessionGenerating", markSessionGenerating],
    ["markSessionAnswered", markSessionAnswered],
    ["markSessionIdle", markSessionIdle],
    ["markSessionSeen", markSessionSeen],
  ])("%s writes nothing when there is no session (a one-off run)", async (_name, stamp) => {
    const { db, updates } = createFakeDb();
    await stamp(db, undefined);

    expect(updates).toEqual([]);
  });
});
