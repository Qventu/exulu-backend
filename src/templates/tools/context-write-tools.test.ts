import { createContextWriteTools, collectKbWriteTools, createKbEditorPickerTool } from "./context-write-tools";
import { checkItemWriteAccess } from "@SRC/utils/check-item-write-access";
import { KB_EDITOR_TOOL_ID } from "./kb-editor-config";
import { z } from "zod";

jest.mock("@SRC/utils/check-item-write-access", () => ({
  checkItemWriteAccess: jest.fn(),
}));

const writeGate = checkItemWriteAccess as jest.Mock;

const BASE_FIELDS = [
  { name: "price", type: "number", required: true },
  { name: "category", type: "enum", enumValues: ["Hardware", "Software"] },
  { name: "specs", type: "json" },
  { name: "released_at", type: "date" },
  { name: "manual", type: "file" },
  { name: "legacy_ref", type: "uuid" },
  { name: "score", type: "number", calculated: true },
  { name: "audit_note", type: "text", editable: false },
];

const makeContext = (overrides: Record<string, unknown> = {}) =>
  ({
    id: "products",
    name: "Products",
    description: "Product catalog",
    fields: BASE_FIELDS,
    createItem: jest.fn(async () => ({ item: { id: "new-1" }, job: undefined })),
    updateItem: jest.fn(async () => ({ item: { id: "item-1" }, job: undefined })),
    getItem: jest.fn(),
    ...overrides,
  }) as any;

const exuluConfig = {} as any;
const user = { id: 7, role: { id: "role-1" } } as any;

const shapeKeys = (tool: any): string[] => Object.keys((tool.inputSchema as z.ZodObject<any>).shape);

describe("createContextWriteTools", () => {
  beforeEach(() => jest.clearAllMocks());

  it("returns one tool per granted permission with rule-conform ids", () => {
    const both = createContextWriteTools(makeContext(), { create: true, update: true }, false);
    expect(both.map((t) => t.id)).toEqual(["create_products_item", "update_products_item"]);
    const createOnly = createContextWriteTools(makeContext(), { create: true, update: false }, false);
    expect(createOnly.map((t) => t.id)).toEqual(["create_products_item"]);
    const none = createContextWriteTools(makeContext(), { create: false, update: false }, false);
    expect(none).toEqual([]);
  });

  it("caps the context-id segment of tool ids at 68 chars", () => {
    const longId = "a".repeat(80);
    const [tool] = createContextWriteTools(makeContext({ id: longId }), { create: true, update: false }, false);
    expect(tool.id).toBe(`create_${"a".repeat(68)}_item`);
    expect(tool.id.length).toBeLessThanOrEqual(80);
  });

  it("excludes file, uuid, calculated and non-editable fields from schemas; includes date as string", () => {
    const [createTool, updateTool] = createContextWriteTools(makeContext(), { create: true, update: true }, false);
    for (const keys of [shapeKeys(createTool), shapeKeys(updateTool)]) {
      expect(keys).toEqual(expect.arrayContaining(["price", "category", "specs", "released_at"]));
      expect(keys).not.toEqual(expect.arrayContaining(["manual", "legacy_ref", "score", "audit_note", "fts", "field"]));
    }
    expect(shapeKeys(createTool)).toEqual(expect.arrayContaining(["name", "description", "tags", "external_id"]));
    expect(shapeKeys(updateTool)).toEqual(expect.arrayContaining(["id", "external_id"]));
  });

  it("excludes fields whose name collides with a reserved runtime input key", () => {
    const context = makeContext({ fields: [...BASE_FIELDS, { name: "model", type: "text" }] });
    const [createTool, updateTool] = createContextWriteTools(context, { create: true, update: true }, false);
    for (const keys of [shapeKeys(createTool), shapeKeys(updateTool)]) {
      expect(keys).not.toEqual(expect.arrayContaining(["model"]));
      expect(keys).toEqual(expect.arrayContaining(["price", "category", "specs", "released_at"]));
    }
  });

  it("excludes hidden fields from both schemas", () => {
    const context = makeContext({
      fields: [...BASE_FIELDS, { name: "api_secret", type: "text", hidden: true }],
    });
    const [createTool, updateTool] = createContextWriteTools(context, { create: true, update: true }, false);
    for (const keys of [shapeKeys(createTool), shapeKeys(updateTool)]) {
      expect(keys).not.toEqual(expect.arrayContaining(["api_secret"]));
      expect(keys).toEqual(expect.arrayContaining(["price", "category", "specs", "released_at"]));
    }
  });

  it("requires name and required fields on create, everything optional on update", () => {
    const [createTool, updateTool] = createContextWriteTools(makeContext(), { create: true, update: true }, false);
    const createShape = (createTool.inputSchema as z.ZodObject<any>).shape;
    expect(createShape.name.isOptional()).toBe(false);
    expect(createShape.price.isOptional()).toBe(false);
    expect(createShape.category.isOptional()).toBe(true);
    const updateShape = (updateTool.inputSchema as z.ZodObject<any>).shape;
    expect(updateShape.name.isOptional()).toBe(true);
    expect(updateShape.price.isOptional()).toBe(true);
  });

  it("needsApproval follows skipApproval", () => {
    const [approved] = createContextWriteTools(makeContext(), { create: true, update: false }, false);
    expect(approved.needsApproval).toBe(true);
    const [skipped] = createContextWriteTools(makeContext(), { create: true, update: false }, true);
    expect(skipped.needsApproval).toBe(false);
  });

  describe("create execute", () => {
    const run = async (params: Record<string, unknown>, context = makeContext()) => {
      const [tool] = createContextWriteTools(context, { create: true, update: false }, false);
      const result = await (tool.tool.execute as any)({ user, exuluConfig, ...params }, { toolCallId: "t", messages: [] });
      return { result, context };
    };

    it("refuses to create for an unauthenticated (guest) user", async () => {
      const { result, context } = await run({ name: "Widget", price: 1, user: undefined });
      expect(context.createItem).not.toHaveBeenCalled();
      expect(result.result).toContain("authenticat");
    });

    it("stamps created_by, copies only content keys, calls createItem without upsert", async () => {
      const { result, context } = await run({
        name: "Widget",
        price: 9.5,
        category: "hardware",
        junk_runtime_key: "ignore-me",
      });
      expect(context.createItem).toHaveBeenCalledWith(
        { name: "Widget", price: 9.5, category: "Hardware", created_by: "7" },
        exuluConfig,
        7,
        "role-1",
        false,
      );
      expect(result.result).toContain("new-1");
    });

    it("rejects out-of-enum values with the allowed list instead of writing", async () => {
      const { result, context } = await run({ name: "Widget", price: 1, category: "Nonsense" });
      expect(context.createItem).not.toHaveBeenCalled();
      expect(result.result).toContain("Hardware, Software");
    });

    it("reports queued jobs", async () => {
      const context = makeContext({ createItem: jest.fn(async () => ({ item: { id: "new-2" }, job: "job-9" })) });
      const { result } = await run({ name: "Widget", price: 1 }, context);
      expect(result.result).toContain("job-9");
    });

    it("returns errors as result strings", async () => {
      const context = makeContext({ createItem: jest.fn(async () => { throw new Error("boom"); }) });
      const { result } = await run({ name: "Widget", price: 1 }, context);
      expect(result.result).toContain("boom");
    });
  });

  describe("update execute", () => {
    const run = async (params: Record<string, unknown>, context = makeContext()) => {
      const [tool] = createContextWriteTools(context, { create: false, update: true }, false);
      const result = await (tool.tool.execute as any)({ user, exuluConfig, ...params }, { toolCallId: "t", messages: [] });
      return { result, context };
    };

    it("requires id or external_id", async () => {
      const { result, context } = await run({ name: "x" });
      expect(context.getItem).not.toHaveBeenCalled();
      expect(result.result).toContain("id or external_id");
    });

    it("uses the same generic message for missing rows and denied access", async () => {
      const missing = makeContext({ getItem: jest.fn(async () => undefined) });
      const { result: r1 } = await run({ id: "nope", name: "x" }, missing);

      writeGate.mockResolvedValue(false);
      const denied = makeContext({
        getItem: jest.fn(async () => ({ id: "item-1", rights_mode: "private", created_by: "8" })),
      });
      const { result: r2, context } = await run({ id: "item-1", name: "x" }, denied);

      expect(r1.result).toBe(r2.result);
      expect(context.updateItem).not.toHaveBeenCalled();
    });

    it("resolves external_id, patches only provided fields, returns the fresh row", async () => {
      writeGate.mockResolvedValue(true);
      const existing = { id: "item-1", rights_mode: "public", name: "Old", price: 1 };
      const fresh = { id: "item-1", name: "Old", price: 25, category: "Hardware" };
      const context = makeContext({
        getItem: jest
          .fn()
          .mockResolvedValueOnce(existing) // lookup by external_id
          .mockResolvedValueOnce(fresh), // re-fetch after update
      });
      const { result } = await run({ external_id: "ext-1", price: 25 }, context);
      expect(context.getItem).toHaveBeenNthCalledWith(1, { item: { id: undefined, external_id: "ext-1" } });
      // external_id is lookup-only: the patch must not write it back.
      expect(context.updateItem).toHaveBeenCalledWith({ id: "item-1", price: 25 }, exuluConfig, 7, "role-1");
      expect(result.result).toContain('"price":25');
    });

    it("refuses an empty patch", async () => {
      writeGate.mockResolvedValue(true);
      const context = makeContext({ getItem: jest.fn(async () => ({ id: "item-1", rights_mode: "public" })) });
      const { result } = await run({ id: "item-1" }, context);
      expect(context.updateItem).not.toHaveBeenCalled();
      expect(result.result).toContain("No fields");
    });
  });
});

describe("collectKbWriteTools", () => {
  const agentWith = (knowledgeBases: Record<string, unknown>, skip = false) =>
    ({
      id: "agent-1",
      tools: [
        {
          id: KB_EDITOR_TOOL_ID,
          type: "function",
          config: [
            { name: "knowledge_bases", type: "json", variable: JSON.stringify(knowledgeBases) },
            { name: "skip_approval", type: "boolean", variable: skip ? "true" : "false" },
          ],
        },
      ],
    }) as any;

  it("expands configured contexts into tools and skips vanished contexts silently", () => {
    const contexts = [makeContext(), makeContext({ id: "faq", name: "FAQ" })];
    const tools = collectKbWriteTools(
      agentWith({
        products: { create: true, update: true },
        faq: { create: true, update: false },
        removed_ctx: { create: true, update: true },
      }),
      contexts,
    );
    expect(tools.map((t) => t.id).sort()).toEqual([
      "create_faq_item",
      "create_products_item",
      "update_products_item",
    ]);
  });

  it("returns nothing without the entry, without contexts, or without an agent", () => {
    expect(collectKbWriteTools({ id: "a", tools: [] } as any, [makeContext()])).toEqual([]);
    expect(collectKbWriteTools(agentWith({ products: { create: true, update: false } }), [])).toEqual([]);
    expect(collectKbWriteTools(undefined, [makeContext()])).toEqual([]);
  });

  it("propagates skip_approval to the generated tools", () => {
    const [tool] = collectKbWriteTools(agentWith({ products: { create: true, update: false } }, true), [makeContext()]);
    expect(tool.needsApproval).toBe(false);
  });
});

describe("createKbEditorPickerTool", () => {
  it("builds the display-only picker entry with the stored-config contract", () => {
    const picker = createKbEditorPickerTool();
    expect(picker.id).toBe(KB_EDITOR_TOOL_ID);
    expect(picker.category).toBe("default");
    expect(picker.type).toBe("function");
    expect(picker.config.map((c) => c.name)).toEqual(["knowledge_bases", "skip_approval"]);
    expect(picker.config.map((c) => c.type)).toEqual(["json", "boolean"]);
  });
});
