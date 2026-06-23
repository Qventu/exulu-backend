import { createNewMemoryItemTool } from "./memory-tool";

const createItem = jest.fn(async () => ({ item: { id: "x" }, job: undefined }));
const fakeMemoryContext: any = {
  id: "newton_memory_context",
  name: "newton memory",
  fields: [
    { name: "information", type: "text" },
    { name: "type", type: "enum", enumValues: ["PREFERENCE", "FACT", "CONTEXT", "ENTITY", "DECISION", "INSIGHT"] },
  ],
  createItem,
};

describe("createNewMemoryItemTool — visibility dialogue + type", () => {
  beforeEach(() => createItem.mockClear());
  const tool = () => createNewMemoryItemTool({ id: "agent" } as any, fakeMemoryContext) as any;
  const base = { name: "n", description: "d", surroundingContext: "s", information: "i", type: "DECISION" };

  it("without visibility, instructs the agent to ask the user and saves NOTHING", async () => {
    const r = await tool().tool.execute({ ...base }, {} as any);
    expect(createItem).not.toHaveBeenCalled();
    expect(String(r.result)).toMatch(/private/i);
    expect(String(r.result)).toMatch(/public/i);
  });

  it("visibility=private → rights_mode 'private' and persists type", async () => {
    await tool().tool.execute({ ...base, visibility: "private" }, {} as any);
    const written = createItem.mock.calls[0][0];
    expect(written.rights_mode).toBe("private");
    expect(written.type).toBe("DECISION");
  });

  it("visibility=public → rights_mode 'public'", async () => {
    await tool().tool.execute({ ...base, visibility: "public" }, {} as any);
    expect(createItem.mock.calls[0][0].rights_mode).toBe("public");
  });

  it("omits type when the caller didn't supply one (column default applies)", async () => {
    await tool().tool.execute({ name: "n", description: "d", surroundingContext: "s", information: "i", visibility: "public" }, {} as any);
    expect(createItem.mock.calls[0][0].type).toBeUndefined();
  });
});
