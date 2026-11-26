import { MockLanguageModelV3 } from "ai/test";
import {
  OUTPUT_SCHEMA_MAX_BYTES,
  OutputSchemaInvalidError,
  OutputSchemaMismatchError,
  messageText,
  parseOutputSchema,
  readOutputSchema,
  respondWithOutputSchema,
  shapeOutput,
} from "./output-schema";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const rec = {
  type: "object",
  properties: { key: { type: "string" }, level: { type: "integer" } },
  required: ["key", "level"],
};

/** The schema shapes the Zod round trip of the March 2026 version broke on (design, "Why no Zod conversion"). */
const cases: { name: string; schema: any; good: unknown; bad: unknown }[] = [
  {
    name: "nested arrays and bounds",
    schema: {
      type: "object",
      properties: {
        summary: { type: "string" },
        items: { type: "array", minItems: 1, items: { type: "object", properties: { priority: { type: "integer", minimum: 1, maximum: 5 } }, required: ["priority"] } },
      },
      required: ["summary", "items"],
    },
    good: { summary: "a", items: [{ priority: 3 }] },
    bad: { summary: "a", items: [{ priority: 9 }] },
  },
  {
    name: "enum with additionalProperties: false",
    schema: { type: "object", properties: { level: { type: "string", enum: ["low", "high"] } }, required: ["level"], additionalProperties: false },
    good: { level: "low" },
    bad: { level: "low", extra: 1 },
  },
  {
    name: "nullable through a type array",
    schema: { type: "object", properties: { value: { type: ["number", "null"] } }, required: ["value"] },
    good: { value: null },
    bad: { value: "12" },
  },
  {
    name: "anyOf",
    schema: { type: "object", properties: { result: { anyOf: [{ type: "string" }, rec] } }, required: ["result"] },
    good: { result: { key: "k", level: 1 } },
    bad: { result: 5 },
  },
  {
    name: "oneOf with const",
    schema: {
      type: "object",
      properties: { item: { oneOf: [
        { type: "object", properties: { kind: { const: "text" }, text: { type: "string" } }, required: ["kind", "text"] },
        { type: "object", properties: { kind: { const: "number" }, value: { type: "number" } }, required: ["kind", "value"] },
      ] } },
      required: ["item"],
    },
    good: { item: { kind: "number", value: 2 } },
    bad: { item: { kind: "number", text: "x" } },
  },
  {
    name: "$ref into $defs",
    schema: { type: "object", $defs: { rec }, properties: { first: { $ref: "#/$defs/rec" }, others: { type: "array", items: { $ref: "#/$defs/rec" } } }, required: ["first", "others"] },
    good: { first: { key: "a", level: 1 }, others: [] },
    bad: { first: { key: "a" }, others: [] },
  },
  {
    name: "draft-07 definitions",
    schema: {
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      definitions: { tag: { type: "string", enum: ["a", "b"] } },
      properties: { tags: { type: "array", items: { $ref: "#/definitions/tag" } } },
      required: ["tags"],
    },
    good: { tags: ["a"] },
    bad: { tags: ["z"] },
  },
  {
    name: "formats and pattern",
    schema: { type: "object", properties: { date: { type: "string", format: "date" }, code: { type: "string", pattern: "^[A-Z]{3}$" } }, required: ["date", "code"] },
    good: { date: "2026-03-14", code: "ABC" },
    bad: { date: "14.03.2026", code: "ABC" },
  },
  {
    name: "a map of numbers",
    schema: { type: "object", properties: { scores: { type: "object", additionalProperties: { type: "number" } } }, required: ["scores"] },
    good: { scores: { a: 1.5 } },
    bad: { scores: { a: "high" } },
  },
];

describe("parseOutputSchema", () => {
  it.each(cases)("validates against the caller's own schema: $name", ({ schema, good, bad }) => {
    const parsed = parseOutputSchema(schema);
    expect(parsed.jsonSchema).toBe(schema);
    expect(parsed.validate(good)).toEqual([]);
    const issues = parsed.validate(bad);
    expect(issues.length).toBeGreaterThan(0);
    expect(typeof issues[0].path).toBe("string");
    expect(typeof issues[0].message).toBe("string");
  });

  it("accepts the schema as a JSON string", () => {
    const parsed = parseOutputSchema(JSON.stringify(rec));
    expect(parsed.jsonSchema).toEqual(rec);
    expect(parsed.validate({ key: "a", level: 1 })).toEqual([]);
  });

  it.each([
    ["a string that is not JSON", "{nope"],
    ["an array", [rec]],
    ["null", null],
    ["a root that is not an object type", { type: "array", items: { type: "string" } }],
    ["a root without a type", { properties: { a: { type: "string" } } }],
    ["a schema Ajv cannot compile", { type: "object", properties: { a: { type: "nonsense" } } }],
    ["a reference that leads nowhere", { type: "object", properties: { a: { $ref: "#/$defs/missing" } } }],
  ])("refuses %s", (_name, raw) => {
    expect(() => parseOutputSchema(raw)).toThrow(OutputSchemaInvalidError);
  });

  it("refuses a schema above the size limit", () => {
    const big = { type: "object", properties: { a: { type: "string", description: "x".repeat(OUTPUT_SCHEMA_MAX_BYTES) } } };
    expect(() => parseOutputSchema(big)).toThrow(/too large/i);
  });
});

const usage = (input: number, output: number) => ({
  inputTokens: { total: input, noCache: input, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: output, text: output, reasoning: 0 },
});

/** A model that answers each call with the next prepared tool input. */
const modelReturning = (...inputs: unknown[]) => {
  const calls: any[] = [];
  const model = new MockLanguageModelV3({
    doGenerate: async (options: any) => {
      calls.push(options);
      const input = inputs[Math.min(calls.length - 1, inputs.length - 1)];
      return {
        content: [{ type: "tool-call", toolCallId: `call-${calls.length}`, toolName: "submit_output", input: JSON.stringify(input) }],
        finishReason: { unified: "tool-calls", raw: "tool_calls" },
        usage: usage(10, 5),
        warnings: [],
      };
    },
  } as any);
  return { model, calls };
};

describe("shapeOutput", () => {
  const schema = parseOutputSchema(rec);
  const base = { system: "Agent instructions.", answer: "Body fat is level 4." };

  it("returns the object when the first attempt validates, forcing the one tool with the caller's schema", async () => {
    const { model, calls } = modelReturning({ key: "body fat", level: 4 });
    const result = await shapeOutput({ ...base, model, schema });
    expect(result.output).toEqual({ key: "body fat", level: 4 });
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
    expect(calls).toHaveLength(1);
    expect(calls[0].tools).toHaveLength(1);
    expect(calls[0].tools[0].name).toBe("submit_output");
    expect(calls[0].tools[0].inputSchema).toEqual(rec);
    expect(calls[0].toolChoice).toEqual({ type: "tool", toolName: "submit_output" });
    expect(JSON.stringify(calls[0].prompt)).toContain("Body fat is level 4.");
  });

  it("repairs once: the second attempt sees the issues and usage is summed", async () => {
    const { model, calls } = modelReturning({ key: "body fat", level: "four" }, { key: "body fat", level: 4 });
    const result = await shapeOutput({ ...base, model, schema });
    expect(result.output).toEqual({ key: "body fat", level: 4 });
    expect(result.usage).toEqual({ inputTokens: 20, outputTokens: 10 });
    expect(calls).toHaveLength(2);
    expect(JSON.stringify(calls[1].prompt)).toContain("/level");
  });

  it("throws with the issues and the answer when the repair fails too, after exactly two attempts", async () => {
    const { model, calls } = modelReturning({ key: "body fat", level: "four" });
    const error = await shapeOutput({ ...base, model, schema }).catch((e) => e);
    expect(error).toBeInstanceOf(OutputSchemaMismatchError);
    expect(error.text).toBe("Body fat is level 4.");
    expect(error.issues[0].path).toBe("/level");
    expect(error.usage).toEqual({ inputTokens: 20, outputTokens: 10 });
    expect(calls).toHaveLength(2);
  });
});

describe("readOutputSchema", () => {
  it("is absent when the request has none", () => {
    expect(readOutputSchema(undefined, false)).toEqual({});
    expect(readOutputSchema(undefined, true)).toEqual({});
  });
  it("refuses a schema on a streaming request", () => {
    expect(readOutputSchema(rec, true).error).toMatchObject({ error: "output_schema_not_streamable" });
  });
  it("reports an unusable schema", () => {
    const result = readOutputSchema({ type: "array" }, false);
    expect(result.error).toMatchObject({ error: "output_schema_invalid" });
    expect(result.error?.message).toContain('"type": "object"');
    expect(result.schema).toBeUndefined();
  });
  it("returns the parsed schema", () => {
    expect(readOutputSchema(rec, false).schema?.jsonSchema).toBe(rec);
  });
});

describe("messageText", () => {
  it("joins the text parts of a UI message and ignores the rest", () => {
    expect(messageText({ role: "user", parts: [{ type: "text", text: "a" }, { type: "file", url: "x" }, { type: "text", text: "b" }] })).toBe("a\nb");
  });
  it("reads plain content and survives anything else", () => {
    expect(messageText({ role: "user", content: "hello" })).toBe("hello");
    expect(messageText(undefined)).toBe("");
    expect(messageText("text")).toBe("text");
  });
});

describe("respondWithOutputSchema", () => {
  const schema = parseOutputSchema(rec);

  it("answers 200 with the bare object and reports the usage", async () => {
    const { model } = modelReturning({ key: "body fat", level: 4 });
    const recorded: unknown[] = [];
    const result = await respondWithOutputSchema({ model, schema, answer: "Body fat is level 4.", onUsage: async (u) => void recorded.push(u) });
    expect(result).toEqual({ status: 200, body: { key: "body fat", level: 4 } });
    expect(recorded).toEqual([{ inputTokens: 10, outputTokens: 5 }]);
  });

  it("answers 422 with issues and the plain answer, and still reports the usage", async () => {
    const { model } = modelReturning({ key: "body fat" });
    const recorded: unknown[] = [];
    const result = await respondWithOutputSchema({ model, schema, answer: "Body fat is high.", onUsage: async (u) => void recorded.push(u) });
    expect(result.status).toBe(422);
    expect(result.body).toMatchObject({ error: "output_schema_mismatch", text: "Body fat is high." });
    expect((result.body as any).issues.length).toBeGreaterThan(0);
    expect(recorded).toEqual([{ inputTokens: 20, outputTokens: 10 }]);
  });

  it("lets other failures (the model call itself) propagate", async () => {
    const model = new MockLanguageModelV3({ doGenerate: async () => { throw new Error("gateway down"); } } as any);
    await expect(respondWithOutputSchema({ model, schema, answer: "x" })).rejects.toThrow("gateway down");
  });
});

/** Source gate, as in chat-route-wiring.test.ts: the run handler is a closure no test builds. */
describe("run route wiring", () => {
  const source = readFileSync(join(__dirname, "routes.ts"), "utf8");
  it("checks the schema before any model work and stops on an error", () => {
    const check = source.indexOf("readOutputSchema(req.body?.outputSchema, headers.stream)");
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(source.indexOf("if (!!headers.stream) {", check));
    expect(source).toContain("res.status(400).json(outputSchemaRequest.error);");
  });
  it("tells the agent about the structure and shapes the answer", () => {
    expect(source).toContain("outputSchemaInstructions(outputSchema)");
    expect(source).toContain("await respondWithOutputSchema({");
  });
});

/**
 * The package is published as ESM and ajv has no exports map, so Node only
 * resolves a deep import that names the file. Jest resolves the short form
 * too, which is how 5.17.0 shipped with `ajv/dist/2020` and failed at import
 * in every consumer ("Cannot find module .../ajv/dist/2020").
 */
describe("deep imports into ajv", () => {
  it("name the file with its extension", () => {
    const source = readFileSync(join(__dirname, "output-schema.ts"), "utf8");
    const deep = [...source.matchAll(/from "(ajv\/[^"]+)"/g)].map((m) => m[1]);
    expect(deep).toEqual(["ajv/dist/2020.js"]);
  });
});
