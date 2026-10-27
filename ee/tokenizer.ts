import { Tiktoken } from "tiktoken/lite";
import { load } from "tiktoken/load";
import registry from "tiktoken/registry.json" with { type: "json" };
import models from "tiktoken/model_to_encoding.json" with { type: "json" };

export type TokenizerModelName = keyof typeof models;

type TiktokenBPE = Awaited<ReturnType<typeof load>>;

/**
 * The BPE ranks, cached for the lifetime of the process and keyed by ENCODING
 * rather than by model — most model names share one encoding (every current
 * gpt-3.5/gpt-4 name maps to cl100k_base), so keying by model would re-download
 * the same bytes.
 *
 * Why this cache has to exist: tiktoken's `load()` holds no cache of its own
 * (node_modules/tiktoken/load.cjs — a bare `fetch(url).then(r => r.text())`),
 * and the ranks for cl100k_base are ~1.6MB fetched from
 * openaipublic.blob.core.windows.net. `createAndUpsertEmbeddings` builds a
 * chunker per item, so without this, embedding N items meant N downloads from
 * a third-party host — the dominant cost of a bulk re-embed, and an undeclared
 * hard dependency on that host being reachable.
 *
 * The PROMISE is cached, not just the result, so concurrent callers share one
 * in-flight download instead of racing to start their own.
 */
const ranksByEncoding = new Map<string, Promise<TiktokenBPE>>();

const loadRanks = (encoding: string): Promise<TiktokenBPE> => {
  const cached = ranksByEncoding.get(encoding);
  if (cached) return cached;

  const time = performance.now();
  console.log("[EXULU] Loading tokenizer ranks.", encoding);
  const pending = load(registry[encoding as keyof typeof registry])
    .then((ranks): TiktokenBPE => {
      console.log("[EXULU] Loaded tokenizer ranks.", encoding, performance.now() - time);
      return ranks;
    })
    .catch((error: unknown) => {
      // Never leave a rejected promise in the cache: a single transient
      // timeout would otherwise fail every embed for the life of the process.
      ranksByEncoding.delete(encoding);
      throw error;
    });

  ranksByEncoding.set(encoding, pending);
  return pending;
};

export class ExuluTokenizer {
  constructor() {}

  public encoder: Tiktoken | null = null;

  /** Remembered so `ensure()` can rebuild an encoder that `free()` released. */
  private modelName: TokenizerModelName | null = null;

  async create(modelName: TokenizerModelName): Promise<Tiktoken> {
    this.modelName = modelName;
    if (this.encoder) {
      return this.encoder;
    }
    // A Tiktoken per instance, built from the shared ranks. Deliberately NOT a
    // shared encoder: both chunkers call `tokenizer.free()` at the end of every
    // chunk() (sentence.ts, recursive.ts), which would free a shared one out
    // from under every other caller. Construction from cached ranks is the
    // cheap half — the download was the expensive part.
    const ranks = await loadRanks(models[modelName]);
    const encoder = new Tiktoken(ranks.bpe_ranks, ranks.special_tokens, ranks.pat_str);
    console.log("[EXULU] Set encoder.", modelName);
    this.encoder = encoder;
    return encoder;
  }

  /**
   * The encoder, rebuilt if a previous `chunk()` freed it.
   *
   * Both chunkers free their tokenizer at the end of every `chunk()`, so an
   * instance that is used twice — directly, or via `chunkBatch`, which calls
   * `chunk()` once per text — needs its encoder back. Rebuilding is cheap:
   * the ranks are already cached process-wide, so this costs a `Tiktoken`
   * construction and no network.
   */
  async ensure(): Promise<Tiktoken> {
    if (this.encoder) {
      return this.encoder;
    }
    if (!this.modelName) {
      throw new Error("Tokenizer not initialized");
    }
    return this.create(this.modelName);
  }

  async decode(tokens: Uint32Array): Promise<string> {
    if (!this.encoder) {
      throw new Error("Tokenizer not initialized");
    }

    const text = this.encoder.decode(tokens);
    return new TextDecoder().decode(text);
  }

  async decodeBatch(tokenSequences: Uint32Array[]): Promise<string[]> {
    if (!this.encoder) {
      throw new Error("Tokenizer not initialized");
    }
    const promises = tokenSequences.map((tokens) => this.decode(tokens));
    return await Promise.all(promises);
  }

  encode(text: string): Uint32Array {
    if (!this.encoder) {
      throw new Error("Tokenizer not initialized");
    }

    const time = performance.now();
    console.log("[EXULU] Encoding text length: " + (text?.length || 0));
    const tokens = this.encoder.encode(text);
    console.log("[EXULU] Finished encoding text.", performance.now() - time);
    return tokens;
  }

  async countTokensBatch(texts: string[]): Promise<number[]> {
    if (!this.encoder) {
      throw new Error("Tokenizer not initialized");
    }
    const promises = texts.map((text) => Promise.resolve(this.countTokens(text)));
    return await Promise.all(promises);
  }

  countTokens(text: string): number {
    if (!this.encoder) {
      throw new Error("Tokenizer not initialized");
    }
    const tokens = this.encoder.encode(text);
    const count = tokens.length;
    console.log("[EXULU] Token count.", count);
    return count;
  }

  async free() {
    console.log("[EXULU] Freeing tokenizer.");
    if (this.encoder) {
      this.encoder.free();
      // Drop the handle along with the allocation. A freed Tiktoken is a
      // dangling pointer into WASM memory, and both chunkers free after EVERY
      // chunk(), so leaving it set made the next call on the same instance
      // crash with "null pointer passed to rust". Null means `ensure()`
      // rebuilds instead.
      this.encoder = null;
    }
  }
}
