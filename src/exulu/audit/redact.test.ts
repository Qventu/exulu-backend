import { sanitizeData } from "./redact";

describe("sanitizeData", () => {
  it("removes secret-bearing keys anywhere in the tree", () => {
    const { value } = sanitizeData(
      { q: "hi", oauth: { accessToken: "x" }, nested: { password: "p", ok: 1 } },
      { maxBytes: 10_000 },
    );
    const s = JSON.stringify(value);
    expect(s).not.toContain("accessToken");
    expect(s).not.toContain("\"password\"");
    expect(s).toContain("[redacted]");
    expect(value).toMatchObject({ q: "hi", nested: { ok: 1 } });
  });

  it("strips injected framework internals at the top level", () => {
    const { value } = sanitizeData(
      { arg: 1, req: { headers: {} }, model: {}, exuluConfig: {}, contexts: {} },
      { maxBytes: 10_000 },
    );
    expect(value).toEqual({ arg: 1 });
  });

  it("honors extra redactKeys and caps oversized payloads", () => {
    const big = "a".repeat(5000);
    const r1 = sanitizeData({ email: "me@x.com", keep: 1 }, { maxBytes: 10_000, redactKeys: ["email"] });
    expect(JSON.stringify(r1.value)).not.toContain("me@x.com");

    const r2 = sanitizeData({ blob: big }, { maxBytes: 200 });
    expect(r2.truncated).toBe(true);
    expect((r2.value as any)._truncated).toBe(true);
    expect(JSON.stringify(r2.value).length).toBeLessThan(600);
  });

  it("never throws on circular / non-serializable input", () => {
    const a: any = { name: "x" };
    a.self = a;
    expect(() => sanitizeData(a, { maxBytes: 100 })).not.toThrow();
  });
});
