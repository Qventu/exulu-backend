import { createHmac } from "node:crypto";
import {
  MAILGUN_REPLAY_WINDOW_SECONDS,
  isReplay,
  verifyMailgunSignature,
} from "./verify-mailgun";

const KEY = "test-signing-key";
const sign = (timestamp: string, token: string): string =>
  createHmac("sha256", KEY).update(timestamp + token).digest("hex");

describe("verifyMailgunSignature", () => {
  const timestamp = "1752570000";
  const token = "token-abc-123";

  it("accepts a valid signature", () => {
    expect(
      verifyMailgunSignature({ timestamp, token, signature: sign(timestamp, token) }, KEY),
    ).toBe(true);
  });

  it("rejects a tampered signature", () => {
    const valid = sign(timestamp, token);
    const tampered = (valid[0] === "a" ? "b" : "a") + valid.slice(1);
    expect(verifyMailgunSignature({ timestamp, token, signature: tampered }, KEY)).toBe(false);
  });

  it("rejects a signature computed with a different key", () => {
    const other = createHmac("sha256", "other-key").update(timestamp + token).digest("hex");
    expect(verifyMailgunSignature({ timestamp, token, signature: other }, KEY)).toBe(false);
  });

  it("rejects a signature of the wrong length without throwing", () => {
    expect(verifyMailgunSignature({ timestamp, token, signature: "abc" }, KEY)).toBe(false);
  });

  it("rejects missing fields", () => {
    expect(verifyMailgunSignature({ timestamp: "", token, signature: sign("", token) }, KEY)).toBe(false);
    expect(verifyMailgunSignature({ timestamp, token: "", signature: sign(timestamp, "") }, KEY)).toBe(false);
    expect(verifyMailgunSignature({ timestamp, token, signature: "" }, KEY)).toBe(false);
    expect(verifyMailgunSignature({ timestamp, token, signature: sign(timestamp, token) }, "")).toBe(false);
  });
});

describe("isReplay", () => {
  const freshTimestamp = (): string => String(Math.floor(Date.now() / 1000));

  it("rejects timestamps older than the 5 minute window without touching redis", async () => {
    const redis = { set: jest.fn() };
    const stale = String(
      Math.floor(Date.now() / 1000) - MAILGUN_REPLAY_WINDOW_SECONDS - 10,
    );
    await expect(isReplay(redis, "tok", stale)).resolves.toBe(true);
    expect(redis.set).not.toHaveBeenCalled();
  });

  it("rejects non-numeric timestamps", async () => {
    const redis = { set: jest.fn() };
    await expect(isReplay(redis, "tok", "not-a-number")).resolves.toBe(true);
    expect(redis.set).not.toHaveBeenCalled();
  });

  it("accepts a first-seen token inside the window (SETNX with 900s TTL)", async () => {
    const redis = { set: jest.fn(async () => "OK") };
    await expect(isReplay(redis, "tok-1", freshTimestamp())).resolves.toBe(false);
    expect(redis.set).toHaveBeenCalledWith("email_inbound:replay:tok-1", "1", {
      NX: true,
      EX: 900,
    });
  });

  it("flags an already-seen token as a replay", async () => {
    const redis = { set: jest.fn(async () => null) };
    await expect(isReplay(redis, "tok-1", freshTimestamp())).resolves.toBe(true);
  });

  it("degrades to timestamp-window-only when redis is unavailable", async () => {
    await expect(isReplay(null, "tok-1", freshTimestamp())).resolves.toBe(false);
  });

  it("degrades to timestamp-window-only when redis.set throws", async () => {
    const redis = { set: jest.fn(async () => {
      throw new Error("connection refused");
    }) };
    await expect(isReplay(redis, "tok-1", freshTimestamp())).resolves.toBe(false);
  });
});
