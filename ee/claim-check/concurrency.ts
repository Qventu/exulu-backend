// ee/claim-check/concurrency.ts
//
// Bounded fan-out. A check is a few dozen provider calls; letting them all go
// at once manufactures the 429s the retry logic then has to absorb.

export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  const bound = Math.max(1, Math.floor(limit));
  let next = 0;

  const worker = async (): Promise<void> => {
    while (true) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      try {
        results[index] = { status: "fulfilled", value: await fn(items[index]!, index) };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(bound, items.length) }, () => worker()));
  return results;
}
