/**
 * Approximate per-run $ cost from token totals × the run model's catalog list
 * price. Approximate by design (spec): no prompt-cache discount, agent-LLM
 * calls only. Returns null when pricing is unavailable so callers can render
 * "—" rather than a fabricated $0.
 */
export interface RunCostPrice {
  input_cost_per_million_tokens: number | null;
  output_cost_per_million_tokens: number | null;
}

export function computeRunCostUsd(
  inputTokens: number,
  outputTokens: number,
  price: RunCostPrice | null | undefined,
): number | null {
  if (!price) return null;
  const inPrice = price.input_cost_per_million_tokens;
  const outPrice = price.output_cost_per_million_tokens;
  if (
    inPrice == null ||
    outPrice == null ||
    !Number.isFinite(inPrice) ||
    !Number.isFinite(outPrice)
  ) {
    return null;
  }
  const inTok = Number.isFinite(inputTokens) ? inputTokens : 0;
  const outTok = Number.isFinite(outputTokens) ? outputTokens : 0;
  return (inTok / 1_000_000) * inPrice + (outTok / 1_000_000) * outPrice;
}
