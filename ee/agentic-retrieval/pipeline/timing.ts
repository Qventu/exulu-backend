/**
 * Sub-phase timing for the agentic retrieval pipeline.
 *
 * The pipeline reports phase durations ("memoryRoutingMs", "searchMs", …) in
 * its result so slow retrievals can be diagnosed from the chat transcript
 * alone. withTiming adds the next level down (an LLM hop inside the memory
 * phase, one knowledge base inside the search fan-out) without threading
 * clocks through every function: pass the shared sink and a key, get the
 * awaited value back. Elapsed time is recorded even when the work throws.
 */
export type TimingSink = Record<string, number>;

export async function withTiming<T>(
  sink: TimingSink | undefined,
  key: string,
  work: () => Promise<T>,
  now: () => number = Date.now,
): Promise<T> {
  if (!sink) return work();
  const started = now();
  try {
    return await work();
  } finally {
    sink[key] = Math.max(0, now() - started);
  }
}
