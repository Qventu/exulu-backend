import { createRunLock, EXTEND_SCRIPT, RELEASE_SCRIPT, type LockRedis } from "./run-lock";

/** Models SET NX EX and the compare-and-delete script the way Redis runs them. */
class FakeRedis implements LockRedis {
  values = new Map<string, string>();
  ttls = new Map<string, number>();
  scripts: string[] = [];
  async set(key: string, value: string, opts: { NX: true; EX: number }) {
    if (opts.NX && this.values.has(key)) return null;
    this.values.set(key, value);
    this.ttls.set(key, opts.EX);
    return "OK";
  }
  async eval(script: string, options: { keys: string[]; arguments: string[] }) {
    this.scripts.push(script);
    const [key] = options.keys;
    const [token, ttl] = options.arguments;
    if (script === EXTEND_SCRIPT) {
      if (this.values.get(key) !== token) return 0;
      this.ttls.set(key, Number(ttl));
      return 1;
    }
    if (this.values.get(key) === token) {
      this.values.delete(key);
      this.ttls.delete(key);
      return 1;
    }
    return 0;
  }
  async exists(key: string) {
    return this.values.has(key) ? 1 : 0;
  }
}

describe("createRunLock", () => {
  it("acquire sets the key with NX and the TTL and returns a random owner token", async () => {
    const redis = new FakeRedis();
    const lock = createRunLock(redis);
    const a = await lock.acquire("k", 900);
    expect(typeof a).toBe("string");
    expect((a as string).length).toBeGreaterThanOrEqual(16);
    expect(redis.values.get("k")).toBe(a);
    expect(redis.ttls.get("k")).toBe(900);
  });

  it("a held lock cannot be acquired again", async () => {
    const lock = createRunLock(new FakeRedis());
    expect(await lock.acquire("k", 900)).not.toBeNull();
    expect(await lock.acquire("k", 900)).toBeNull();
  });

  it("tokens differ between acquisitions", async () => {
    const lock = createRunLock(new FakeRedis());
    const a = await lock.acquire("a", 900);
    const b = await lock.acquire("b", 900);
    expect(a).not.toBe(b);
  });

  it("release deletes the key only for its owner, in one script", async () => {
    const redis = new FakeRedis();
    const lock = createRunLock(redis);
    const token = (await lock.acquire("k", 900)) as string;

    await lock.release("k", "someone-else");
    expect(redis.values.has("k")).toBe(true);

    await lock.release("k", token);
    expect(redis.values.has("k")).toBe(false);
    expect(redis.scripts.every((s) => s === RELEASE_SCRIPT)).toBe(true);
  });

  it("a job that outlived its TTL does not remove the next job's lock", async () => {
    const redis = new FakeRedis();
    const lock = createRunLock(redis);
    const old = (await lock.acquire("k", 900)) as string;
    redis.values.delete("k"); // TTL ran out
    const fresh = (await lock.acquire("k", 900)) as string;
    await lock.release("k", old);
    expect(redis.values.get("k")).toBe(fresh);
  });

  it("the release script compares before deleting", () => {
    expect(RELEASE_SCRIPT).toBe(
      'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end',
    );
  });

  it("extend renews the TTL for the owner only, in one script, and says whether it did", async () => {
    const redis = new FakeRedis();
    const lock = createRunLock(redis);
    const token = (await lock.acquire("k", 90)) as string;
    redis.ttls.set("k", 12); // time has passed

    expect(await lock.extend("k", token, 90)).toBe(true);
    expect(redis.ttls.get("k")).toBe(90);
    expect(redis.scripts).toEqual([EXTEND_SCRIPT]);
  });

  it("extend with a stale token returns false and changes nothing", async () => {
    const redis = new FakeRedis();
    const lock = createRunLock(redis);
    const old = (await lock.acquire("k", 90)) as string;
    redis.values.delete("k"); // the old owner's TTL ran out
    const fresh = (await lock.acquire("k", 90)) as string;
    redis.ttls.set("k", 30);

    expect(await lock.extend("k", old, 90)).toBe(false);
    expect(redis.values.get("k")).toBe(fresh);
    expect(redis.ttls.get("k")).toBe(30);
    // and a lapsed key is not recreated
    expect(await lock.extend("gone", old, 90)).toBe(false);
    expect(redis.values.has("gone")).toBe(false);
  });

  it("the extend script compares before expiring and passes the TTL in seconds", async () => {
    expect(EXTEND_SCRIPT).toBe(
      'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("expire", KEYS[1], ARGV[2]) else return 0 end',
    );
    const redis = { set: jest.fn(), exists: jest.fn(), eval: jest.fn(async () => 1) };
    await createRunLock(redis as any).extend("k", "tok", 90);
    expect(redis.eval).toHaveBeenCalledWith(EXTEND_SCRIPT, { keys: ["k"], arguments: ["tok", "90"] });
  });

  it("held reports whether the key exists", async () => {
    const lock = createRunLock(new FakeRedis());
    expect(await lock.held("k")).toBe(false);
    await lock.acquire("k", 900);
    expect(await lock.held("k")).toBe(true);
  });
});
