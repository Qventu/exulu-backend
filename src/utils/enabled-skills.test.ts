import { getEnabledSkills } from "./enabled-skills";
import { postgresClient } from "@SRC/postgres/client";
import type { ExuluAgent } from "@EXULU_TYPES/models/agent";

jest.mock("@SRC/postgres/client", () => ({ postgresClient: jest.fn() }));

const mockSkillRows = (rows: unknown[]) => {
  (postgresClient as jest.Mock).mockResolvedValue({
    db: { from: () => ({ whereIn: () => Promise.resolve(rows) }) },
  });
};

const agentWith = (skills: ExuluAgent["skills"]): ExuluAgent => ({ skills }) as ExuluAgent;

describe("getEnabledSkills", () => {
  beforeEach(() => {
    (postgresClient as jest.Mock).mockReset();
  });

  it("returns nothing when the agent has no skills", async () => {
    expect(await getEnabledSkills(agentWith(undefined))).toEqual([]);
  });

  it("enriches each skill ref with its live current_version from the DB, not whatever (if anything) was on the ref", async () => {
    mockSkillRows([{ id: "s1", name: "Instandsetzungsbericht", current_version: 6 }]);
    const result = await getEnabledSkills(agentWith([{ id: "s1", name: "Instandsetzungsbericht" } as any]));
    expect(result).toEqual([expect.objectContaining({ id: "s1", current_version: 6 })]);
  });

  it("drops a skill ref whose id no longer exists in the skills table", async () => {
    // Reproduces the real bug: an agent had two skill refs sharing the name
    // "Instandsetzungsbericht" — one a stale/orphaned id with no DB row, one
    // live. Both downloaded into the same sandbox folder by name; without
    // filtering, the orphan's absence of current_version made downloadSkill
    // fall back to v1, and if it happened to download after the live one it
    // would silently overwrite the live skill's files with nothing useful.
    mockSkillRows([{ id: "live-id", name: "Instandsetzungsbericht", current_version: 6 }]);
    const result = await getEnabledSkills(
      agentWith([
        { id: "orphan-id", name: "Instandsetzungsbericht" } as any,
        { id: "live-id", name: "Instandsetzungsbericht" } as any,
      ]),
    );
    expect(result).toEqual([expect.objectContaining({ id: "live-id", current_version: 6 })]);
  });

  it("still filters out explicitly disabled skills", async () => {
    mockSkillRows([
      { id: "s1", name: "A", current_version: 1 },
      { id: "s2", name: "B", current_version: 1 },
    ]);
    const result = await getEnabledSkills(
      agentWith([{ id: "s1", name: "A" } as any, { id: "s2", name: "B" } as any]),
      ["s2"],
    );
    expect(result.map((s) => s.id)).toEqual(["s1"]);
  });
});
