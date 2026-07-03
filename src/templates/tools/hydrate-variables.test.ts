// Mock the modules with ESM dependencies before importing the main module
jest.mock("@EE/agentic-retrieval/pipeline/index", () => ({
  createAgenticRetrievalTool: jest.fn(),
}));

jest.mock("@SRC/postgres/client", () => ({
  postgresClient: async () => ({ db: jest.fn() }),
}));

import { hydrateVariables } from "./convert-exulu-tools-to-ai-sdk-tools";

// hydrateVariables only touches the DB for type:"variable"; json/boolean/number/string
// never reach postgres. Mock the client so importing the module never connects.

const toolWith = (config: any[]) => ({ id: "t", type: "function", name: "t", config }) as any;

describe("hydrateVariables json type", () => {
  it("parses a valid json string into an object value", async () => {
    const tool = toolWith([{ name: "routing", type: "json", variable: '{"rules":[{"id":"a"}]}' }]);
    const result = await hydrateVariables(tool);
    expect(result.config[0].value).toEqual({ rules: [{ id: "a" }] });
  });

  it("leaves value undefined on unparseable json (consumer falls back to defaults)", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const tool = toolWith([{ name: "routing", type: "json", variable: "{not json" }]);
    const result = await hydrateVariables(tool);
    expect(result.config[0].value).toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("passes through an already-parsed object value", async () => {
    const tool = toolWith([{ name: "memory", type: "json", variable: { enabled: true } }]);
    const result = await hydrateVariables(tool);
    expect(result.config[0].value).toEqual({ enabled: true });
  });

  it("keeps boolean coercion behavior unchanged", async () => {
    const tool = toolWith([{ name: "flag", type: "boolean", variable: "true" }]);
    const result = await hydrateVariables(tool);
    expect(result.config[0].value).toBe(true);
  });
});
