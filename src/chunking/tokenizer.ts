import { Tiktoken } from "tiktoken/lite";
import { load } from "tiktoken/load";
import registry from "tiktoken/registry.json" with { type: "json" };
import models from "tiktoken/model_to_encoding.json" with { type: "json" };

export type TokenizerModelName = keyof typeof models;

export class ExuluTokenizer {
  constructor() {}

  public encoder: Tiktoken | null = null;

  async create(modelName: TokenizerModelName): Promise<Tiktoken> {
    if (this.encoder) {
      return this.encoder;
    }
    const time = performance.now();
    console.log("[EXULU] Loading tokenizer.", modelName);
    const model = await load(registry[models[modelName] as keyof typeof registry]);
    console.log("[EXULU] Loaded tokenizer.", modelName, performance.now() - time);
    const encoder = new Tiktoken(model.bpe_ranks, model.special_tokens, model.pat_str);
    console.log("[EXULU] Set encoder.");
    this.encoder = encoder;
    return encoder;
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
    const promises = texts.map((text) => this.countTokens(text));
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
    }
  }
}
