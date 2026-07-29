import { createHmac } from "node:crypto";
import { verifyPayloadSignature, isReplay, SIGNATURE_REPLAY_WINDOW_SECONDS } from "./verify-signature";

const SECRET = "test-signing-secret";
const body = Buffer.from(JSON.stringify({ from: "a@b.com" }), "utf8");

const sign = (msg: Buffer) =>
  "sha256=" + createHmac("sha256", SECRET).update(msg).digest("hex");

/** Bare hex of the same digest — no sha256= prefix */
const bareHex = (msg: Buffer) =>
  createHmac("sha256", SECRET).update(msg).digest("hex");

describe("verifyPayloadSignature", () => {
  it("accepts a valid signature over the raw body (no timestamp)", () => {
    expect(verifyPayloadSignature(body, sign(body), undefined, SECRET)).toBe(true);
  });
  it("accepts a valid signature over timestamp + '.' + body", () => {
    const ts = "1730000000";
    const msg = Buffer.concat([Buffer.from(ts + "."), body]);
    expect(verifyPayloadSignature(body, sign(msg), ts, SECRET)).toBe(true);
  });
  it("rejects a tampered body", () => {
    expect(verifyPayloadSignature(Buffer.from("x"), sign(body), undefined, SECRET)).toBe(false);
  });
  it("rejects a missing or malformed header", () => {
    expect(verifyPayloadSignature(body, "", undefined, SECRET)).toBe(false);
    expect(verifyPayloadSignature(body, "nothex", undefined, SECRET)).toBe(false);
  });
  it("rejects a valid-looking bare-hex header with no sha256= prefix", () => {
    expect(verifyPayloadSignature(body, bareHex(body), undefined, SECRET)).toBe(false);
  });
});

describe("isReplay", () => {
  const nowTs = () => String(Math.floor(Date.now() / 1000));
  const staleTs = () => String(Math.floor(Date.now() / 1000) - SIGNATURE_REPLAY_WINDOW_SECONDS - 1);

  it("returns true for a non-numeric timestamp", async () => {
    expect(await isReplay({ set: async () => "OK" }, "sig", "notanumber")).toBe(true);
  });

  it("returns true for a stale timestamp (age > 300s)", async () => {
    expect(await isReplay({ set: async () => "OK" }, "sig", staleTs())).toBe(true);
  });

  it("returns false for a first-seen signature (redis.set returns 'OK')", async () => {
    const redis = { set: async () => "OK" as const };
    expect(await isReplay(redis, "unique-sig-abc", nowTs())).toBe(false);
  });

  it("returns true for an already-seen signature (redis.set returns null)", async () => {
    const redis = { set: async () => null };
    expect(await isReplay(redis, "already-seen-sig", nowTs())).toBe(true);
  });

  it("returns false when redis is null (degrades gracefully)", async () => {
    expect(await isReplay(null, "sig", nowTs())).toBe(false);
  });

  it("returns false when redis.set throws (degrades gracefully)", async () => {
    const redis = {
      set: async () => {
        throw new Error("Redis connection refused");
      },
    };
    expect(await isReplay(redis, "sig", nowTs())).toBe(false);
  });

  it("uses the key routine_webhook:replay:{signature}", async () => {
    const capturedArgs: any[] = [];
    const redis = {
      set: async (...args: any[]) => {
        capturedArgs.push(...args);
        return "OK" as const;
      },
    };
    await isReplay(redis, "test-signature-xyz", nowTs());
    expect(capturedArgs[0]).toBe("routine_webhook:replay:test-signature-xyz");
  });
});
