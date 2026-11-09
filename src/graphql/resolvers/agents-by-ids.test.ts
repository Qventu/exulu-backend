/**
 * `agentByIds` — one unresolvable id must not take the whole batch with it.
 *
 * `exuluApp.agent(id)` THROWS "Agent instance not found." for an id with no
 * row, while the resolver's own `if (agent)` guard shows it was written
 * expecting a falsy return. Every caller of this query reads its ids out of a
 * json column with no foreign key — `shared_artifacts.agent_slots`, eval runs,
 * feedback rows — and nothing prunes them when an agent is deleted, so a
 * dangling id is a steady state. Unguarded, it turned "one slot is not
 * offered" into "this artifact has no agent panel at all", and
 * "one feedback row has no agent label" into "the feedback list failed".
 *
 * Only the `agent` branch of the generic `*ByIds` resolver goes through
 * `exuluApp`; every other table is one `whereIn`, which has never had this
 * failure mode. Mocked at the three seams the branch actually uses, so the
 * test is about the loop and not about field hydration.
 */
import type { ExuluTableDefinition } from "@EXULU_TYPES/exulu-table-definition";

const mockAgent = jest.fn();
jest.mock("@SRC/exulu/app/singleton", () => ({
  exuluApp: { get: () => ({ agent: (id: string) => mockAgent(id) }) },
}));

const mockCheckRecordAccess = jest.fn();
jest.mock("@SRC/utils/check-record-access", () => ({
  checkRecordAccess: (...args: unknown[]) => mockCheckRecordAccess(...args),
}));

// Field hydration is a different concern (and a database one); hand the
// result straight back so the assertions read the rows the loop collected.
jest.mock("@SRC/graphql/utilities/sanitize-and-hydrate-fields", () => ({
  finalizeRequestedFields: async ({ result }: { result: unknown }) => result,
}));

import { createQueries } from "./index";

const AGENTS_TABLE = {
  name: { singular: "agent", plural: "agents" },
  fields: [{ name: "id" }, { name: "name" }],
} as unknown as ExuluTableDefinition;

/** The shape `getRequestedFields` reads: `id` and `name` were asked for. */
const INFO = {
  operation: {
    selectionSet: {
      selections: [
        {
          selectionSet: {
            selections: [{ name: { value: "id" } }, { name: { value: "name" } }],
          },
        },
      ],
    },
  },
};

const USER = { id: 7 } as never;

const agentByIds = (ids: string[]) =>
  (createQueries(AGENTS_TABLE, [], []) as Record<string, any>)["agentByIds"](
    undefined,
    { ids },
    { user: USER, db: undefined },
    INFO,
  );

/** `app.agent()`'s real contract: a row, or a throw for a missing one. */
const rows = (present: Record<string, { id: string; name: string }>) => (id: string) => {
  const row = present[id];
  if (!row) throw new Error("Agent instance not found.");
  return Promise.resolve(row);
};

const ANALYST = { id: "agent-1", name: "Pitch Analyst" };
const REVIEWER = { id: "agent-2", name: "Deal Reviewer" };

beforeEach(() => {
  jest.clearAllMocks();
  mockCheckRecordAccess.mockResolvedValue(true);
  jest.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe("agentByIds", () => {
  it("returns the agents that exist when one id is dangling", async () => {
    mockAgent.mockImplementation(rows({ "agent-1": ANALYST, "agent-2": REVIEWER }));

    const result = await agentByIds(["agent-1", "agent-deleted", "agent-2"]);

    expect(result).toEqual([ANALYST, REVIEWER]);
  });

  it("asks for every id even after one has failed", async () => {
    // The regression was an early exit, so the ids AFTER the dangling one are
    // the ones that were being lost.
    mockAgent.mockImplementation(rows({ "agent-2": REVIEWER }));

    await agentByIds(["agent-deleted", "agent-2"]);

    expect(mockAgent.mock.calls.map(([id]) => id)).toEqual(["agent-deleted", "agent-2"]);
  });

  it("returns an empty list, not an error, when every id is dangling", async () => {
    mockAgent.mockImplementation(rows({}));

    await expect(agentByIds(["gone-1", "gone-2"])).resolves.toEqual([]);
  });

  it("leaves a trace for the failure it swallows", async () => {
    // The catch is wide enough to cover a genuine fault (a database that is
    // down would otherwise read as "no agents"), so it must be findable.
    mockAgent.mockImplementation(rows({}));

    await agentByIds(["gone-1"]);

    expect(console.warn).toHaveBeenCalled();
  });

  it("still excludes an agent the user may not read", async () => {
    // The pre-existing filter has to survive the change: "absent" must keep
    // meaning both "no such agent" and "not yours".
    mockAgent.mockImplementation(rows({ "agent-1": ANALYST, "agent-2": REVIEWER }));
    mockCheckRecordAccess.mockImplementation(async (agent: { id: string }) => agent.id === "agent-1");

    const result = await agentByIds(["agent-1", "agent-2"]);

    expect(result).toEqual([ANALYST]);
  });
});
