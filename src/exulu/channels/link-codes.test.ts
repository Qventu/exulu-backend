import {
  CODE_TTL_SECONDS,
  codeAttemptsExceeded,
  consumeCode,
  generateCode,
  issueCode,
  linkPromptAllowed,
  normalizeCode,
  type KeyValueStore,
} from "./link-codes";

class FakeStore implements KeyValueStore {
  values = new Map<string, string>();
  ttls = new Map<string, number>();
  async set(key: string, value: string, opts: { EX: number }) {
    this.values.set(key, value);
    this.ttls.set(key, opts.EX);
    return "OK";
  }
  async getDel(key: string) {
    const v = this.values.get(key) ?? null;
    this.values.delete(key);
    this.ttls.delete(key);
    return v;
  }
  async del(key: string) {
    this.ttls.delete(key);
    return this.values.delete(key) ? 1 : 0;
  }
  async incr(key: string) {
    const n = Number(this.values.get(key) ?? "0") + 1;
    this.values.set(key, String(n));
    return n;
  }
  async expire(key: string, seconds: number) {
    if (!this.values.has(key)) return 0;
    this.ttls.set(key, seconds);
    return 1;
  }
  async get(key: string) {
    return this.values.get(key) ?? null;
  }
}

let kv: FakeStore;
beforeEach(() => {
  kv = new FakeStore();
});

describe("generateCode / normalizeCode", () => {
  it("generates XXXX-XXXX from the alphabet", () => {
    for (let i = 0; i < 200; i++) expect(generateCode()).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
  });
  it.each([
    ["ABCD-EFGH", "ABCD-EFGH"],
    [" abcd efgh ", "ABCD-EFGH"],
    ["abcdefgh", "ABCD-EFGH"],
    ["ab-cd-ef-gh", "ABCD-EFGH"],
  ])("normalizes %p", (i, o) => expect(normalizeCode(i)).toBe(o));
  it.each([
    "mein Code ist ABCD-EFGH",
    "ABCD-EFG",
    "ABCD-EFGHI",
    "ABCD-EFG1",
    "ABCD-EFGO",
    "ABCD-EFGI",
    "ABCD-EFG0",
    "",
    "hallo",
  ])("rejects %p", (i) => expect(normalizeCode(i)).toBeNull());
});

describe("issueCode / consumeCode", () => {
  it("a code works exactly once", async () => {
    const code = await issueCode(kv, { channelId: "c", userId: 7 });
    expect(await consumeCode(kv, code)).toEqual({ channelId: "c", userId: 7 });
    expect(await consumeCode(kv, code)).toBeNull();
  });
  it("accepts the code typed in any accepted form", async () => {
    const code = await issueCode(kv, { channelId: "c", userId: 7 });
    expect(await consumeCode(kv, code.replace("-", "").toLowerCase())).toEqual({ channelId: "c", userId: 7 });
  });
  it("returns null for an unknown or malformed code", async () => {
    expect(await consumeCode(kv, "ABCD-EFGH")).toBeNull();
    expect(await consumeCode(kv, "nope")).toBeNull();
  });
  it("expires after 600 seconds", async () => {
    await issueCode(kv, { channelId: "c", userId: 7 });
    expect(CODE_TTL_SECONDS).toBe(600);
    const ttls = [...kv.ttls.entries()].filter(([k]) => k.startsWith("channel-link:code:") || k.startsWith("channel-link:user:"));
    expect(ttls).toHaveLength(2);
    for (const [, ttl] of ttls) expect(ttl).toBe(600);
  });
  it("issuing again invalidates the previous code", async () => {
    const first = await issueCode(kv, { channelId: "c", userId: 7 });
    const second = await issueCode(kv, { channelId: "c", userId: 7 });
    expect(await consumeCode(kv, first)).toBeNull();
    expect(await consumeCode(kv, second)).toEqual({ channelId: "c", userId: 7 });
  });
  it("issuing for another user or channel leaves codes alone", async () => {
    const a = await issueCode(kv, { channelId: "c", userId: 7 });
    const b = await issueCode(kv, { channelId: "c", userId: 8 });
    const d = await issueCode(kv, { channelId: "d", userId: 7 });
    expect(await consumeCode(kv, a)).toEqual({ channelId: "c", userId: 7 });
    expect(await consumeCode(kv, b)).toEqual({ channelId: "c", userId: 8 });
    expect(await consumeCode(kv, d)).toEqual({ channelId: "d", userId: 7 });
  });
  it("consuming removes the per-user pointer", async () => {
    const code = await issueCode(kv, { channelId: "c", userId: 7 });
    await consumeCode(kv, code);
    expect(kv.values.size).toBe(0);
  });
  it("two racing consumers cannot both succeed", async () => {
    const code = await issueCode(kv, { channelId: "c", userId: 7 });
    const results = await Promise.all([consumeCode(kv, code), consumeCode(kv, code)]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });
  it("never stores the plain code", async () => {
    const code = await issueCode(kv, { channelId: "c", userId: 7 });
    const plain = code.replace("-", "");
    for (const [k, v] of kv.values) {
      for (const s of [k, v]) {
        expect(s).not.toContain(code);
        expect(s).not.toContain(plain);
      }
    }
  });
});

describe("limits", () => {
  it("locks out from the sixth attempt", async () => {
    for (let i = 0; i < 5; i++) expect(await codeAttemptsExceeded(kv, "c", "491:x")).toBe(false);
    expect(await codeAttemptsExceeded(kv, "c", "491:x")).toBe(true);
    expect(await codeAttemptsExceeded(kv, "c", "other")).toBe(false);
    expect(await codeAttemptsExceeded(kv, "d", "491:x")).toBe(false);
  });
  it("sets the 3600 s window once, when the counter is created", async () => {
    const key = "channel-link:attempts:c:491:x";
    await codeAttemptsExceeded(kv, "c", "491:x");
    expect(kv.ttls.get(key)).toBe(3600);
    kv.ttls.set(key, 100);
    await codeAttemptsExceeded(kv, "c", "491:x");
    expect(kv.ttls.get(key)).toBe(100);
  });
  it("allows one link prompt per window", async () => {
    expect(await linkPromptAllowed(kv, "c", "id")).toBe(true);
    expect(await linkPromptAllowed(kv, "c", "id")).toBe(false);
    expect(await linkPromptAllowed(kv, "c", "id")).toBe(false);
    expect(await linkPromptAllowed(kv, "c", "other")).toBe(true);
    expect(kv.ttls.get("channel-link:prompt:c:id")).toBe(600);
  });
});
