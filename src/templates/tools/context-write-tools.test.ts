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

  it("excludes uuid, calculated and non-editable fields from schemas; includes date as string and file as a session file name", () => {
    const [createTool, updateTool] = createContextWriteTools(makeContext(), { create: true, update: true }, false);
    for (const keys of [shapeKeys(createTool), shapeKeys(updateTool)]) {
      expect(keys).toEqual(expect.arrayContaining(["price", "category", "specs", "released_at", "manual"]));
      expect(keys).not.toEqual(expect.arrayContaining(["legacy_ref", "score", "audit_note", "fts", "field", "manual_s3key"]));
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

describe("file fields (session files)", () => {
  const uploads = { fileUploads: { s3Bucket: "b", s3prefix: "imp" } } as any;
  const fileContext = (allowed?: string[]) =>
    makeContext({
      fields: [
        { name: "price", type: "number" },
        { name: "manual", type: "file", ...(allowed ? { allowedFileTypes: allowed } : {}) },
      ],
    });
  const run = async (params: Record<string, unknown>, context: any, copyObject = jest.fn(async () => {})) => {
    const [tool] = createContextWriteTools(context, { create: true, update: false }, false, { copyObject });
    const result = await (tool.tool.execute as any)(
      { user, exuluConfig: uploads, sessionID: "sess-1", ...params },
      { toolCallId: "t", messages: [] },
    );
    return { result, context, copyObject };
  };

  it("copies the session file to the user's upload prefix and stores the key in the _s3key column", async () => {
    const { result, context, copyObject } = await run({ name: "Manual", manual: "guide.pdf" }, fileContext());
    expect(copyObject).toHaveBeenCalledTimes(1);
    const [source, dest, cfg] = (copyObject as jest.Mock).mock.calls[0];
    expect(source).toBe("imp/user_7/sessions/sess-1/guide.pdf");
    expect(dest).toMatch(/^imp\/user_7\/[0-9a-f-]{36}-_EXULU_guide\.pdf$/);
    expect(cfg).toBe(uploads);
    const written = (context.createItem as jest.Mock).mock.calls[0][0];
    expect(written.manual_s3key).toBe(dest);
    expect(written.manual).toBeUndefined();
    expect(result.result).toContain("new-1");
  });

  it("reads the file from the session owner's prefix when the session is shared", async () => {
    const copyObject = jest.fn(async () => {});
    const [tool] = createContextWriteTools(fileContext(), { create: true, update: false }, false, { copyObject, sessionOwnerId: 3 });
    await (tool.tool.execute as any)({ user, exuluConfig: uploads, sessionID: "sess-1", name: "M", manual: "a.pdf" }, { toolCallId: "t", messages: [] });
    expect((copyObject as jest.Mock).mock.calls[0][0]).toBe("imp/user_3/sessions/sess-1/a.pdf");
    expect((copyObject as jest.Mock).mock.calls[0][1]).toMatch(/^imp\/user_7\//);
  });

  it("rejects a name with a path, a disallowed type, and a file the session does not have", async () => {
    const pathy = await run({ name: "M", manual: "../secret.pdf" }, fileContext());
    expect(pathy.copyObject).not.toHaveBeenCalled();
    expect(pathy.result.result).toContain("bare file name");

    const wrongType = await run({ name: "M", manual: "notes.txt" }, fileContext([".pdf", ".docx"]));
    expect(wrongType.copyObject).not.toHaveBeenCalled();
    expect(wrongType.result.result).toContain(".pdf, .docx");

    const missing = await run({ name: "M", manual: "gone.pdf" }, fileContext(), jest.fn(async () => { throw new Error("NoSuchKey"); }));
    expect(missing.context.createItem).not.toHaveBeenCalled();
    expect(missing.result.result).toContain("not among this session's files");
  });

  it("needs file uploads to be configured", async () => {
    const [tool] = createContextWriteTools(fileContext(), { create: true, update: false }, false, { copyObject: jest.fn() });
    const result = await (tool.tool.execute as any)({ user, exuluConfig: {}, sessionID: "s", name: "M", manual: "a.pdf" }, { toolCallId: "t", messages: [] });
    expect(result.result).toContain("not configured");
  });

  it("leaves the file alone on update when the field is omitted", async () => {
    const context = fileContext();
    context.getItem.mockResolvedValue({ id: "item-1" });
    writeGate.mockResolvedValue(true);
    const copyObject = jest.fn(async () => {});
    const [tool] = createContextWriteTools(context, { create: false, update: true }, false, { copyObject });
    await (tool.tool.execute as any)({ user, exuluConfig: uploads, sessionID: "s", id: "item-1", price: 2 }, { toolCallId: "t", messages: [] });
    expect(copyObject).not.toHaveBeenCalled();
    const patch = (context.updateItem as jest.Mock).mock.calls[0][0];
    expect(patch).toEqual({ price: 2, id: "item-1" });
  });
});
