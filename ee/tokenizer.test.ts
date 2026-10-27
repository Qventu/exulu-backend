/**
 * The defect under test: tiktoken's `load()` has no cache of its own
 * (node_modules/tiktoken/load.cjs) — it is a bare `fetch(url).then(r =>
 * r.text())` — and `ExuluTokenizer` used to call it on every `create()`. Since
 * `createAndUpsertEmbeddings` builds a chunker per item, embedding N items
 * meant N downloads of the ~1.6MB BPE ranks from a third-party host.
 *
 * Spec: docs/superpowers/specs/2026-10-27-chunking-library-defects-design.md §3
 */
import type { ExuluTokenizer as ExuluTokenizerType } from "./tokenizer";

/** A tiny but valid "<base64 token> <rank>" ranks file. */
const RANKS = ["IQ== 0", "Ig== 1", "Iw== 2", "aGVsbG8= 3"].join("\n") + "\n";

const realFetch = globalThis.fetch;

/** A fresh module instance, so the module-level ranks cache starts empty. */
const freshTokenizer = (): typeof ExuluTokenizerType => {
  let ctor: typeof ExuluTokenizerType | undefined;
  jest.isolateModules(() => {
    ctor = (require("./tokenizer") as typeof import("./tokenizer")).ExuluTokenizer;
  });
  return ctor!;
};

const stubFetch = () => {
  const mock = jest.fn(async () => ({ text: async () => RANKS }));
  globalThis.fetch = mock as unknown as typeof fetch;
  return mock;
};

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("ExuluTokenizer BPE loading", () => {
  it("downloads the ranks once no matter how many tokenizers are built", async () => {
    const ExuluTokenizer = freshTokenizer();
    const fetchMock = stubFetch();

    for (let i = 0; i < 3; i++) {
      const tokenizer = new ExuluTokenizer();
      await tokenizer.create("gpt-3.5-turbo");
    }

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("shares one download between models that use the same encoding", async () => {
    const ExuluTokenizer = freshTokenizer();
    const fetchMock = stubFetch();

    // Both map to cl100k_base, so keying the cache by encoding (not by model)
    // is what makes this one download instead of two.
    await new ExuluTokenizer().create("gpt-3.5-turbo");
    await new ExuluTokenizer().create("gpt-4");

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("collapses concurrent creations into a single download", async () => {
    const ExuluTokenizer = freshTokenizer();
    const fetchMock = stubFetch();

    // Embedding runs chunk items concurrently; without caching the in-flight
    // promise this is one download per caller.
    await Promise.all(
      Array.from({ length: 5 }, () => new ExuluTokenizer().create("gpt-3.5-turbo")),
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not cache a failed download, so a transient outage is retryable", async () => {
    const ExuluTokenizer = freshTokenizer();
    const mock = jest
      .fn()
      .mockRejectedValueOnce(new Error("ConnectTimeoutError"))
      .mockResolvedValue({ text: async () => RANKS });
    globalThis.fetch = mock as unknown as typeof fetch;

    await expect(new ExuluTokenizer().create("gpt-3.5-turbo")).rejects.toThrow();

    // A poisoned cache entry would make every later create() fail for the
    // lifetime of the process.
    const tokenizer = new ExuluTokenizer();
    await tokenizer.create("gpt-3.5-turbo");
    expect(tokenizer.countTokens("hello")).toBe(1);
    expect(mock).toHaveBeenCalledTimes(2);
  });

  it("gives every tokenizer its own encoder, so freeing one leaves others usable", async () => {
    const ExuluTokenizer = freshTokenizer();
    stubFetch();

    const first = new ExuluTokenizer();
    const second = new ExuluTokenizer();
    await first.create("gpt-3.5-turbo");
    await second.create("gpt-3.5-turbo");

    // Caching the ranks must not become caching one shared WASM encoder:
    // both chunkers call free() at the end of every chunk().
    await first.free();

    expect(second.countTokens("hello")).toBe(1);
  });

  it("still memoizes within a single instance", async () => {
    const ExuluTokenizer = freshTokenizer();
    const fetchMock = stubFetch();

    const tokenizer = new ExuluTokenizer();
    const a = await tokenizer.create("gpt-3.5-turbo");
    const b = await tokenizer.create("gpt-3.5-turbo");

    expect(a).toBe(b);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("ExuluTokenizer encoder lifecycle", () => {
  it("drops the handle when freed, so a dangling pointer is unreachable", async () => {
    const ExuluTokenizer = freshTokenizer();
    stubFetch();

    const tokenizer = new ExuluTokenizer();
    await tokenizer.create("gpt-3.5-turbo");
    await tokenizer.free();

    // Leaving the freed Tiktoken in place is what produced "null pointer
    // passed to rust" on the next call.
    expect(tokenizer.encoder).toBeNull();
    expect(() => tokenizer.countTokens("hello")).toThrow("Tokenizer not initialized");
  });

  it("rebuilds a freed encoder without downloading the ranks again", async () => {
    const ExuluTokenizer = freshTokenizer();
    const fetchMock = stubFetch();

    const tokenizer = new ExuluTokenizer();
    await tokenizer.create("gpt-3.5-turbo");
    await tokenizer.free();
    await tokenizer.ensure();

    expect(tokenizer.countTokens("hello")).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("is a no-op when the encoder is still alive", async () => {
    const ExuluTokenizer = freshTokenizer();
    stubFetch();

    const tokenizer = new ExuluTokenizer();
    const created = await tokenizer.create("gpt-3.5-turbo");

    expect(await tokenizer.ensure()).toBe(created);
  });

  it("refuses to ensure a tokenizer that was never created", async () => {
    const ExuluTokenizer = freshTokenizer();
    stubFetch();

    await expect(new ExuluTokenizer().ensure()).rejects.toThrow("Tokenizer not initialized");
  });

  it("tolerates being freed twice", async () => {
    const ExuluTokenizer = freshTokenizer();
    stubFetch();

    const tokenizer = new ExuluTokenizer();
    await tokenizer.create("gpt-3.5-turbo");
    await tokenizer.free();

    // A double free on a live pointer is what crashes WASM; the null guard
    // has to hold.
    await expect(tokenizer.free()).resolves.toBeUndefined();
  });
});
