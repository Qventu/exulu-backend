import { z } from "zod";
import {
  FIND_DEFAULT_LIMIT,
  FIND_MAX_LIMIT,
  checkItemReadAccess,
  createContextReadTools,
} from "./context-read-tools";
import { itemNotFoundMessage } from "./context-write-tools";
import { checkRecordAccess } from "@SRC/utils/check-record-access";
import { UnknownFilterPathError } from "@SRC/graphql/utilities/convert-graphql-filter-operator-to-pg-query";

jest.mock("@SRC/utils/check-record-access", () => ({
  checkRecordAccess: jest.fn(),
}));

const rbacRow = jest.fn();
const rbacWhere = jest.fn();
jest.mock("@SRC/postgres/client", () => ({
  postgresClient: jest.fn(async () => ({
    db: {
      from: () => ({
        where: (...args: any[]) => {
          rbacWhere(...args);
          return { first: async () => rbacRow() };
        },
      }),
    },
  })),
}));

const recordGate = checkRecordAccess as jest.Mock;

// Same fixture shape as context-write-tools.test.ts, plus a hidden field —
// `hidden` is this repo's write-only-secret contract and must never reach a
// model through a read tool either.
const BASE_FIELDS = [
  { name: "price", type: "number", required: true },
  { name: "category", type: "enum", enumValues: ["Hardware", "Software"] },
  { name: "specs", type: "json" },
  { name: "released_at", type: "date" },
  { name: "manual", type: "file" },
  { name: "legacy_ref", type: "uuid" },
  { name: "score", type: "number", calculated: true },
  { name: "audit_note", type: "text", editable: false },
  { name: "api_secret", type: "text", hidden: true },
];

const ROW = {
  id: "item-1",
  name: "Widget",
  description: "A widget",
  tags: "a,b",
  external_id: "ext-1",
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-02T00:00:00.000Z",
  rights_mode: "public",
  archived: false,
  created_by: "7",
  price: 9.5,
  category: "Hardware",
  specs: { wert: "x" },
  released_at: "2026-10-01T00:00:00.000Z",
  manual_s3key: "imp/user_7/abc-_EXULU_guide.pdf",
  legacy_ref: "11111111-1111-1111-1111-111111111111",
  score: 3,
  audit_note: "touched",
  api_secret: "TOPSECRET",
};

const makeContext = (overrides: Record<string, unknown> = {}) =>
  ({
    id: "products",
    name: "Products",
    description: "Product catalog",
    fields: BASE_FIELDS,
    getItem: jest.fn(async () => ({ ...ROW })),
    getItems: jest.fn(async () => [{ id: "item-1", name: "Widget" }]),
    ...overrides,
  }) as any;

const exuluConfig = {} as any;
const user = { id: 7, role: { id: "role-1" } } as any;

const tools = (context: any, deps: Record<string, unknown> = {}) =>
  createContextReadTools(context, { checkAccess: jest.fn(async () => true), ...deps } as any);

const getTool = (context: any, deps: Record<string, unknown> = {}) => tools(context, deps)[0]!;
const findTool = (context: any, deps: Record<string, unknown> = {}) => tools(context, deps)[1]!;

const run = async (tool: any, params: Record<string, unknown>) =>
  (await (tool.tool.execute as any)(
    { user, exuluConfig, ...params },
    { toolCallId: "t", messages: [] },
  )) as { result: string };

describe("createContextReadTools", () => {
  beforeEach(() => jest.clearAllMocks());

  it("returns a get and a find tool with rule-conform ids and no approval", () => {
    const [get, find] = createContextReadTools(makeContext());
    expect(get!.id).toBe("get_products_item");
    expect(find!.id).toBe("find_products_items");
    expect(get!.needsApproval).toBe(false);
    expect(find!.needsApproval).toBe(false);
    expect(get!.category).toBe("knowledge_base_reading");
    expect(find!.category).toBe("knowledge_base_reading");
  });

  it("caps the context-id segment of both ids at 68 chars", () => {
    const longId = "a".repeat(80);
    const [get, find] = createContextReadTools(makeContext({ id: longId }));
    expect(get!.id).toBe(`get_${"a".repeat(68)}_item`);
    expect(find!.id).toBe(`find_${"a".repeat(68)}_items`);
    expect(get!.id.length).toBeLessThanOrEqual(80);
    expect(find!.id.length).toBeLessThanOrEqual(80);
  });

  describe("get", () => {
    it("returns the system and content fields of the item, never a hidden one", async () => {
      const context = makeContext();
      const result = await run(getTool(context), { id: "item-1" });
      expect(context.getItem).toHaveBeenCalledWith({ item: { id: "item-1", external_id: undefined } });
      expect(result.result.startsWith("Item: ")).toBe(true);
      const item = JSON.parse(result.result.slice("Item: ".length));
      expect(item).toMatchObject({
        id: "item-1",
        name: "Widget",
        external_id: "ext-1",
        createdAt: ROW.createdAt,
        updatedAt: ROW.updatedAt,
        rights_mode: "public",
        price: 9.5,
        category: "Hardware",
        specs: { wert: "x" },
        audit_note: "touched",
      });
      expect(item.api_secret).toBeUndefined();
      expect(result.result).not.toContain("TOPSECRET");
    });

    it("narrows the output to the named fields", async () => {
      const result = await run(getTool(makeContext()), { id: "item-1", fields: ["price"] });
      const item = JSON.parse(result.result.slice("Item: ".length));
      expect(item).toEqual({ id: "item-1", price: 9.5 });
    });

    it("uses one generic not-found message for a missing row and for a denied one, and leaks no field", async () => {
      const missing = makeContext({ getItem: jest.fn(async () => undefined) });
      const { result: r1 } = await run(getTool(missing), { id: "nope" });

      const denied = makeContext();
      const { result: r2 } = await run(getTool(denied, { checkAccess: jest.fn(async () => false) }), {
        id: "item-1",
      });

      expect(r1).toBe(itemNotFoundMessage(makeContext(), "read"));
      expect(r1).toBe(r2);
      expect(r2).not.toContain("Widget");
      expect(r2).not.toContain("TOPSECRET");
      expect(r2).not.toContain("ext-1");
    });

    it("never looks an item up for an unauthenticated (guest) user", async () => {
      const context = makeContext();
      const result = await run(getTool(context), { id: "item-1", user: undefined });
      expect(context.getItem).not.toHaveBeenCalled();
      expect(result.result).toBe(itemNotFoundMessage(context, "read"));
    });

    it("requires id or external_id", async () => {
      const context = makeContext();
      const result = await run(getTool(context), {});
      expect(context.getItem).not.toHaveBeenCalled();
      expect(result.result).toContain("id or external_id");
    });

    it("refuses an unknown or hidden field name with the list of valid names, without reading", async () => {
      const context = makeContext();
      const unknown = await run(getTool(context), { id: "item-1", fields: ["nonsense"] });
      expect(context.getItem).not.toHaveBeenCalled();
      expect(unknown.result).toContain("nonsense");
      expect(unknown.result).toContain("price");
      expect(unknown.result).toContain("specs");

      const hidden = await run(getTool(context), { id: "item-1", fields: ["api_secret"] });
      expect(context.getItem).not.toHaveBeenCalled();
      expect(hidden.result).toContain("api_secret");
      expect(hidden.result).not.toContain("TOPSECRET");
    });

    it("returns a failure as a result string instead of throwing", async () => {
      const context = makeContext({
        getItem: jest.fn(async () => {
          throw new Error("boom");
        }),
      });
      const result = await run(getTool(context), { id: "item-1" });
      expect(result.result).toContain("boom");
    });
  });

  describe("find", () => {
    it("passes the where through as one filter, with the user, the role and the default limit", async () => {
      const context = makeContext();
      const where = { price: { gte: 5 } };
      const result = await run(findTool(context), { where });
      expect(context.getItems).toHaveBeenCalledTimes(1);
      const args = (context.getItems as jest.Mock).mock.calls[0][0];
      expect(args.filters).toEqual([where]);
      expect(args.user).toBe(user);
      expect(args.role).toBe("role-1");
      expect(args.limit).toBe(FIND_DEFAULT_LIMIT);
      expect(result.result).toContain("Found 1 item(s)");
      expect(result.result).toContain("Widget");
    });

    it("clamps the limit instead of rejecting it", async () => {
      const context = makeContext();
      await run(findTool(context), { limit: 500 });
      await run(findTool(context), { limit: 0 });
      await run(findTool(context), { limit: -5 });
      await run(findTool(context), { limit: 7 });
      const limits = (context.getItems as jest.Mock).mock.calls.map((c: any[]) => c[0].limit);
      expect(limits).toEqual([FIND_MAX_LIMIT, FIND_DEFAULT_LIMIT, FIND_DEFAULT_LIMIT, 7]);
    });

    it("omits file fields and hidden fields from the default field list", async () => {
      const context = makeContext();
      await run(findTool(context), {});
      const { fields } = (context.getItems as jest.Mock).mock.calls[0][0];
      expect(fields).toEqual(
        expect.arrayContaining(["id", "updatedAt", "name", "external_id", "price", "specs"]),
      );
      expect(fields).not.toEqual(
        expect.arrayContaining(["api_secret", "manual", "manual_s3key", "manual_s3key as manual"]),
      );
    });

    it("selects a file field under its model-facing name when it is asked for", async () => {
      const context = makeContext();
      await run(findTool(context), { fields: ["manual"] });
      const { fields } = (context.getItems as jest.Mock).mock.calls[0][0];
      expect(fields).toEqual(["id", "manual_s3key as manual"]);
    });

    it("refuses an unknown field name and an unknown where path, without querying", async () => {
      const context = makeContext();
      const badField = await run(findTool(context), { fields: ["nonsense"] });
      expect(badField.result).toContain("nonsense");
      const badWhere = await run(findTool(context), { where: { nonsense: { eq: 1 } } });
      expect(badWhere.result).toContain("nonsense");
      expect(context.getItems).not.toHaveBeenCalled();
    });

    it("surfaces a refused json filter path as a tool result instead of throwing", async () => {
      const error = new UnknownFilterPathError("specs", ["konfidenz"], ["wert", "quelle"]);
      const context = makeContext({
        getItems: jest.fn(async () => {
          throw error;
        }),
      });
      const result = await run(findTool(context), { where: { specs: { contains: { konfidenz: "x" } } } });
      expect(result.result).toBe(error.message);
      expect(result.result).toContain("wert, quelle");
    });

    it("returns an empty result for an unauthenticated (guest) user without querying", async () => {
      const context = makeContext();
      const result = await run(findTool(context), { user: undefined });
      expect(context.getItems).not.toHaveBeenCalled();
      expect(result.result).toContain("Found 0 item(s)");
    });

    it("accepts a nested json object in where through its real input schema", () => {
      const find = findTool(makeContext());
      const parsed = (find.inputSchema as z.ZodObject<any>).safeParse({
        where: { specs: { contains: { wert: "x" } } },
        limit: 5,
      });
      expect(parsed.success).toBe(true);
    });

    it("returns a failure as a result string instead of throwing", async () => {
      const context = makeContext({
        getItems: jest.fn(async () => {
          throw new Error("boom");
        }),
      });
      const result = await run(findTool(context), {});
      expect(result.result).toContain("boom");
    });
  });
});

describe("checkItemReadAccess", () => {
  const context = { id: "products" } as any;

  beforeEach(() => jest.clearAllMocks());

  it("denies without a user and never queries", async () => {
    expect(await checkItemReadAccess(context, { id: "item-1" }, undefined)).toBe(false);
    expect(recordGate).not.toHaveBeenCalled();
  });

  it("grants whatever checkRecordAccess can answer from the row itself", async () => {
    recordGate.mockResolvedValue(true);
    expect(await checkItemReadAccess(context, { id: "i", rights_mode: "public" }, user)).toBe(true);
    expect(recordGate).toHaveBeenCalledWith({ id: "i", rights_mode: "public" }, "read", user);
    expect(rbacWhere).not.toHaveBeenCalled();
  });

  it("falls back to the rbac table for a role-shared item (item rows carry no in-memory RBAC)", async () => {
    recordGate.mockResolvedValue(false);
    rbacRow.mockReturnValue({ id: "grant-1" });
    expect(await checkItemReadAccess(context, { id: "i", rights_mode: "roles" }, user)).toBe(true);
    expect(rbacWhere).toHaveBeenCalledWith({
      entity: "products_items",
      target_resource_id: "i",
      access_type: "Role",
      role_id: "role-1",
    });
  });

  it("denies a shared item without a grant, and a private item of another user", async () => {
    recordGate.mockResolvedValue(false);
    rbacRow.mockReturnValue(undefined);
    expect(await checkItemReadAccess(context, { id: "i", rights_mode: "users" }, user)).toBe(false);
    rbacWhere.mockClear();
    expect(await checkItemReadAccess(context, { id: "i", rights_mode: "private" }, user)).toBe(false);
    expect(rbacWhere).not.toHaveBeenCalled();
  });
});
