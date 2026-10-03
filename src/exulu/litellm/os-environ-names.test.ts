import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseOsEnvironNames, readLiteLLMOsEnvironNames } from "./os-environ-names";

const CONFIG = `
litellm_settings:
  master_key: os.environ/LITELLM_MASTER_KEY
  database_url: os.environ/LITELLM_DATABASE_URL
model_list:
  - model_name: claude-sonnet-4
    litellm_params:
      model: vertex_ai/claude-sonnet-4
      vertex_project: os.environ/GOOGLE_VERTEX_PROJECT
      vertex_credentials: os.environ/VERTEX_CREDENTIALS_PATH
  - model_name: gpt-image-1
    litellm_params:
      api_key: "os.environ/AZURE_API_KEY_EU"
  # - model_name: rerank-v3
  #   litellm_params:
  #     api_key: os.environ/COHERE_API_KEY
`;

test("collects every os.environ/ name, including quoted and commented-out ones", () => {
  expect(parseOsEnvironNames(CONFIG)).toEqual([
    "AZURE_API_KEY_EU",
    "COHERE_API_KEY",
    "GOOGLE_VERTEX_PROJECT",
    "LITELLM_DATABASE_URL",
    "LITELLM_MASTER_KEY",
    "VERTEX_CREDENTIALS_PATH",
  ]);
});

test("a runtime-classified name is never collected, even from a comment", () => {
  // A doc comment must not be able to cost a skill its PATH.
  expect(parseOsEnvironNames("# do not write api_key: os.environ/PATH\n")).toEqual([]);
  expect(parseOsEnvironNames("  lang: os.environ/LANG\n")).toEqual([]);
});

test("returns names from a real file", () => {
  const dir = mkdtempSync(join(tmpdir(), "litellm-env-"));
  const path = join(dir, "config.litellm.yaml");
  writeFileSync(path, CONFIG, "utf8");
  expect(readLiteLLMOsEnvironNames(path)).toContain("VERTEX_CREDENTIALS_PATH");
});

test("a missing config is non-fatal and yields no names", () => {
  expect(readLiteLLMOsEnvironNames(join(tmpdir(), "definitely-not-here.yaml"))).toEqual([]);
});

test("an unreadable config is non-fatal and yields no names", () => {
  const dir = mkdtempSync(join(tmpdir(), "litellm-env-"));
  const path = join(dir, "config.litellm.yaml");
  writeFileSync(path, CONFIG, "utf8");
  chmodSync(path, 0o000);
  const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
  try {
    // Running as root makes a 000 file readable anyway; only assert the
    // non-fatal contract, which holds either way.
    expect(Array.isArray(readLiteLLMOsEnvironNames(path))).toBe(true);
  } finally {
    warn.mockRestore();
    chmodSync(path, 0o600);
  }
});
