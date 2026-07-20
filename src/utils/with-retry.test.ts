import { withRetry } from "./with-retry";

describe("withRetry", () => {
  it("returns the first successful result without retrying", async () => {
    const fn = jest.fn(async () => "ok");
    await expect(withRetry(fn)).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries failures up to maxRetries and returns the eventual success", async () => {
    const fn = jest
      .fn()
      .mockRejectedValueOnce(new Error("boom 1"))
      .mockRejectedValueOnce(new Error("boom 2"))
      .mockResolvedValueOnce("ok");
    await expect(withRetry(fn, 3, { baseDelayMs: 1 })).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("throws the last error after exhausting retries", async () => {
    const fn = jest.fn().mockRejectedValue(new Error("always down"));
    await expect(withRetry(fn, 2, { baseDelayMs: 1 })).rejects.toThrow("always down");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("throws immediately when shouldRetry rejects the error", async () => {
    const fatal = new Error("deterministic failure");
    const fn = jest.fn().mockRejectedValue(fatal);
    await expect(
      withRetry(fn, 3, { baseDelayMs: 1, shouldRetry: (err) => err !== fatal }),
    ).rejects.toBe(fatal);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
