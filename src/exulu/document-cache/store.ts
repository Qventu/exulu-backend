import { createHash } from "crypto";
import type { ExuluConfig } from "@SRC/exulu/app";
import { getS3ObjectBytesWithInfo, getS3ObjectTextExact, headS3ObjectExact, putS3ObjectTextExact } from "@SRC/uppy";
import { contentKey, pointerKey } from "./keys";
import type { ProgressFn } from "./progress";

/** Identity of one version of an object. */
export type ObjectInfo = { etag: string | null; lastModified: Date | null; size: number | null };

export type StoreIo = {
  head(key: string): Promise<ObjectInfo | null>;
  /** The bytes plus the identity of the version that produced them (from the same GetObject). */
  getBytes(key: string): Promise<{ bytes: Buffer } & ObjectInfo>;
  getText(key: string): Promise<{ text: string; lastModified: Date; metadata?: Record<string, string> } | null>;
  putText(key: string, text: string, metadata: Record<string, string>): Promise<void>;
};

export type Extracted = { text: string; totalPages?: number; storable: boolean; degradedPages?: number[] };

export type ReadThroughResult = { text: string; totalPages?: number; fromStore: boolean; degradedPages?: number[] };

type InFlight = { promise: Promise<ReadThroughResult>; listeners: Set<ProgressFn> };
const inFlight = new Map<string, InFlight>();

const DAY_MS = 24 * 60 * 60 * 1000;
const sha256Hex = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

/** Stored on the content object so a hit knows the page count without parsing the text. */
export const PAGES_METADATA_KEY = "exulu-pages";

/** `--- page N ---` markers in a stored text; none means the page count is unknown. */
export function countPageMarkers(text: string): number | undefined {
  const count = (text.match(/^--- page \d+ ---$/gm) ?? []).length;
  return count > 0 ? count : undefined;
}

const warn = (what: string, err: unknown) =>
  console.warn(`[EXULU] document store: ${what}:`, err instanceof Error ? err.message : String(err));

/**
 * Returns the extracted text of the object at `sourceKey`, reading it through the
 * content-addressed store: text is keyed by the sha256 of the bytes and the extractor
 * fingerprint, so one document is extracted once per instance. A pointer
 * (bucket/key -> etag + lastModified + size + sha256) lets a repeat read skip downloading the source.
 * Only `storable` results are written; refusals and failures are never stored.
 */
export async function readThroughDocument(args: {
  io: StoreIo;
  bucket: string;
  sourceKey: string;
  s3prefix?: string | null;
  fingerprint: { id: string; label: string };
  cacheDays: number;
  now?: () => Date;
  extract: (bytes: Buffer, onProgress?: ProgressFn) => Promise<Extracted>;
  onProgress?: ProgressFn;
}): Promise<ReadThroughResult> {
  const { io, bucket, sourceKey, s3prefix, fingerprint, cacheDays, extract, onProgress } = args;
  const now = args.now ?? (() => new Date());
  const useStore = cacheDays > 0;
  const pointerAt = pointerKey(bucket, sourceKey, s3prefix);

  const fromStoredText = (
    stored: { text: string; lastModified: Date; metadata?: Record<string, string> } | null,
  ): ReadThroughResult | null => {
    if (!stored) return null;
    if (now().getTime() - stored.lastModified.getTime() > cacheDays * DAY_MS) return null;
    const pages = Number(stored.metadata?.[PAGES_METADATA_KEY]);
    // Marker counting is only the fallback for objects written without the metadata.
    const totalPages = Number.isInteger(pages) && pages > 0 ? pages : countPageMarkers(stored.text);
    return { text: stored.text, totalPages, fromStore: true };
  };

  const readText = async (key: string) => {
    try {
      return await io.getText(key);
    } catch (err) {
      warn(`could not read ${key}`, err);
      return null;
    }
  };

  if (useStore) {
    let head: ObjectInfo | null = null;
    try {
      head = await io.head(sourceKey);
    } catch (err) {
      warn(`could not head ${sourceKey}`, err);
    }
    if (head && head.etag && head.lastModified && head.size !== null) {
      const pointerRaw = await readText(pointerAt);
      let pointer: { etag?: unknown; lastModified?: unknown; size?: unknown; sha256?: unknown } | null = null;
      try {
        pointer = pointerRaw ? JSON.parse(pointerRaw.text) : null;
      } catch {
        pointer = null;
      }
      // Trusted only when all three still match; a pointer in the older two-field shape has no
      // lastModified or size and is therefore treated as absent.
      if (
        pointer &&
        pointer.etag === head.etag &&
        pointer.lastModified === head.lastModified.toISOString() &&
        pointer.size === head.size &&
        typeof pointer.sha256 === "string"
      ) {
        const hit = fromStoredText(await readText(contentKey(pointer.sha256, fingerprint.id, s3prefix)));
        if (hit) return hit;
      }
    }
  }

  // The identity stored in the pointer comes from the response that produced the hashed bytes,
  // never from the earlier HEAD: an overwrite between the two cannot pair old identity with new bytes.
  const got = await io.getBytes(sourceKey);
  const bytes = got.bytes;
  const sha = sha256Hex(bytes);
  const textKey = contentKey(sha, fingerprint.id, s3prefix);

  const writePointer = async () => {
    if (!got.etag || !got.lastModified || got.size === null) return;
    await io.putText(
      pointerAt,
      JSON.stringify({ etag: got.etag, lastModified: got.lastModified.toISOString(), size: got.size, sha256: sha }),
      {},
    );
  };

  if (useStore) {
    const hit = fromStoredText(await readText(textKey));
    if (hit) {
      try {
        await writePointer();
      } catch (err) {
        warn("could not write pointer", err);
      }
      return hit;
    }
  }

  const flightKey = `${sha}/${fingerprint.id}`;
  const existing = inFlight.get(flightKey);
  if (existing) {
    if (onProgress) existing.listeners.add(onProgress);
    return existing.promise;
  }

  const listeners = new Set<ProgressFn>();
  if (onProgress) listeners.add(onProgress);
  const emit: ProgressFn = (p) => {
    for (const listener of listeners) {
      try {
        listener(p);
      } catch {
        // a broken listener must not stop the extraction
      }
    }
  };

  // The extraction is deliberately not tied to the caller: once started it runs to completion
  // and stores its result even if the caller goes away.
  const promise = (async (): Promise<ReadThroughResult> => {
    const extracted = await extract(bytes, emit);
    if (useStore && extracted.storable) {
      try {
        emit({ phase: "storing", pagesDone: extracted.totalPages ?? 0, pagesTotal: extracted.totalPages ?? 0 });
        await io.putText(textKey, extracted.text, {
          "exulu-extractor": fingerprint.label,
          ...(extracted.totalPages ? { [PAGES_METADATA_KEY]: String(extracted.totalPages) } : {}),
        });
        await writePointer();
      } catch (err) {
        warn("could not store extracted text", err);
      }
    }
    return {
      text: extracted.text,
      totalPages: extracted.totalPages,
      fromStore: false,
      ...(extracted.degradedPages?.length ? { degradedPages: extracted.degradedPages } : {}),
    };
  })().finally(() => {
    inFlight.delete(flightKey);
  });
  inFlight.set(flightKey, { promise, listeners });
  return promise;
}

/** StoreIo over the instance's S3 bucket. Keys are used exactly as given (already complete). */
export function createStoreIo(exuluConfig: ExuluConfig): StoreIo {
  return {
    head: (key) => headS3ObjectExact(key, exuluConfig),
    getBytes: (key) => getS3ObjectBytesWithInfo(key, exuluConfig),
    getText: (key) => getS3ObjectTextExact(key, exuluConfig),
    putText: (key, text, metadata) =>
      putS3ObjectTextExact(key, text, metadata, exuluConfig, key.endsWith(".json") ? "application/json" : undefined),
  };
}
