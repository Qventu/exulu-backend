/**
 * The gate on agentSessionMarkSeen. Uses the REAL applyAccessControl (the
 * agent_sessions branch only calls query.where(fn) and hands the query back,
 * which the fake below supports faithfully) so a regression in the gate order
 * fails here rather than passing against a stub.
 */
import { markSessionSeenForViewer } from "./mark-session-seen";

const agentSessionsTable: any = {
  name: { plural: "agent_sessions", singular: "agent_session" },
  RBAC: true,
  fields: [],
};

const createFakeDb = ({ visible }: { visible: boolean }) => {
  const updates: any[] = [];
  const selected: string[] = [];
  const query: any = {
    where() {
      return query;
    },
    select(...columns: string[]) {
      selected.push(...columns);
      return query;
    },
    async first() {
      return visible ? { id: "session-1" } : undefined;
    },
  };
  const db: any = (table: string) => {
    if (table !== "agent_sessions") throw new Error("unexpected table " + table);
    return {
      where() {
        return {
          async update(patch: any) {
            updates.push(patch);
            return 1;
          },
        };
      },
    };
  };
  db.from = (table: string) => {
    if (table !== "agent_sessions") throw new Error("unexpected table " + table);
    return query;
  };
  return { db, updates };
};

const viewer: any = { id: 7, role: { id: "role-1" } };

describe("markSessionSeenForViewer", () => {
  it("stamps last_seen_at for a session the viewer can open", async () => {
    const { db, updates } = createFakeDb({ visible: true });

    await expect(
      markSessionSeenForViewer({ db, table: agentSessionsTable, user: viewer, id: "session-1" }),
    ).resolves.toBe(true);
    expect(updates).toHaveLength(1);
    expect(updates[0].last_seen_at).toBeInstanceOf(Date);
  });

  it("stamps nothing for a session the viewer cannot open", async () => {
    const { db, updates } = createFakeDb({ visible: false });

    await expect(
      markSessionSeenForViewer({ db, table: agentSessionsTable, user: viewer, id: "session-1" }),
    ).resolves.toBe(false);
    expect(updates).toEqual([]);
  });

  it("refuses an unauthenticated caller", async () => {
    const { db, updates } = createFakeDb({ visible: true });

    await expect(
      markSessionSeenForViewer({ db, table: agentSessionsTable, user: undefined, id: "session-1" }),
    ).rejects.toThrow(/authentication/i);
    expect(updates).toEqual([]);
  });

  it("refuses a call with no session id rather than stamping something else", async () => {
    const { db, updates } = createFakeDb({ visible: true });

    await expect(
      markSessionSeenForViewer({ db, table: agentSessionsTable, user: viewer, id: "" }),
    ).resolves.toBe(false);
    expect(updates).toEqual([]);
  });
});
