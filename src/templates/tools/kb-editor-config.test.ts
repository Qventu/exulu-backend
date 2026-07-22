import { parseKbEditorConfig, KB_EDITOR_TOOL_ID } from "./kb-editor-config";

const entry = (config: any[]) => [{ id: KB_EDITOR_TOOL_ID, type: "function", config }];

describe("parseKbEditorConfig", () => {
  it("returns disabled empty config when the entry is absent", () => {
    expect(parseKbEditorConfig([])).toEqual({ enabled: false, knowledgeBases: {}, skipApproval: false });
    expect(parseKbEditorConfig(undefined)).toEqual({ enabled: false, knowledgeBases: {}, skipApproval: false });
    expect(parseKbEditorConfig(null)).toEqual({ enabled: false, knowledgeBases: {}, skipApproval: false });
  });

  it("parses knowledge_bases from a JSON string in `variable`", () => {
    const result = parseKbEditorConfig(
      entry([
        {
          name: "knowledge_bases",
          type: "json",
          variable: JSON.stringify({ products: { create: true, update: true }, faq: { create: true, update: false } }),
        },
      ]) as any,
    );
    expect(result.enabled).toBe(true);
    expect(result.knowledgeBases).toEqual({
      products: { create: true, update: true },
      faq: { create: true, update: false },
    });
  });

  it("prefers hydrated `value` over `variable`", () => {
    const result = parseKbEditorConfig(
      entry([
        {
          name: "knowledge_bases",
          type: "json",
          variable: JSON.stringify({ old: { create: true, update: false } }),
          value: { fresh: { create: true, update: true } },
        },
      ]) as any,
    );
    expect(result.knowledgeBases).toEqual({ fresh: { create: true, update: true } });
  });

  it("accepts agents.tools arriving as a JSON string (legacy)", () => {
    const tools = JSON.stringify(
      entry([{ name: "knowledge_bases", type: "json", variable: JSON.stringify({ a_ctx: { create: true, update: false } }) }]),
    );
    expect(parseKbEditorConfig(tools).knowledgeBases).toEqual({ a_ctx: { create: true, update: false } });
  });

  it("degrades to empty on malformed JSON and never throws", () => {
    expect(parseKbEditorConfig("not json").enabled).toBe(false);
    const result = parseKbEditorConfig(entry([{ name: "knowledge_bases", type: "json", variable: "{broken" }]) as any);
    expect(result).toEqual({ enabled: true, knowledgeBases: {}, skipApproval: false });
  });

  it("drops contexts with malformed profiles and contexts with no permission granted (explicit opt-in)", () => {
    const result = parseKbEditorConfig(
      entry([
        {
          name: "knowledge_bases",
          type: "json",
          variable: JSON.stringify({
            good: { create: true, update: false },
            noperms: { create: false, update: false },
            weird: "yes",
          }),
        },
      ]) as any,
    );
    expect(result.knowledgeBases).toEqual({ good: { create: true, update: false } });
  });

  it("coerces non-boolean create/update flags to false", () => {
    const result = parseKbEditorConfig(
      entry([
        { name: "knowledge_bases", type: "json", variable: JSON.stringify({ ctx_a: { create: "yes", update: true } }) },
      ]) as any,
    );
    expect(result.knowledgeBases).toEqual({ ctx_a: { create: false, update: true } });
  });

  it("parses skip_approval from boolean-ish values", () => {
    expect(parseKbEditorConfig(entry([{ name: "skip_approval", type: "boolean", variable: "true" }]) as any).skipApproval).toBe(true);
    expect(parseKbEditorConfig(entry([{ name: "skip_approval", type: "boolean", variable: true }]) as any).skipApproval).toBe(true);
    expect(parseKbEditorConfig(entry([{ name: "skip_approval", type: "boolean", variable: "false" }]) as any).skipApproval).toBe(false);
    expect(parseKbEditorConfig(entry([]) as any).skipApproval).toBe(false);
  });
});
