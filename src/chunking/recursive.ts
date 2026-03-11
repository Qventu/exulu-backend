/** Module containing RecursiveChunker class. */
import { RecursiveChunk, RecursiveLevel, RecursiveRules } from "./types/recursive";
import { BaseChunker } from "./base";
import { ExuluTokenizer, type TokenizerModelName } from "../../ee/tokenizer";

/**
 * Configuration options for creating a RecursiveChunker instance.
 * All options are optional and have sensible defaults.
 *
 * @interface RecursiveChunkerOptions
 * @property {string | Tokenizer} [tokenizer] - The tokenizer to use for text processing. Can be a string identifier (default: "Xenova/gpt2") or a Tokenizer instance.
 * @property {number} [chunkSize] - The maximum number Thof tokens per chunk. Must be greater than 0. Default: 512.
 * @property {RecursiveRules} [rules] - The rules that define how text should be recursively chunked. Default: new RecursiveRules().
 * @property {number} [minCharactersPerChunk] - The minimum number of characters that should be in each chunk. Must be greater than 0. Default: 24.
 * @property {string} [prefix] - Optional prefix to prepend to each chunk. The token count of the prefix will be subtracted from the chunk size.
 * @property {boolean} [retainHeaders] - Whether to retain headers in each chunk for context. Headers (HTML h1-h6 or Markdown #-######) will be prepended to chunks. Default: false.
 */
export interface RecursiveChunkerOptions {
  tokenizer?: TokenizerModelName;
  chunkSize?: number;
  rules?: RecursiveRules;
  minCharactersPerChunk?: number;
  prefix?: string;
  retainHeaders?: boolean;
}

/**
 * Represents a RecursiveChunker instance that is also directly callable as a function.
 *
 * This type combines all properties and methods of {@link RecursiveChunker} with callable signatures for chunking text(s).
 *
 * Calling the instance executes its `call` method (from {@link BaseChunker}), which in turn calls `chunk` or `chunkBatch`.
 *
 * @typedef {Object} CallableRecursiveChunker
 * @property {number} chunkSize - The maximum number of tokens per chunk.
 * @property {number} minCharactersPerChunk - The minimum number of characters per chunk.
 * @property {RecursiveRules} rules - The rules that define how text should be recursively chunked.
 * @property {string} sep - The separator string used for internal splitting (usually "✄").
 * @property {Tokenizer} tokenizer - The tokenizer instance used for chunking operations (inherited from BaseChunker).
 *
 * @method chunk - Recursively chunk a single text into chunks or strings.
 * @method chunkBatch - Recursively chunk a batch of texts.
 * @method toString - Returns a string representation of the RecursiveChunker instance.
 * @method call - Call the chunker with a single string or an array of strings. (see callable signatures)
 *
 * @static
 * @method create
 * @memberof CallableRecursiveChunker
 * @param {RecursiveChunkerOptions} [options] - Configuration options for the RecursiveChunker.
 * @returns {Promise<CallableRecursiveChunker>} A Promise that resolves to a callable RecursiveChunker instance.
 *
 * @example
 * const chunker = await RecursiveChunker.create({ chunkSize: 256 });
 * const chunks = await chunker("Some text to chunk");
 * const batchChunks = await chunker(["Text 1", "Text 2"]);
 */
export type CallableRecursiveChunker = RecursiveChunker & {
  (text: string, showProgress?: boolean): Promise<RecursiveChunk[]>;
  (texts: string[], showProgress?: boolean): Promise<RecursiveChunk[][]>;
};

/**
 * Header information extracted from text
 */
interface HeaderInfo {
  level: number; // 1-6 for h1-h6
  text: string;
  position: number;
}

/**
 * Header hierarchy tracker
 */
interface HeaderHierarchy {
  h1?: string;
  h2?: string;
  h3?: string;
  h4?: string;
  h5?: string;
  h6?: string;
}

/**
 * Recursively chunk text using a set of rules.
 *
 * This class extends the BaseChunker class and implements the chunk method.
 * It provides a flexible way to chunk text based on custom rules, including
 * delimiters, whitespace, and token-based chunking.
 *
 * @extends BaseChunker
 * @property {number} chunkSize - The maximum number of tokens per chunk (adjusted for prefix if provided).
 * @property {number} minCharactersPerChunk - The minimum number of characters per chunk.
 * @property {RecursiveRules} rules - The rules that define how text should be recursively chunked.
 * @property {string} sep - The separator string used for internal splitting (usually "✄").
 * @property {string} [prefix] - Optional prefix prepended to each chunk.
 * @property {number} prefixTokenCount - The number of tokens in the prefix (0 if no prefix).
 * @property {boolean} retainHeaders - Whether to retain headers in each chunk for context.
 *
 * @method chunk - Recursively chunk a single text into chunks or strings.
 * @method chunkBatch - Recursively chunk a batch of texts.
 * @method toString - Returns a string representation of the RecursiveChunker instance.
 * @method call - Call the chunker with a single string or an array of strings. (see callable signatures)
 *
 * @static
 * @method create
 * @memberof RecursiveChunker
 * @param {RecursiveChunkerOptions} [options] - Configuration options for the RecursiveChunker.
 * @returns {Promise<RecursiveChunker>} A Promise that resolves to a RecursiveChunker instance.
 *
 * @example
 * const chunker = await RecursiveChunker.create({ chunkSize: 256 });
 * const chunks = await chunker("Some text to chunk");
 * const batchChunks = await chunker(["Text 1", "Text 2"]);
 */
export class RecursiveChunker extends BaseChunker {
  public readonly chunkSize: number;
  public readonly minCharactersPerChunk: number;
  public readonly rules: RecursiveRules;
  public readonly sep: string;
  public readonly prefix?: string;
  public readonly prefixTokenCount: number;
  public readonly retainHeaders: boolean;
  private readonly _CHARS_PER_TOKEN: number = 6.5;
  private _headers: HeaderInfo[] = [];
  private _headerHierarchy: HeaderHierarchy = {};

  /**
   * Private constructor. Use `RecursiveChunker.create()` to instantiate.
   */
  private constructor(
    tokenizer: ExuluTokenizer,
    chunkSize: number,
    rules: RecursiveRules,
    minCharactersPerChunk: number,
    prefix: string | undefined,
    prefixTokenCount: number,
    retainHeaders: boolean,
  ) {
    super(tokenizer);

    if (chunkSize <= 0) {
      throw new Error("chunkSize must be greater than 0");
    }
    if (minCharactersPerChunk <= 0) {
      throw new Error("minCharactersPerChunk must be greater than 0");
    }
    if (!(rules instanceof RecursiveRules)) {
      throw new Error("rules must be a RecursiveRules object");
    }
    if (prefix && prefixTokenCount >= chunkSize) {
      throw new Error(`Prefix token count (${prefixTokenCount}) exceeds or equals chunk size (${chunkSize})`);
    }

    // Adjust chunk size if prefix is provided
    this.chunkSize = prefix ? chunkSize - prefixTokenCount : chunkSize;
    this.minCharactersPerChunk = minCharactersPerChunk;
    this.rules = rules;
    this.sep = "✄";
    this.prefix = prefix;
    this.prefixTokenCount = prefixTokenCount;
    this.retainHeaders = retainHeaders;
  }

  /**
   * Creates and initializes a directly callable RecursiveChunker instance.
   *
   * This static factory method constructs a RecursiveChunker with the provided options and returns a callable function object.
   * The returned instance can be used as both a function (to chunk text(s)) and as an object (with all RecursiveChunker methods and properties).
   *
   * @param {RecursiveChunkerOptions} [options] - Configuration options for the chunker. All options are optional:
   *   @param {string|Tokenizer} [options.tokenizer="Xenova/gpt2"] - Tokenizer to use for text processing. Can be a string identifier (e.g., "Xenova/gpt2") or a Tokenizer instance. If a string is provided, Tokenizer.create() is called internally.
   *   @param {number} [options.chunkSize=512] - Maximum number of tokens per chunk. Must be > 0.
   *   @param {RecursiveRules} [options.rules=new RecursiveRules()] - Rules for recursive chunking. See {@link RecursiveRules} for customization.
   *   @param {number} [options.minCharactersPerChunk=24] - Minimum number of characters per chunk. Must be > 0.
   *   @param {string} [options.prefix] - Optional prefix to prepend to each chunk. The token count of the prefix will be subtracted from the chunk size.
   *
   * @returns {Promise<CallableRecursiveChunker>} Promise resolving to a callable RecursiveChunker instance.
   *
   * @throws {Error} If any option is invalid (e.g., chunkSize <= 0).
   *
   * @see CallableRecursiveChunker for the callable interface and available properties/methods.
   *
   * @example <caption>Basic usage with default options</caption>
   * const chunker = await RecursiveChunker.create();
   * const chunks = await chunker("Some text to chunk");
   *
   * @example <caption>Custom options and batch chunking</caption>
   * const chunker = await RecursiveChunker.create({ chunkSize: 256 });
   * const batchChunks = await chunker(["Text 1", "Text 2"]);
   *
   * @example <caption>Accessing properties and methods</caption>
   * const chunker = await RecursiveChunker.create();
   * const chunks = await chunker.chunk("Some text"); // Use as object method
   *
   * @example <caption>Using a prefix</caption>
   * const chunker = await RecursiveChunker.create({ chunkSize: 512, prefix: "Context: " });
   * const chunks = await chunker("Some text to chunk");
   *
   * @note
   * The returned instance is both callable (like a function) and has all properties/methods of RecursiveChunker.
   * You can use it as a drop-in replacement for a function or a class instance.
   *
   * @note
   * For advanced customization, pass a custom RecursiveRules object to the rules option.
   * See {@link RecursiveRules} and {@link RecursiveLevel} for rule structure.
   */
  public static async create(
    options: RecursiveChunkerOptions = {},
  ): Promise<CallableRecursiveChunker> {
    const {
      tokenizer = "gpt-3.5-turbo" as TokenizerModelName,
      chunkSize = 512,
      rules = new RecursiveRules(),
      minCharactersPerChunk = 24,
      prefix,
      retainHeaders = false,
    } = options;

    const tokenizerInstance = new ExuluTokenizer();
    await tokenizerInstance.create(tokenizer);

    // Calculate prefix token count if prefix is provided
    const prefixTokenCount = prefix ? await tokenizerInstance.countTokens(prefix) : 0;

    const plainInstance = new RecursiveChunker(
      tokenizerInstance,
      chunkSize,
      rules,
      minCharactersPerChunk,
      prefix,
      prefixTokenCount,
      retainHeaders,
    );

    // Create the callable function wrapper
    const callableFn = function (
      this: CallableRecursiveChunker,
      textOrTexts: string | string[],
      showProgress?: boolean,
    ) {
      if (typeof textOrTexts === "string") {
        return plainInstance.call(textOrTexts, showProgress);
      } else {
        return plainInstance.call(textOrTexts, showProgress);
      }
    };

    // Set the prototype so that 'instanceof RecursiveChunker' works
    Object.setPrototypeOf(callableFn, RecursiveChunker.prototype);

    // Copy all enumerable own properties from plainInstance to callableFn
    Object.assign(callableFn, plainInstance);

    return callableFn as unknown as CallableRecursiveChunker;
  }

  /**
   * Extract all headers from the text (both HTML and Markdown).
   *
   * @param {string} text - The text to extract headers from
   * @returns {HeaderInfo[]} Array of header information
   * @private
   */
  private _extractHeaders(text: string): HeaderInfo[] {
    const headers: HeaderInfo[] = [];

    // Match HTML headers: <h1>...</h1>, <h2>...</h2>, etc.
    const htmlHeaderRegex = /<h([1-6])[^>]*>(.*?)<\/h\1>/gi;
    let match: RegExpExecArray | null;

    while ((match = htmlHeaderRegex.exec(text)) !== null) {
      headers.push({
        level: parseInt(match[1]!),
        text: match[2]!.trim(),
        position: match.index,
      });
    }

    // Match Markdown headers: #, ##, ###, etc.
    const markdownHeaderRegex = /^(#{1,6})\s+(.+)$/gm;

    while ((match = markdownHeaderRegex.exec(text)) !== null) {
      headers.push({
        level: match[1]!.length,
        text: match[2]!.trim(),
        position: match.index,
      });
    }

    // Sort by position
    return headers.sort((a, b) => a.position - b.position);
  }

  /**
   * Get the current header context as a formatted string.
   *
   * @returns {string} The formatted header context
   * @private
   */
  private _getHeaderContext(): string {
    const parts: string[] = [];

    for (let i = 1; i <= 6; i++) {
      const key = `h${i}` as keyof HeaderHierarchy;
      const value = this._headerHierarchy[key];
      if (value) {
        parts.push(`${'#'.repeat(i)} ${value}`);
      }
    }

    return parts.length > 0 ? parts.join('\n') + '\n\n' : '';
  }

  /**
   * Estimates the number of tokens in a given text.
   *
   * This method uses a character-to-token ratio (default: 6.5 characters per token) for quick estimation.
   * If the estimated token count exceeds the chunk size, it performs an actual token count.
   *
   * @param {string} text - The text to estimate token count for
   * @returns {Promise<number>} A promise that resolves to the estimated number of tokens
   * @private
   */
  private async _estimateTokenCount(text: string): Promise<number> {
    const estimate = Math.max(1, Math.floor(text.length / this._CHARS_PER_TOKEN));
    if (estimate > this.chunkSize) {
      return this.chunkSize + 1;
    }
    return this.tokenizer.countTokens(text);
  }

  /**
   * Split the text into chunks based on the provided recursive level rules.
   *
   * This method handles three different splitting strategies:
   * 1. Whitespace-based splitting: Splits text on spaces
   * 2. Delimiter-based splitting: Splits text on specified delimiters with options to include delimiters
   * 3. Token-based splitting: Splits text into chunks of maximum token size
   *
   * @param {string} text - The text to be split into chunks
   * @param {RecursiveLevel} recursiveLevel - The rules defining how to split the text
   * @returns {Promise<string[]>} A promise that resolves to an array of text chunks
   * @private
   */
  private async _splitText(text: string, recursiveLevel: RecursiveLevel): Promise<string[]> {
    // At every delimiter, replace it with the sep
    if (recursiveLevel.whitespace) {
      return text.split(" ");
    } else if (recursiveLevel.delimiters) {
      let t = text;
      if (recursiveLevel.includeDelim === "prev") {
        for (const delimiter of Array.isArray(recursiveLevel.delimiters)
          ? recursiveLevel.delimiters
          : [recursiveLevel.delimiters]) {
          t = t.replace(delimiter, delimiter + this.sep);
        }
      } else if (recursiveLevel.includeDelim === "next") {
        for (const delimiter of Array.isArray(recursiveLevel.delimiters)
          ? recursiveLevel.delimiters
          : [recursiveLevel.delimiters]) {
          t = t.replace(delimiter, this.sep + delimiter);
        }
      } else {
        for (const delimiter of Array.isArray(recursiveLevel.delimiters)
          ? recursiveLevel.delimiters
          : [recursiveLevel.delimiters]) {
          t = t.replace(delimiter, this.sep);
        }
      }

      const splits = t.split(this.sep).filter((split) => split !== "");

      // Merge short splits
      let current = "";
      const merged: string[] = [];
      for (const split of splits) {
        if (split.length < this.minCharactersPerChunk) {
          current += split;
        } else if (current) {
          current += split;
          merged.push(current);
          current = "";
        } else {
          merged.push(split);
        }

        if (current.length >= this.minCharactersPerChunk) {
          merged.push(current);
          current = "";
        }
      }

      if (current) {
        merged.push(current);
      }

      return merged;
    } else {
      // Encode, Split, and Decode
      const encoded = this.tokenizer.encode(text);
      const tokenSplits: Uint32Array[] = [];
      for (let i = 0; i < encoded.length; i += this.chunkSize) {
        tokenSplits.push(encoded.slice(i, i + this.chunkSize));
      }
      return await this.tokenizer.decodeBatch(tokenSplits);
    }
  }

  /**
   * Create a RecursiveChunk object with indices based on the current offset.
   *
   * This method constructs a RecursiveChunk object that contains metadata about the chunk,
   * including the text content, its start and end indices, token count, and the level of recursion.
   *
   * @param {string} text - The text content of the chunk
   * @param {number} tokenCount - The number of tokens in the chunk
   */
  private _makeChunks(
    text: string,
    tokenCount: number,
    level: number,
    startOffset: number,
  ): RecursiveChunk {
    return new RecursiveChunk({
      text: text,
      startIndex: startOffset,
      endIndex: startOffset + text.length,
      tokenCount: tokenCount,
      level: level,
    });
  }

  /**
   * Merge short splits.
   */
  private _mergeSplits(
    splits: string[],
    tokenCounts: number[],
    combineWhitespace: boolean = false,
  ): [string[], number[]] {
    if (!splits.length || !tokenCounts.length) {
      return [[], []];
    }

    // If the number of splits and token counts does not match, raise an error
    if (splits.length !== tokenCounts.length) {
      throw new Error(
        `Number of splits ${splits.length} does not match number of token counts ${tokenCounts.length}`,
      );
    }

    // If all splits are larger than the chunk size, return them
    if (tokenCounts.every((count) => count > this.chunkSize)) {
      return [splits, tokenCounts];
    }

    // If the splits are too short, merge them
    const merged: string[] = [];
    const cumulativeTokenCounts: number[] = [];
    let sum = 0;
    if (combineWhitespace) {
      // +1 for the whitespace
      cumulativeTokenCounts.push(0);
      for (const count of tokenCounts) {
        sum += count + 1;
        cumulativeTokenCounts.push(sum);
      }
    } else {
      cumulativeTokenCounts.push(0);
      for (const count of tokenCounts) {
        sum += count;
        cumulativeTokenCounts.push(sum);
      }
    }

    let currentIndex = 0;
    const combinedTokenCounts: number[] = [];

    while (currentIndex < splits.length) {
      const currentTokenCount = cumulativeTokenCounts[currentIndex] ?? 0;
      const requiredTokenCount = currentTokenCount + this.chunkSize;

      // Find the index to merge at
      let index = this._bisectLeft(cumulativeTokenCounts, requiredTokenCount, currentIndex) - 1;
      index = Math.min(index, splits.length);

      // If currentIndex == index, we need to move to the next index
      if (index === currentIndex) {
        index += 1;
      }

      // Merge splits
      if (combineWhitespace) {
        merged.push(splits.slice(currentIndex, index).join(" "));
      } else {
        merged.push(splits.slice(currentIndex, index).join(""));
      }

      // Adjust token count
      combinedTokenCounts.push(
        (cumulativeTokenCounts[Math.min(index, splits.length)] ?? 0) - currentTokenCount,
      );
      currentIndex = index;
    }

    return [merged, combinedTokenCounts];
  }

  /**
   * Binary search to find the leftmost position where value should be inserted to maintain order.
   *
   * @param {number[]} arr - The array to search
   * @param {number} value - The value to insert
   * @param {number} [lo=0] - The starting index for the search
   * @returns {number} The index where the value should be inserted
   * @private
   */
  private _bisectLeft(arr: number[], value: number, lo: number = 0): number {
    let hi = arr.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (arr[mid]! < value) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    return lo;
  }

  /**
   * Recursive helper for core chunking.
   */
  private async _recursiveChunk(
    text: string,
    level: number = 0,
    startOffset: number = 0,
  ): Promise<RecursiveChunk[]> {
    if (!text) {
      return [];
    }

    if (level >= this.rules.length) {
      const tokenCount = await this._estimateTokenCount(text);
      return [this._makeChunks(text, tokenCount, level, startOffset)];
    }

    const currRule = this.rules.getLevel(level);
    if (!currRule) {
      throw new Error(`No rule found at level ${level}`);
    }

    const splits = await this._splitText(text, currRule);
    if (this.retainHeaders) {
      const hierarchy: Record<string, string | null> = {};
      // Go through each split in the right order
      for (let i = 0; i < splits.length; i++) {
        let split = splits[i];
        if (!split) {
          continue;
        }
        const h1 = this._extractHeaders(split).find((h) => h.level === 1);
        const h2 = this._extractHeaders(split).find((h) => h.level === 2);
        const h3 = this._extractHeaders(split).find((h) => h.level === 3);
        const h4 = this._extractHeaders(split).find((h) => h.level === 4);
        const h5 = this._extractHeaders(split).find((h) => h.level === 5);
        const h6 = this._extractHeaders(split).find((h) => h.level === 6);

        if (h1) {
          hierarchy['h1'] = h1.text;
          hierarchy['h2'] = null;
          hierarchy['h3'] = null;
          hierarchy['h4'] = null;
          hierarchy['h5'] = null;
          hierarchy['h6'] = null;
        }
        if (h2) {
          hierarchy['h2'] = h2.text;
          hierarchy['h3'] = null;
          hierarchy['h4'] = null;
          hierarchy['h5'] = null;
          hierarchy['h6'] = null;
        }
        if (h3) {
          hierarchy['h3'] = h3.text;
          hierarchy['h4'] = null;
          hierarchy['h5'] = null;
          hierarchy['h6'] = null;
        }
        if (h4) {
          hierarchy['h4'] = h4.text;
          hierarchy['h5'] = null;
          hierarchy['h6'] = null;
        }
        if (h5) {
          hierarchy['h5'] = h5.text;
          hierarchy['h6'] = null;
        }
        if (h6) {
          hierarchy['h6'] = h6.text;
        }
        splits[i] = `
      ${hierarchy.h1 ?? ""} 
      ${hierarchy.h2 ?? ""} 
      ${hierarchy.h3 ?? ""}
      ${hierarchy.h4 ?? ""}
      ${hierarchy.h5 ?? ""}
      ${hierarchy.h6 ?? ""} 
      ${split}`;
      }
    }
    const tokenCounts = await Promise.all(splits.map((split) => this._estimateTokenCount(split)));

    let merged: string[];
    let combinedTokenCounts: number[];

    if (currRule.delimiters === undefined && !currRule.whitespace) {
      [merged, combinedTokenCounts] = [splits, tokenCounts];
    } else if (currRule.delimiters === undefined && currRule.whitespace) {
      [merged, combinedTokenCounts] = this._mergeSplits(splits, tokenCounts, true);
      // NOTE: This is a hack to fix the reconstruction issue when whitespace is used.
      // When whitespace is there, " ".join only adds space between words, not before the first word.
      // To make it combine back properly, all splits except the first one are prefixed with a space.
      merged = merged.slice(0, 1).concat(merged.slice(1).map((text) => " " + text));
    } else {
      [merged, combinedTokenCounts] = this._mergeSplits(splits, tokenCounts, false);
    }

    // Chunk long merged splits
    const chunks: RecursiveChunk[] = [];
    let currentOffset = startOffset;
    for (let i = 0; i < merged.length; i++) {
      const split = merged[i];
      const tokenCount = combinedTokenCounts[i];
      if (tokenCount && tokenCount > this.chunkSize) {
        chunks.push(...(await this._recursiveChunk(split ?? "", level + 1, currentOffset)));
      } else {
        chunks.push(this._makeChunks(split ?? "", tokenCount ?? 0, level, currentOffset));
      }
      // Update the offset by the length of the processed split.
      currentOffset += split?.length ?? 0;
    }
    return chunks;
  }

  /**
   * Recursively chunk text.
   *
   * This method is the main entry point for chunking text using the RecursiveChunker.
   * It takes a single text string and returns an array of RecursiveChunk objects.
   * If a prefix was provided during instantiation, it will be prepended to each chunk.
   *
   * @param {string} text - The text to be chunked
   * @returns {Promise<RecursiveChunk[]>} A promise that resolves to an array of RecursiveChunk objects
   */
  public async chunk(text: string): Promise<RecursiveChunk[]> {
    const result = await this._recursiveChunk(text, 0, 0);

    // If prefix is provided, prepend it to each chunk's text and update token count
    if (this.prefix) {
      for (const chunk of result) {
        chunk.text = this.prefix + chunk.text;
        chunk.tokenCount += this.prefixTokenCount;
      }
    }

    await this.tokenizer.free();
    return result;
  }

  /**
   * Return a string representation of the RecursiveChunker.
   *
   * This method provides a string representation of the RecursiveChunker instance,
   * including its tokenizer, rules, chunk size, minimum characters per chunk, and prefix (if any).
   *
   * @returns {string} A string representation of the RecursiveChunker
   */
  public toString(): string {
    const prefixInfo = this.prefix ? `, prefix=${JSON.stringify(this.prefix)}, prefixTokenCount=${this.prefixTokenCount}` : '';
    return (
      `RecursiveChunker(tokenizer=${JSON.stringify(this.tokenizer)}, ` +
      `rules=${JSON.stringify(this.rules)}, chunkSize=${this.chunkSize}, ` +
      `minCharactersPerChunk=${this.minCharactersPerChunk}${prefixInfo})`
    );
  }
}
