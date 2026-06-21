import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseRerankerModels,
  getRerankerModelInfo,
} from "./parse-reranker-models";

let dir: string;
const writeConfig = (yaml: string): string => {
  const p = join(dir, "config.litellm.yaml");
  writeFileSync(p, yaml, "utf8");
  return p;
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "reranker-cfg-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("parseRerankerModels", () => {
  test("returns only entries with model_info.type: reranker", () => {
    const path = writeConfig(`
model_list:
  - model_name: gemini-embedding-001
    litellm_params:
      model: gemini/gemini-embedding-001
    model_info:
      dimensionality: 1024
  - model_name: rerank-v4.0-pro
    litellm_params:
      model: cohere/rerank-v4.0-pro
      api_key: os.environ/COHERE_API_KEY
    model_info:
      type: reranker
      top_n: 20
      description: "Cohere rerank v4 (pro)"
  - model_name: vertex-flash
    litellm_params:
      model: vertex_ai/gemini-2.5-flash
`);
    const models = parseRerankerModels(path);
    expect(models).toEqual([
      {
        model_name: "rerank-v4.0-pro",
        topN: 20,
        description: "Cohere rerank v4 (pro)",
      },
    ]);
  });

  test("topN/description are optional", () => {
    const path = writeConfig(`
model_list:
  - model_name: bare-reranker
    litellm_params:
      model: cohere/rerank-english-v3.0
    model_info:
      type: reranker
`);
    expect(parseRerankerModels(path)).toEqual([
      { model_name: "bare-reranker", topN: undefined, description: undefined },
    ]);
  });

  test("skips commented-out reranker blocks", () => {
    const path = writeConfig(`
model_list:
  # - model_name: disabled-reranker
  #   litellm_params:
  #     model: cohere/rerank-english-v3.0
  #   model_info:
  #     type: reranker
  - model_name: active-reranker
    litellm_params:
      model: cohere/rerank-v4.0-pro
    model_info:
      type: reranker  # trailing comment ignored
`);
    expect(parseRerankerModels(path).map((m) => m.model_name)).toEqual([
      "active-reranker",
    ]);
  });

  test("ignores non-positive top_n", () => {
    const path = writeConfig(`
model_list:
  - model_name: r
    litellm_params:
      model: cohere/rerank-v4.0-pro
    model_info:
      type: reranker
      top_n: 0
`);
    expect(parseRerankerModels(path)[0]?.topN).toBeUndefined();
  });

  test("returns [] when the config file is missing", () => {
    expect(parseRerankerModels(join(dir, "nope.yaml"))).toEqual([]);
  });
});

describe("getRerankerModelInfo", () => {
  test("returns the matching reranker", () => {
    const path = writeConfig(`
model_list:
  - model_name: rerank-v4.0-pro
    litellm_params:
      model: cohere/rerank-v4.0-pro
    model_info:
      type: reranker
      top_n: 20
`);
    expect(getRerankerModelInfo("rerank-v4.0-pro", path)).toEqual({
      model_name: "rerank-v4.0-pro",
      topN: 20,
      description: undefined,
    });
  });

  test("throws an actionable error when undeclared", () => {
    const path = writeConfig(`
model_list:
  - model_name: some-embedder
    litellm_params:
      model: gemini/gemini-embedding-001
    model_info:
      dimensionality: 1024
`);
    expect(() => getRerankerModelInfo("missing-reranker", path)).toThrow(
      /Reranker model "missing-reranker" was not found/,
    );
  });
});
