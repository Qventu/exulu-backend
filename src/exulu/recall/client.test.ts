import { fetch_with_retry } from "./client";

type FakeHeaders = Record<string, string>;
const res = (status: number, headers: FakeHeaders = {}) =>
  ({
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
  }) as unknown as Response;

describe("fetch_with_retry", () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it("returns a 2xx response immediately without retrying", async () => {
    const fetchMock = jest.fn().mockResolvedValue(res(200));
    global.fetch = fetchMock as unknown as typeof fetch;
    const r = await fetch_with_retry({ url: "https://x", options: {} });
    expect(r.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not retry a non-retryable 4xx", async () => {
    const fetchMock = jest.fn().mockResolvedValue(res(400));
    global.fetch = fetchMock as unknown as typeof fetch;
    const r = await fetch_with_retry({ url: "https://x", options: {} });
    expect(r.status).toBe(400);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries on 429 honoring Retry-After, then returns success", async () => {
    jest.useFakeTimers();
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(res(429, { "retry-after": "1" }))
      .mockResolvedValueOnce(res(200));
    global.fetch = fetchMock as unknown as typeof fetch;

    const p = fetch_with_retry({ url: "https://x", options: {} });
    // 1s Retry-After + up to 5s jitter.
    await jest.advanceTimersByTimeAsync(11_000);
    const r = await p;

    expect(r.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries on 503 and 507", async () => {
    jest.useFakeTimers();
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(res(503))
      .mockResolvedValueOnce(res(507))
      .mockResolvedValueOnce(res(200));
    global.fetch = fetchMock as unknown as typeof fetch;

    const p = fetch_with_retry({ url: "https://x", options: {} });
    await jest.advanceTimersByTimeAsync(20_000); // 503 → ~10s
    await jest.advanceTimersByTimeAsync(40_000); // 507 → ~30s
    const r = await p;

    expect(r.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("throws after exhausting max attempts", async () => {
    jest.useFakeTimers();
    const fetchMock = jest.fn().mockResolvedValue(res(503));
    global.fetch = fetchMock as unknown as typeof fetch;

    const p = fetch_with_retry({ url: "https://x", options: {}, max_attempts: 3 });
    const assertion = expect(p).rejects.toThrow(/Max attempts/);
    // Advance through the 503 backoffs between attempts.
    await jest.advanceTimersByTimeAsync(100_000);
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("passes a per-attempt abort signal when timeout_ms is set", async () => {
    const fetchMock = jest.fn().mockResolvedValue(res(200));
    global.fetch = fetchMock as unknown as typeof fetch;

    await fetch_with_retry({ url: "https://x", options: {}, timeout_ms: 5000 });

    const options = fetchMock.mock.calls[0][1];
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });

  it("creates a fresh timeout signal for every attempt, not one shared across retries", async () => {
    jest.useFakeTimers();
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(res(503))
      .mockResolvedValueOnce(res(200));
    global.fetch = fetchMock as unknown as typeof fetch;

    const p = fetch_with_retry({
      url: "https://x",
      options: {},
      timeout_ms: 5000,
    });
    await jest.advanceTimersByTimeAsync(20_000);
    await p;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const first = fetchMock.mock.calls[0][1].signal;
    const second = fetchMock.mock.calls[1][1].signal;
    expect(first).toBeInstanceOf(AbortSignal);
    expect(second).toBeInstanceOf(AbortSignal);
    // A signal created before attempt 1 would already be ticking during the
    // backoff wait; every attempt must get its own fresh budget.
    expect(second).not.toBe(first);
  });

  it("retries a transient fetch rejection when the caller opts in (idempotent GETs)", async () => {
    jest.useFakeTimers();
    const fetchMock = jest
      .fn()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(res(200));
    global.fetch = fetchMock as unknown as typeof fetch;

    const p = fetch_with_retry({
      url: "https://x",
      options: {},
      retry_on_reject: true,
    });
    await jest.advanceTimersByTimeAsync(15_000);
    const r = await p;

    expect(r.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rethrows the last error when every opted-in attempt rejects", async () => {
    jest.useFakeTimers();
    const fetchMock = jest.fn().mockRejectedValue(new TypeError("fetch failed"));
    global.fetch = fetchMock as unknown as typeof fetch;

    const p = fetch_with_retry({
      url: "https://x",
      options: {},
      max_attempts: 3,
      retry_on_reject: true,
    });
    const assertion = expect(p).rejects.toThrow("fetch failed");
    await jest.advanceTimersByTimeAsync(100_000);
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("propagates a rejection immediately by default — a timed-out POST may have been processed and must not be re-sent", async () => {
    const fetchMock = jest
      .fn()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(res(200));
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      fetch_with_retry({ url: "https://x", options: { method: "POST" } }),
    ).rejects.toThrow("fetch failed");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
