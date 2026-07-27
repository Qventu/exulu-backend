import { createHmac } from "node:crypto";
import { verifyPayloadSignature } from "./verify-signature";

const SECRET = "test-signing-secret";
const body = Buffer.from(JSON.stringify({ from: "a@b.com" }), "utf8");

const sign = (msg: Buffer) =>
  "sha256=" + createHmac("sha256", SECRET).update(msg).digest("hex");

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
});
