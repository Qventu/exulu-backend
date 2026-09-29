jest.mock("@SRC/graphql/utilities/access-control");
jest.mock("@SRC/exulu/table-names");
jest.mock("@SRC/graphql/utilities/convert-context-to-table-definition");

import { applyAccessControl } from "@SRC/graphql/utilities/access-control";
import { getTableName } from "@SRC/exulu/table-names";
import { convertContextToTableDefinition } from "@SRC/graphql/utilities/convert-context-to-table-definition";
import { RecallCollector, buildMemoryPromptBlock, createRecallCollector, displayName, loadVisibleMemoryRows, MEMORY_ITEM_FIELDS, type MemoryItemRow } from "./recall-collector";

// Configure mocks
(applyAccessControl as jest.Mock).mockImplementation((_t: unknown, q: unknown) => q);
(convertContextToTableDefinition as jest.Mock).mockImplementation((context: any) => ({ RBAC: true, id: context.id, ...context }));

const row = (id: string, extra: Partial<MemoryItemRow> = {}): MemoryItemRow => ({
  id, name: `Title ${id}`, information: `Fact ${id}`, type: "FACT", rights_mode: "public",
  created_by: 7, createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-02T00:00:00.000Z", ...extra,
});
const chunk = (item_id: string) => ({ item_id, item_name: `Title ${item_id}`, chunk_content: "…" }) as any;

function make(rows: MemoryItemRow[], users = [{ id: 7, firstname: "Sara", lastname: "Kraus", email: "s@x.de" }]) {
  const loadItems = jest.fn(async (ids: string[]) => rows.filter((r) => ids.includes(r.id)));
  const loadUsers = jest.fn(async (ids: number[]) => users.filter((u) => ids.includes(u.id)));
  return { collector: new RecallCollector({ contextId: "mem", loadItems, loadUsers }), loadItems, loadUsers };
}

describe("RecallCollector", () => {
  it("loads item rows for chunks, de-duplicates by item id and resolves creator names once", async () => {
    const { collector, loadItems, loadUsers } = make([row("a"), row("b")]);
    await collector.addFromChunks([chunk("a"), chunk("a"), chunk("b")], "prefetch");
    await collector.addFromChunks([chunk("b")], "knowledge_search");
    expect(loadItems).toHaveBeenCalledTimes(1);
    expect(loadItems.mock.calls[0][0]).toEqual(["a", "b"]);
    expect(loadUsers).toHaveBeenCalledTimes(1);
    const list = collector.list();
    expect(list.map((m) => m.id)).toEqual(["a", "b"]);
    expect(list[0]).toMatchObject({ contextId: "mem", title: "Title a", information: "Fact a", type: "FACT",
      rights_mode: "public", createdBy: { id: 7, name: "Sara Kraus" }, source: "prefetch" });
  });

  it("skips chunks whose items are not visible (loader returns nothing) and keeps createdBy null when unknown", async () => {
    const { collector } = make([row("a", { created_by: null })], []);
    await collector.addFromChunks([chunk("a"), chunk("ghost")], "prefetch");
    expect(collector.list()).toHaveLength(1);
    expect(collector.list()[0].createdBy).toBeNull();
  });
});

describe("buildMemoryPromptBlock", () => {
  it("emits one citation object per memory that the frontend citation regex matches", () => {
    const block = buildMemoryPromptBlock([{
      id: "a1", contextId: "mem", title: 'Encoder "X12"', information: "Check X12 first }", type: "FACT",
      rights_mode: "private", createdBy: { id: 7, name: "Sara Kraus" }, createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z", source: "prefetch",
    }]);
    expect(block).toContain('{item_name: "Encoder X12", item_id: "a1", context: "mem"}');
    expect(block).toContain("Check X12 first }");
    expect(block).toContain("saved by Sara Kraus");
    expect(block).toContain("private");
    // Same regex as components/message-renderer.tsx flexibleCitationRegex
    expect(block.match(/\{[^}]*?item_name\s*:\s*[^,}]+[^}]*?\}/g)).toHaveLength(1);
  });
  it("returns an empty string for no memories", () => {
    expect(buildMemoryPromptBlock([])).toBe("");
  });
});

describe("displayName", () => {
  it("prefers first+last name, then email, then the id", () => {
    expect(displayName({ id: 1, firstname: "A", lastname: "B" })).toBe("A B");
    expect(displayName({ id: 1, email: "a@b.c" })).toBe("a@b.c");
    expect(displayName({ id: 1 })).toBe("User 1");
  });
});

describe("loadVisibleMemoryRows", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (getTableName as jest.Mock).mockReturnValue("memory_items");
  });

  it("calls db with the memory table name, filters archived, and applies access control", async () => {
    const chain: any = { whereIn: jest.fn(() => chain), whereNot: jest.fn(() => chain), select: jest.fn(async () => [row("a")]) };
    const db = jest.fn(() => chain);
    const context = { id: "mem", name: "Memory", fields: [] } as any;
    const user = { id: 1, firstname: "Test", lastname: "User" } as any;

    const result = await loadVisibleMemoryRows(context, ["a"], user, db);

    expect(db).toHaveBeenCalledWith("memory_items");
    expect(chain.whereIn).toHaveBeenCalledWith("id", ["a"]);
    expect(chain.whereNot).toHaveBeenCalledWith("archived", true);
    expect(chain.select).toHaveBeenCalledWith(MEMORY_ITEM_FIELDS);
    expect(applyAccessControl).toHaveBeenCalledWith(
      expect.objectContaining({ RBAC: true }),
      chain,
      user
    );
    expect(result).toEqual([row("a")]);
  });

  it("applies access control with undefined user for guest access", async () => {
    const chain: any = { whereIn: jest.fn(() => chain), whereNot: jest.fn(() => chain), select: jest.fn(async () => []) };
    const db = jest.fn(() => chain);
    const context = { id: "mem", name: "Memory", fields: [] } as any;

    await loadVisibleMemoryRows(context, ["a"], undefined, db);

    expect(applyAccessControl).toHaveBeenCalledWith(
      expect.objectContaining({ RBAC: true }),
      chain,
      undefined
    );
  });

  it("returns empty array for empty ids without calling db", async () => {
    const db = jest.fn();
    const context = { id: "mem", name: "Memory", fields: [] } as any;

    const result = await loadVisibleMemoryRows(context, [], undefined, db);

    expect(db).not.toHaveBeenCalled();
    expect(result).toEqual([]);
  });
});

describe("createRecallCollector", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (getTableName as jest.Mock).mockReturnValue("memory_items");
    (convertContextToTableDefinition as jest.Mock).mockImplementation((context: any) => ({ RBAC: true, id: context.id, ...context }));
  });

  it("uses the RBAC-scoped loader and resolves creators, proving access control is applied", async () => {
    const memChain: any = {
      whereIn: jest.fn(() => memChain),
      whereNot: jest.fn(() => memChain),
      select: jest.fn(async () => [row("a")])
    };
    const usersChain: any = {
      whereIn: jest.fn(() => usersChain),
      select: jest.fn(async () => [{ id: 7, firstname: "Sara", lastname: "Kraus", email: "s@x.de" }])
    };
    const db = jest.fn(function (table: string) {
      return table === "users" ? usersChain : memChain;
    });
    const context = { id: "mem", name: "Memory", fields: [] } as any;
    const user = { id: 1, firstname: "Test", lastname: "User" } as any;

    const collector = createRecallCollector(context, user, db);
    await collector.addFromChunks([chunk("a")], "prefetch");

    // Verify applyAccessControl was called (RBAC enforcement)
    expect(applyAccessControl).toHaveBeenCalled();
    // Verify db was called for memory table
    expect(db).toHaveBeenCalledWith("memory_items");
    // Verify db was called for users table
    expect(db).toHaveBeenCalledWith("users");
    // Verify the users chain received whereIn for creator id
    expect(usersChain.whereIn).toHaveBeenCalledWith("id", [7]);

    const list = collector.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      id: "a",
      createdBy: { id: 7, name: "Sara Kraus" }
    });
  });
});
