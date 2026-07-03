import { migrateAgenticToolConfig } from "./migrate-agentic-retrieval-config";

const oldTool = {
  id: "agentic_context_search",
  config: [
    { name: "instructions", variable: "be careful", type: "string" },
    { name: "managed_context", variable: "true", type: "boolean" },
    { name: "reasoning_model", variable: "gpt", type: "string" },
    { name: "ctxA_|_enabled", variable: "false", type: "boolean" },
    { name: "ctxA_|_instructions", variable: "check here first", type: "string" },
    { name: "ctxA_|_max_results", variable: "50", type: "number" },
    { name: "ctxA_|_expand_chunks", variable: "3", type: "number" },
    { name: "ctxA_|_priority", variable: "2", type: "number" },
    { name: "ctxB_|_enabled", variable: "true", type: "boolean" },
  ],
};

describe("migrateAgenticToolConfig", () => {
  it("folds per-context keys into knowledge_bases and drops dead keys", () => {
    const migrated = migrateAgenticToolConfig(oldTool as any)!;
    const byName = Object.fromEntries(migrated.config.map((c) => [c.name, c]));
    expect(byName["instructions"].variable).toBe("be careful");
    expect(byName["managed_context"].variable).toBe("true");
    expect(byName["reasoning_model"]).toBeUndefined();
    expect(byName["ctxA_|_enabled"]).toBeUndefined();
    const kbs = JSON.parse(byName["knowledge_bases"].variable);
    expect(kbs.ctxA).toEqual({ enabled: false, instructions: "check here first", overrides: { limit: 50, expand: 3 } });
    expect(kbs.ctxB).toBeUndefined(); // enabled=true with no other values is the default — omitted
    expect(byName["knowledge_bases"].type).toBe("json");
    expect(byName["routing"].variable).toBe("");
  });

  it("returns null for already-migrated tools and for other tools", () => {
    expect(migrateAgenticToolConfig({ id: "agentic_context_search",
      config: [{ name: "knowledge_bases", variable: "{}", type: "json" }] } as any)).toBeNull();
    expect(migrateAgenticToolConfig({ id: "other_tool", config: [{ name: "a_|_b", variable: "x", type: "string" }] } as any)).toBeNull();
  });
});
