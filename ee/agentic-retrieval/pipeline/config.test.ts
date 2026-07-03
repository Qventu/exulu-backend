import { parsePipelineConfig, effectiveKbSettings, KIND_PRESETS } from "./config";

describe("parsePipelineConfig", () => {
  it("returns full defaults for an empty/missing config", () => {
    const cfg = parsePipelineConfig(undefined);
    expect(cfg.tuning).toEqual({ topK: 5, fallbackThreshold: 0.95, pinBoost: 0.15,
      identifierBoost: 0.15, pageWindow: 1, maxQueriesPerContext: 5 });
    expect(cfg.memory).toEqual({ enabled: true, override: false, filePrioritization: false, queryAugmentation: true });
    expect(cfg.routing.rules).toEqual([]);
    expect(cfg.knowledgeBases).toEqual({});
    expect(cfg.managedContext).toBe(false);
    expect(cfg.reranker).toBe("none");
  });

  it("accepts parsed objects and JSON strings for json options", () => {
    const cfg = parsePipelineConfig({
      routing: { rules: [{ id: "tech", label: "T", description: "d", main: ["a"], fallback: [] }] },
      tuning: '{"topK": 8}',
      managed_context: "true",
    });
    expect(cfg.routing.rules[0].id).toBe("tech");
    expect(cfg.tuning.topK).toBe(8);
    expect(cfg.tuning.fallbackThreshold).toBe(0.95); // partial json keeps other defaults
    expect(cfg.managedContext).toBe(true);
  });

  it("falls back to defaults on malformed json values", () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const cfg = parsePipelineConfig({ vocabulary: "{oops", memory: 42 });
    expect(cfg.vocabulary.glossary).toEqual([]);
    expect(cfg.memory.enabled).toBe(true);
    warn.mockRestore();
  });
});

describe("effectiveKbSettings", () => {
  it("applies kind presets", () => {
    const s = effectiveKbSettings({ enabled: true, kind: "documents", instructions: "", overrides: {} }, {});
    expect(s).toMatchObject({ limit: 100, expand: { before: 7, after: 7 }, multiQuery: true, hyde: true });
    expect(KIND_PRESETS.conversations.keywordPrefilter).toBe(true);
  });

  it("precedence: overrides > context.configuration > preset", () => {
    const ctx = { configuration: { expand: { before: 3, after: 3 }, cutoffs: { hybrid: 1.1 }, maxRetrievalResults: 40 } };
    const s = effectiveKbSettings({ enabled: true, kind: "documents", instructions: "", overrides: { limit: 60 } }, ctx);
    expect(s.limit).toBe(60);                       // override wins
    expect(s.expand).toEqual({ before: 3, after: 3 }); // context config beats preset
    expect(s.cutoffs).toEqual({ hybrid: 1.1 });
  });

  it("defaults a missing profile to enabled documents", () => {
    const s = effectiveKbSettings(undefined, {});
    expect(s.kind).toBe("documents");
  });
});
