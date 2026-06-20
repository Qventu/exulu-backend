import type { Item } from "@EXULU_TYPES/models/item";
import type { ExuluStorage } from "./storage";
import { SentenceChunker } from "@SRC/chunking/sentence";

/**
 * Chunking is now an ExuluContext concern (it used to live on the removed
 * ExuluEmbedder class). A context may supply its own `chunker` to control how
 * an item is split into embeddable chunks; if it doesn't, `defaultChunker`
 * runs. Embedding generation itself goes through LiteLLM via resolveEmbedder —
 * the chunker only produces the text segments.
 */

export type ChunkerResponse = {
  item: Item & { id: string };
  chunks: {
    content: string;
    index: number;
    // Stored in a JSONB `metadata` column, so any JSON-serializable value is
    // allowed (e.g. a page number). Keep this wide — `sanitizeMetadata` only
    // strips null bytes from string values and passes everything else through.
    metadata?: Record<string, unknown>;
  }[];
};

/**
 * A chunker takes a (fully-hydrated) item and a target max chunk size and
 * returns the ordered text chunks to embed. `utils.storage` is provided for
 * chunkers that need to read file contents from object storage.
 *
 * Note: unlike the old ExuluEmbedder.chunker, there is no `settings` argument —
 * the per-context `embedder_settings` config layer was removed. Chunkers that
 * need configuration should close over it in code.
 */
export type ChunkerOperation = (
  item: Item & { id: string },
  maxChunkSize: number,
  utils: {
    storage: ExuluStorage;
  },
) => Promise<ChunkerResponse>;

/**
 * Built-in chunker used when a context configures an embedder model but does
 * not provide its own `chunker`. It runs the standard SentenceChunker (also
 * exposed as ExuluChunkers.sentence) over the item's primary text — preferring
 * a `content` field, then `description`, combined with the `name` — so a
 * context "just works" from a model name alone. `maxChunkSize` is used as the
 * per-chunk token budget. Contexts with structured or file-backed content
 * should supply a custom ChunkerOperation.
 */
export const defaultChunker: ChunkerOperation = async (item, maxChunkSize) => {
  const body =
    (typeof item.content === "string" && item.content) ||
    (typeof item.description === "string" && item.description) ||
    "";
  const name = typeof item.name === "string" ? item.name : "";
  const text = [name, body].filter(Boolean).join("\n\n").trim();

  if (!text) {
    return { item, chunks: [] };
  }

  const chunker = await SentenceChunker.create({ chunkSize: maxChunkSize });
  const sentenceChunks = await chunker(text);

  const chunks = sentenceChunks
    .map((c, index) => ({ content: c.text.trim(), index }))
    .filter((c) => c.content.length > 0)
    // Re-index after filtering so indexes stay contiguous (0..n-1).
    .map((c, index) => ({ content: c.content, index }));

  return { item, chunks };
};
