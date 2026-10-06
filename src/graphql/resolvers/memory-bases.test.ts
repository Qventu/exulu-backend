jest.mock("./memory-base-stats", () => ({
  memoryBaseStats: jest.fn(async ({ context }: any) => ({ total: context.id === "mem_a" ? 47 : 3, public: 1, private: 1, contributors: 2, visible: 1, lastSavedAt: null, lastSavedBy: null })),
}));
import { listMemoryBases, countAgents } from "./memory-bases";

const valid = (id: string, name: string) => ({ id, name, description: `${name} desc`, fields: [{ name: "information", type: "text" }, { name: "type", type: "enum", enumValues: ["FACT"] }] }) as any;
const invalid = { id: "docs", name: "Docs", fields: [{ name: "body", type: "text" }] } as any;
const db = (agents: any[]) => jest.fn(() => ({ select: async () => agents }));

describe("listMemoryBases", () => {
  it("groups agents per base, includes valid unused bases and invalid ones an agent points at, and orders them", async () => {
    const rows = await listMemoryBases({
      contexts: [invalid, valid("mem_b", "Beta"), valid("mem_a", "Alpha")],
      user: { id: 1 } as any,
      db: db([{ id: "ag1", name: "Alfredinio", memory: "mem_a" }, { id: "ag2", name: "Bot", memory: "mem_a" }, { id: "ag3", name: "Docs-Bot", memory: "docs" }, { id: "ag4", name: "Lost", memory: "gone" }, { id: "ag5", name: "NoMem", memory: null }]),
    });
    expect(rows.map((r) => r.id)).toEqual(["mem_a", "mem_b", "docs", "gone"]);
    expect(rows[0]).toMatchObject({ valid: true, missingFromCode: false, agents: [{ id: "ag1", name: "Alfredinio" }, { id: "ag2", name: "Bot" }], stats: { total: 47 } });
    expect(rows[1]).toMatchObject({ valid: true, agents: [], stats: { total: 3 } });
    expect(rows[2]).toMatchObject({ valid: false, missing: ["information", "type"], agents: [{ id: "ag3", name: "Docs-Bot" }], stats: { total: 3 } });
    expect(rows[3]).toEqual({ id: "gone", name: "gone", description: null, valid: false, missing: ["information", "type"], missingFromCode: true, agents: [{ id: "ag4", name: "Lost" }], stats: null });
  });

  it("does not list invalid contexts nobody uses", async () => {
    const rows = await listMemoryBases({ contexts: [invalid, valid("mem_a", "Alpha")], user: { id: 1 } as any, db: db([]) });
    expect(rows.map((r) => r.id)).toEqual(["mem_a"]);
  });
});

describe("countAgents", () => {
  it("returns the unscoped agent total", async () => {
    const db = jest.fn(() => ({ count: async () => [{ c: 12 }] })) as any;
    expect(await countAgents(db)).toBe(12);
    expect(db).toHaveBeenCalledWith("agents");
  });

  it("coerces a string count and falls back to 0", async () => {
    expect(await countAgents(jest.fn(() => ({ count: async () => [{ c: "7" }] })) as any)).toBe(7);
    expect(await countAgents(jest.fn(() => ({ count: async () => [] })) as any)).toBe(0);
  });
});
