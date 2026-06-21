import { createHmac } from "node:crypto";
import { verifyRecallRequest } from "./verify";

// A base64 signing secret (the bytes after the optional whsec_ prefix).
const SECRET_B64 = Buffer.from("super-secret-signing-key").toString("base64");
const SECRET = `whsec_${SECRET_B64}`;

const sign = (id: string, timestamp: string, body: string, secretB64 = SECRET_B64) => {
  const key = Buffer.from(secretB64, "base64");
  const sig = createHmac("sha256", key)
    .update(`${id}.${timestamp}.${body}`)
    .digest("base64");
  return `v1,${sig}`;
};

const now = () => String(Math.floor(Date.now() / 1000));

describe("verifyRecallRequest", () => {
  const body = JSON.stringify({ event: "transcript.done", data: {} });

  it("accepts a correctly signed request", () => {
    const id = "msg_1";
    const ts = now();
    const headers = {
      "svix-id": id,
      "svix-timestamp": ts,
      "svix-signature": sign(id, ts, body),
    };
    expect(verifyRecallRequest(headers, body, SECRET)).toEqual({ ok: true });
  });

  it("accepts a secret without the whsec_ prefix", () => {
    const id = "msg_1";
    const ts = now();
    const headers = {
      "svix-id": id,
      "svix-timestamp": ts,
      "svix-signature": sign(id, ts, body),
    };
    expect(verifyRecallRequest(headers, body, SECRET_B64)).toEqual({ ok: true });
  });

  it("accepts the webhook-* header aliases", () => {
    const id = "msg_2";
    const ts = now();
    const headers = {
      "webhook-id": id,
      "webhook-timestamp": ts,
      "webhook-signature": sign(id, ts, body),
    };
    expect(verifyRecallRequest(headers, body, SECRET).ok).toBe(true);
  });

  it("verifies against the exact raw body (a changed body fails)", () => {
    const id = "msg_1";
    const ts = now();
    const headers = {
      "svix-id": id,
      "svix-timestamp": ts,
      "svix-signature": sign(id, ts, body),
    };
    const result = verifyRecallRequest(headers, body + " ", SECRET);
    expect(result.ok).toBe(false);
  });

  it("accepts any signature in a space-delimited list (post-rotation overlap)", () => {
    const id = "msg_1";
    const ts = now();
    const good = sign(id, ts, body);
    const headers = {
      "svix-id": id,
      "svix-timestamp": ts,
      "svix-signature": `v1,not-the-right-signature ${good}`,
    };
    expect(verifyRecallRequest(headers, body, SECRET).ok).toBe(true);
  });

  it("rejects a wrong signature", () => {
    const id = "msg_1";
    const ts = now();
    const headers = {
      "svix-id": id,
      "svix-timestamp": ts,
      "svix-signature": sign(id, ts, body, Buffer.from("other-key").toString("base64")),
    };
    expect(verifyRecallRequest(headers, body, SECRET).ok).toBe(false);
  });

  it("rejects missing headers", () => {
    expect(verifyRecallRequest({}, body, SECRET).ok).toBe(false);
  });

  it("rejects a timestamp outside the tolerance window", () => {
    const id = "msg_1";
    const oldTs = String(Math.floor(Date.now() / 1000) - 60 * 60);
    const headers = {
      "svix-id": id,
      "svix-timestamp": oldTs,
      "svix-signature": sign(id, oldTs, body),
    };
    expect(verifyRecallRequest(headers, body, SECRET).ok).toBe(false);
  });

  it("rejects when no secret is configured", () => {
    const id = "msg_1";
    const ts = now();
    const headers = {
      "svix-id": id,
      "svix-timestamp": ts,
      "svix-signature": sign(id, ts, body),
    };
    expect(verifyRecallRequest(headers, body, undefined).ok).toBe(false);
  });
});
