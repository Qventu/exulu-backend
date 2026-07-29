import { computeRunCostUsd } from "./run-cost";

const price = {
  input_cost_per_million_tokens: 3, // $3 / 1M input
  output_cost_per_million_tokens: 15, // $15 / 1M output
};

describe("computeRunCostUsd", () => {
  it("computes cost from tokens and per-million prices", () => {
    // 1,000,000 in * $3/M + 500,000 out * $15/M = 3 + 7.5 = 10.5
    expect(computeRunCostUsd(1_000_000, 500_000, price)).toBeCloseTo(10.5, 6);
  });
  it("is zero for zero tokens", () => {
    expect(computeRunCostUsd(0, 0, price)).toBe(0);
  });
  it("returns null when price is missing", () => {
    expect(computeRunCostUsd(1000, 1000, null)).toBeNull();
    expect(computeRunCostUsd(1000, 1000, undefined)).toBeNull();
  });
  it("returns null when either per-million price is null or non-finite", () => {
    expect(
      computeRunCostUsd(1000, 1000, {
        input_cost_per_million_tokens: null,
        output_cost_per_million_tokens: 15,
      }),
    ).toBeNull();
    expect(
      computeRunCostUsd(1000, 1000, {
        input_cost_per_million_tokens: 3,
        output_cost_per_million_tokens: Number.NaN,
      }),
    ).toBeNull();
  });
  it("treats missing token counts as zero", () => {
    expect(
      computeRunCostUsd(undefined as unknown as number, 1_000_000, price),
    ).toBeCloseTo(15, 6);
  });
});
