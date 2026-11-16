import { createHash } from "crypto";
import type { ExuluConfig } from "@SRC/exulu/app";
import { getS3ObjectBytes, getS3ObjectTextExact, headS3ObjectExact, putS3ObjectTextExact } from "@SRC/uppy";
import { contentKey, pointerKey } from "./keys";
import type { ProgressFn } from "./progress";

export type StoreIo = {
  head(key: string): Promise<{ etag: string | null } | null>;
  getBytes(key: string): Promise<Buffer>;
  getText(key: string): Promise<{ text: string; lastModified: Date } | null>;
  putText(key: string, text: string, metadata: Record<string, string>): Promise<void>;
};

export type Extracted = { text: string; totalPages?: number; storable: boolean };

export type ReadThroughResult = { text: string; totalPages?: number; fromStore: boolean };

type InFlight = { promise: Promise<ReadThroughResult>; listeners: Set<ProgressFn> };
const inFlight = new Map<string, InFlight>();

const DAY_MS = 24 * 60 * 60 * 1000;
const sha256Hex = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

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
 * (bucket/key -> etag + sha256) lets a repeat read skip downloading the source.
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

  const fromStoredText = (stored: { text: string; lastModified: Date } | null): ReadThroughResult | null => {
    if (!stored) return null;
    if (now().getTime() - stored.lastModified.getTime() > cacheDays * DAY_MS) return null;
    return { text: stored.text, totalPages: countPageMarkers(stored.text), fromStore: true };
  };

  const readText = async (key: string) => {
    try {
      return await io.getText(key);
    } catch (err) {
      warn(`could not read ${key}`, err);
      return null;
    }
  };

  let etag: string | null = null;
  if (useStore) {
    try {
      etag = (await io.head(sourceKey))?.etag ?? null;
    } catch (err) {
      warn(`could not head ${sourceKey}`, err);
    }
    if (etag) {
      const pointerRaw = await readText(pointerAt);
      let pointer: { etag?: unknown; sha256?: unknown } | null = null;
      try {
        pointer = pointerRaw ? JSON.parse(pointerRaw.text) : null;
      } catch {
        pointer = null;
      }
      if (pointer && pointer.etag === etag && typeof pointer.sha256 === "string") {
        const hit = fromStoredText(await readText(contentKey(pointer.sha256, fingerprint.id, s3prefix)));
        if (hit) return hit;
      }
    }
  }

  const bytes = await io.getBytes(sourceKey);
  const sha = sha256Hex(bytes);
  const textKey = contentKey(sha, fingerprint.id, s3prefix);

  const writePointer = async () => {
    if (!etag) return;
    await io.putText(pointerAt, JSON.stringify({ etag, sha256: sha }), {});
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
        await io.putText(textKey, extracted.text, { "exulu-extractor": fingerprint.label });
        await writePointer();
      } catch (err) {
        warn("could not store extracted text", err);
      }
    }
    return { text: extracted.text, totalPages: extracted.totalPages, fromStore: false };
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
    getBytes: (key) => getS3ObjectBytes(key, exuluConfig),
    getText: (key) => getS3ObjectTextExact(key, exuluConfig),
    putText: (key, text, metadata) =>
      putS3ObjectTextExact(key, text, metadata, exuluConfig, key.endsWith(".json") ? "application/json" : undefined),
  };
}
