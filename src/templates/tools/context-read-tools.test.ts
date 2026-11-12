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

// ---------------------------------------------------------------------------
// Fix round 1. F2: a field's model-facing NAME and its physical COLUMN are
// only the same when sanitizeName() leaves the name alone — `Kunden Name`
// lives in `kunden_name`. Everything that reaches SQL must use the column
// (`where` keys, the select list), everything the model reads must use the
// name. F3/F4/F5/F6 ride along below.
// ---------------------------------------------------------------------------
const UMLAUT_FIELDS = [
  { name: "Preis", type: "number" },
  { name: "Kunden Name", type: "text" },
  { name: "Spezifikation", type: "json" },
  { name: "Handbuch", type: "file" },
];

const umlautContext = (overrides: Record<string, unknown> = {}) =>
  makeContext({ id: "angebote", name: "Angebote", fields: UMLAUT_FIELDS, ...overrides });

describe("physical column vs model-facing name (F2)", () => {
  beforeEach(() => jest.clearAllMocks());

  it("maps every where key onto its column before getItems sees it", async () => {
    const context = umlautContext();
    await run(findTool(context), { where: { "Kunden Name": { contains: "Acme" }, Preis: { gte: 10 } } });
    const { filters } = (context.getItems as jest.Mock).mock.calls[0][0];
    expect(filters).toEqual([{ kunden_name: { contains: "Acme" }, preis: { gte: 10 } }]);
  });

  it("maps a json field's key too, so applyFilters recognises it as json", async () => {
    const context = umlautContext();
    await run(findTool(context), { where: { Spezifikation: { contains: { wert: "x" } } } });
    const { filters } = (context.getItems as jest.Mock).mock.calls[0][0];
    // The table definition names this column `spezifikation`; passing
    // "Spezifikation" would miss isJsonField and compile @> to ILIKE.
    expect(filters).toEqual([{ spezifikation: { contains: { wert: "x" } } }]);
  });

  it("aliases the select whenever the column differs from the name, not only for files", async () => {
    const context = umlautContext();
    await run(findTool(context), { fields: ["Kunden Name", "Handbuch", "name"] });
    const { fields } = (context.getItems as jest.Mock).mock.calls[0][0];
    expect(fields).toEqual([
      "id",
      "kunden_name as Kunden Name",
      "handbuch_s3key as Handbuch",
      "name",
    ]);
  });

  it("defaults alias the same way, so find rows come back keyed like get's output", async () => {
    const context = umlautContext();
    await run(findTool(context), {});
    const { fields } = (context.getItems as jest.Mock).mock.calls[0][0];
    expect(fields).toEqual(
      expect.arrayContaining(["preis as Preis", "kunden_name as Kunden Name", "spezifikation as Spezifikation"]),
    );
    const result = await run(getTool(umlautContext({
      getItem: jest.fn(async () => ({ id: "item-1", kunden_name: "Acme", preis: 10 })),
    })), { id: "item-1" });
    const item = JSON.parse(result.result.slice("Item: ".length));
    expect(item["Kunden Name"]).toBe("Acme");
    expect(item.Preis).toBe(10);
  });
});

describe("find hands getItems a usable role (F3)", () => {
  beforeEach(() => jest.clearAllMocks());

  it("passes a bare string role straight through instead of dropping it", async () => {
    const context = makeContext();
    await (findTool(context).tool.execute as any)(
      { user: { id: 7, role: "role-1" }, exuluConfig },
      { toolCallId: "t", messages: [] },
    );
    expect((context.getItems as jest.Mock).mock.calls[0][0].role).toBe("role-1");
  });
});

describe("contains is only offered where it compiles (F4)", () => {
  beforeEach(() => jest.clearAllMocks());

  it("refuses contains on a number, a boolean and a date field with the valid operator list", async () => {
    const context = makeContext();
    for (const where of [
      { price: { contains: 5 } },
      { archived: { contains: true } },
      { released_at: { contains: "2026" } },
    ]) {
      const result = await run(findTool(context), { where });
      expect(result.result).toContain("contains");
      expect(result.result).toContain("eq, ne, in, gte, lte");
      expect(context.getItems).not.toHaveBeenCalled();
    }
  });

  it("keeps contains on text, enum and json fields", async () => {
    const context = makeContext();
    await run(findTool(context), { where: { name: { contains: "wid" } } });
    await run(findTool(context), { where: { category: { contains: "Hard" } } });
    await run(findTool(context), { where: { specs: { contains: { wert: "x" } } } });
    expect(context.getItems).toHaveBeenCalledTimes(3);
  });

  it("accepts an array as a json filter value", () => {
    const find = findTool(makeContext());
    const parsed = (find.inputSchema as z.ZodObject<any>).safeParse({
      where: { specs: { contains: [{ wert: "x" }] } },
    });
    expect(parsed.success).toBe(true);
  });
});

describe("the default read gate is wired (F5)", () => {
  beforeEach(() => jest.clearAllMocks());

  it("uses checkItemReadAccess when no gate is injected: a private row of another user is not found", async () => {
    recordGate.mockResolvedValue(false);
    const context = makeContext({
      getItem: jest.fn(async () => ({ ...ROW, rights_mode: "private", created_by: "8" })),
    });
    const [get] = createContextReadTools(context);
    const result = (await (get!.tool.execute as any)(
      { user, exuluConfig, id: "item-1" },
      { toolCallId: "t", messages: [] },
    )) as { result: string };
    expect(result.result).toBe(itemNotFoundMessage(context, "read"));
    expect(recordGate).toHaveBeenCalledTimes(1);
    // private never reaches the rbac table — there is nothing shared to look up.
    expect(rbacWhere).not.toHaveBeenCalled();
    expect(result.result).not.toContain("TOPSECRET");
  });
});

describe("an explicitly requested field is answered even when it is null (F6)", () => {
  beforeEach(() => jest.clearAllMocks());

  it("states null for a requested empty field, and still omits empty fields from the defaults", async () => {
    const context = makeContext({
      getItem: jest.fn(async () => ({ ...ROW, price: null, audit_note: null })),
    });
    const asked = await run(getTool(context), { id: "item-1", fields: ["price", "audit_note"] });
    const item = JSON.parse(asked.result.slice("Item: ".length));
    expect(item).toEqual({ id: "item-1", price: null, audit_note: null });

    const defaulted = await run(getTool(context), { id: "item-1" });
    const full = JSON.parse(defaulted.result.slice("Item: ".length));
    expect("price" in full).toBe(false);
    expect(full.name).toBe("Widget");
  });
});

// Fix round 2, F4 residual: a `uuid` column is a Postgres uuid, not text —
// ILIKE on it is a 42883 exactly like a numeric column, so `contains` must be
// refused there too.
describe("contains on a uuid field (fix round 2)", () => {
  beforeEach(() => jest.clearAllMocks());

  const operatorKeys = (tool: any, field: string): string[] => {
    const whereSchema = (tool.inputSchema as z.ZodObject<any>).shape.where as any;
    const fieldSchema = (whereSchema.unwrap() as z.ZodObject<any>).shape[field] as any;
    return Object.keys((fieldSchema.unwrap() as z.ZodObject<any>).shape);
  };

  it("is not offered on a uuid field, but still is on a text field", () => {
    const find = findTool(makeContext());
    expect(operatorKeys(find, "legacy_ref")).not.toContain("contains");
    expect(operatorKeys(find, "audit_note")).toContain("contains");
  });

  it("is refused by name with the field's own operator list", async () => {
    const context = makeContext();
    const result = await run(findTool(context), { where: { legacy_ref: { contains: "1111" } } });
    expect(result.result).toContain('"contains"');
    // gte/lte left the uuid list in the final wave (Minor 5) — an ordering on
    // a uuid is an offer nobody means.
    expect(result.result).toContain('Supported operators for "legacy_ref": eq, ne, in');
    expect(context.getItems).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Final fix wave.
// ---------------------------------------------------------------------------
describe("the public agent surface gets guest treatment (Important 3)", () => {
  const publicReq = { headers: { "x-public-surface": "1" } } as any;

  beforeEach(() => jest.clearAllMocks());

  it("refuses get on the public surface even for a signed-in visitor, without a lookup", async () => {
    const context = makeContext();
    const result = await run(getTool(context), { id: "item-1", req: publicReq });
    expect(result.result).toBe(itemNotFoundMessage(context, "read"));
    expect(context.getItem).not.toHaveBeenCalled();
  });

  it("refuses find on the public surface even for a signed-in visitor, without a query", async () => {
    const context = makeContext();
    const result = await run(findTool(context), { req: publicReq });
    expect(result.result).toContain("Found 0 item(s)");
    expect(context.getItems).not.toHaveBeenCalled();
  });
});

describe("id is a uuid column (Important 1)", () => {
  beforeEach(() => jest.clearAllMocks());

  it("offers no contains on id, and refuses one", async () => {
    const context = makeContext();
    const find = findTool(context);
    const whereShape = ((find.inputSchema as z.ZodObject<any>).shape.where as any).unwrap() as z.ZodObject<any>;
    const idOperators = Object.keys(((whereShape.shape.id as any).unwrap() as z.ZodObject<any>).shape);
    expect(idOperators).not.toContain("contains");
    const result = await run(find, { where: { id: { contains: "abc" } } });
    expect(result.result).toContain('Supported operators for "id"');
    expect(context.getItems).not.toHaveBeenCalled();
  });

  it("still filters id by eq and in", async () => {
    const context = makeContext();
    await run(findTool(context), { where: { id: { in: ["a", "b"] } } });
    expect((context.getItems as jest.Mock).mock.calls[0][0].filters).toEqual([{ id: { in: ["a", "b"] } }]);
  });
});

describe("operator surface details (Minors 4, 5, 6, 8)", () => {
  beforeEach(() => jest.clearAllMocks());

  const operatorDescription = (tool: any, field: string): string => {
    const whereShape = ((tool.inputSchema as z.ZodObject<any>).shape.where as any).unwrap() as z.ZodObject<any>;
    return (whereShape.shape[field] as any).description ?? "";
  };

  it("discloses that lte: 0 also matches empty fields, on number and date filters", () => {
    const find = findTool(makeContext());
    for (const field of ["price", "released_at"]) {
      expect(operatorDescription(find, field)).toContain("also matches items where the field is empty");
    }
  });

  it("offers no gte/lte on json and uuid fields, but keeps them on text, number and date", () => {
    const find = findTool(makeContext());
    const operators = (field: string): string[] => {
      const whereShape = ((find.inputSchema as z.ZodObject<any>).shape.where as any).unwrap() as z.ZodObject<any>;
      return Object.keys(((whereShape.shape[field] as any).unwrap() as z.ZodObject<any>).shape);
    };
    for (const field of ["specs", "legacy_ref"]) {
      expect(operators(field)).not.toContain("gte");
      expect(operators(field)).not.toContain("lte");
    }
    for (const field of ["price", "released_at", "audit_note"]) {
      expect(operators(field)).toEqual(expect.arrayContaining(["gte", "lte"]));
    }
  });

  it("refuses gte on a json field by name instead of compiling it", async () => {
    const context = makeContext();
    const result = await run(findTool(context), { where: { specs: { gte: 5 } } });
    expect(result.result).toContain('"gte"');
    expect(result.result).toContain('Supported operators for "specs"');
    expect(context.getItems).not.toHaveBeenCalled();
  });

  it("refuses an empty in list instead of querying with it", async () => {
    const context = makeContext();
    const parsed = (findTool(context).inputSchema as z.ZodObject<any>).safeParse({
      where: { category: { in: [] } },
    });
    expect(parsed.success).toBe(false);
    const result = await run(findTool(context), { where: { category: { in: [] } } });
    expect(result.result).toContain("category");
    expect(context.getItems).not.toHaveBeenCalled();
  });

  it("names the refused json path in model-facing names, not in column names", async () => {
    const error = new UnknownFilterPathError("spezifikation", ["konfidenz"], ["wert"]);
    const context = umlautContext({
      getItems: jest.fn(async () => {
        throw error;
      }),
    });
    const result = await run(findTool(context), {
      where: { Spezifikation: { contains: { konfidenz: "x" } } },
    });
    expect(result.result).toContain('"Spezifikation"');
    expect(result.result).not.toContain("spezifikation");
    expect(result.result).toContain("wert");
  });

  it("clamps a numeric string limit instead of rejecting it", async () => {
    const context = makeContext();
    const parsed = (findTool(context).inputSchema as z.ZodObject<any>).safeParse({ limit: "10" });
    expect(parsed.success).toBe(true);
    await run(findTool(context), { limit: "10" });
    await run(findTool(context), { limit: "500" });
    const limits = (context.getItems as jest.Mock).mock.calls.map((c: any[]) => c[0].limit);
    expect(limits).toEqual([10, FIND_MAX_LIMIT]);
  });

  it("tells the model what the fields default to (Minor 7)", () => {
    const find = findTool(makeContext());
    const get = getTool(makeContext());
    const describeOf = (tool: any) => (tool.inputSchema as z.ZodObject<any>).shape.fields.description ?? "";
    for (const tool of [find, get]) {
      expect(describeOf(tool)).toContain("id");
      expect(describeOf(tool)).toContain("always");
    }
  });
});
