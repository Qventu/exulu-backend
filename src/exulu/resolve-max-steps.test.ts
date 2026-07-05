import { resolveMaxStepsFromToolConfigs } from "./resolve-max-steps";

const cfg = (entries: { name: string; variable: any; type: string }[]) =>
  [{ id: "agentic_context_search", type: "context", name: "Context Search", config: entries }] as any;

describe("resolveMaxStepsFromToolConfigs", () => {
  it("returns the configured positive integer (string-stored, platform convention)", () => {
    expect(resolveMaxStepsFromToolConfigs(cfg([{ name: "max_steps", variable: "4", type: "number" }]))).toBe(4);
  });

  it("accepts numeric values and floors them", () => {
    expect(resolveMaxStepsFromToolConfigs(cfg([{ name: "max_steps", variable: 6.7, type: "number" }]))).toBe(6);
  });

  it("returns undefined for unset, zero, negative, or garbage values", () => {
    expect(resolveMaxStepsFromToolConfigs(undefined)).toBeUndefined();
    expect(resolveMaxStepsFromToolConfigs([] as any)).toBeUndefined();
    expect(resolveMaxStepsFromToolConfigs(cfg([]))).toBeUndefined();
    expect(resolveMaxStepsFromToolConfigs(cfg([{ name: "max_steps", variable: "0", type: "number" }]))).toBeUndefined();
    expect(resolveMaxStepsFromToolConfigs(cfg([{ name: "max_steps", variable: "-3", type: "number" }]))).toBeUndefined();
    expect(resolveMaxStepsFromToolConfigs(cfg([{ name: "max_steps", variable: "banana", type: "number" }]))).toBeUndefined();
  });

  it("ignores other tools' configs", () => {
    const configs = [{ id: "other_tool", type: "function", name: "x", config: [{ name: "max_steps", variable: "9", type: "number" }] }] as any;
    expect(resolveMaxStepsFromToolConfigs(configs)).toBeUndefined();
  });

  it("prefers hydrated value over raw variable when present", () => {
    expect(resolveMaxStepsFromToolConfigs(cfg([{ name: "max_steps", variable: "2", value: 8, type: "number" } as any]))).toBe(8);
  });
});
