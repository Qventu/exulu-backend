import { recallMemories } from "./recall";

const chunk = { item_id: "m1", item_name: "T", chunk_content: "c" } as any;
const rows = [{ id: "m1", name: "T", information: "Fact", type: "FACT", rights_mode: "private", created_by: 4, createdAt: "2026-09-01", updatedAt: "2026-09-01" }];
const dbFor = (users: any[] = []) => {
  const chain: any = {
    whereIn: jest.fn(() => chain), whereNot: jest.fn(() => chain), select: jest.fn(async () => users.length ? users : rows), where: jest.fn(() => chain),
  };
  return Object.assign(jest.fn(() => chain), { chain });
};
const search = jest.fn(async () => ({ chunks: [chunk] }));
const context: any = { id: "mem", name: "Memory", fields: [], search };
const user: any = { id: 4, role: { id: "r1" } };

beforeEach(() => search.mockClear());

describe("recallMemories", () => {
  it("searches with the user, role and configured limit, and builds the prompt block", async () => {
    const r = await recallMemories({ agent: { id: "a", memory: "mem", memory_config: { retrieval: { limit: 3 } } } as any, contexts: [context], query: "q", user, db: dbFor() });
    expect(search).toHaveBeenCalledWith(expect.objectContaining({ query: "q", user, role: "r1", limit: 3, method: "hybridSearch" }));
    expect(r.memoryItems).toEqual([chunk]);
    expect(r.promptBlock).toContain('item_id: "m1"');
    expect(r.collector?.list()).toHaveLength(1);
  });

  it("skips the search when retrieval is disabled but still returns a collector", async () => {
    const r = await recallMemories({ agent: { id: "a", memory: "mem", memory_config: { retrieval: { enabled: false } } } as any, contexts: [context], query: "q", user, db: dbFor() });
    expect(search).not.toHaveBeenCalled();
    expect(r.promptBlock).toBe("");
    expect(r.collector).toBeDefined();
  });

  it("warns and returns empty when the memory context is missing, and does nothing without agent.memory or query", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    const r = await recallMemories({ agent: { id: "a", memory: "gone" } as any, contexts: [context], query: "q", user, db: dbFor() });
    expect(r).toEqual({ collector: undefined, memoryItems: undefined, promptBlock: "" });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("gone"));
    warn.mockRestore();
    expect(await recallMemories({ agent: { id: "a" } as any, contexts: [context], query: "q", user, db: dbFor() })).toEqual({ collector: undefined, memoryItems: undefined, promptBlock: "" });
    expect(search).not.toHaveBeenCalled();
  });

  it("passes no user for guests (public-only search)", async () => {
    await recallMemories({ agent: { id: "a", memory: "mem" } as any, contexts: [context], query: "q", user: undefined, db: dbFor() });
    expect(search).toHaveBeenCalledWith(expect.objectContaining({ user: undefined, role: undefined, limit: 10 }));
  });
});
