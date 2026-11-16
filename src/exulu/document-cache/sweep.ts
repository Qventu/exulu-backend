import type { ExuluConfig } from "../app/index";
import { DERIVED_ROOT, documentCacheDays, isDerivedKey } from "./keys";
import { deleteS3ObjectsExact, listS3ObjectsExact } from "../../uppy/index";

export type SweepListing = {
  items: { key: string; lastModified: Date }[];
  next?: string;
};

const FIRST_RUN_MS = 60_000;
const INTERVAL_MS = 24 * 60 * 60 * 1000;

const derivedPrefix = (s3prefix?: string | null) => {
  const trimmed = (s3prefix ?? "").replace(/^\/+|\/+$/g, "");
  return `${trimmed ? `${trimmed}/` : ""}${DERIVED_ROOT}/`;
};

/**
 * Deletes objects under `[<s3prefix>/]derived/` whose last-modified is older than
 * `cacheDays` (0 = everything). One listing page at a time, deletes per page. A key
 * outside the derived prefix is never deleted, whatever the listing returns. Replicas
 * may sweep concurrently: deleting an already deleted key is not an error in S3.
 */
export async function sweepExpiredDerived(args: {
  list(prefix: string, token?: string): Promise<SweepListing>;
  remove(keys: string[]): Promise<void>;
  s3prefix?: string | null;
  cacheDays: number;
  now?: () => Date;
}): Promise<{ deleted: number }> {
  const prefix = derivedPrefix(args.s3prefix);
  const cutoff = (args.now?.() ?? new Date()).getTime() - args.cacheDays * 86_400_000;
  let deleted = 0;
  let token: string | undefined;
  do {
    const page = await args.list(prefix, token);
    const keys = page.items
      .filter((o) => o.key.startsWith(prefix) && isDerivedKey(o.key, args.s3prefix))
      .filter((o) => args.cacheDays === 0 || o.lastModified.getTime() < cutoff)
      .map((o) => o.key);
    if (keys.length > 0) {
      try {
        await args.remove(keys);
        deleted += keys.length;
      } catch (err) {
        console.error(`[EXULU] derived sweep: delete failed: ${(err as Error).message}`);
      }
    }
    token = page.next;
  } while (token);
  return { deleted };
}

/** Daily sweep of expired stored document text. Returns a stop function. */
export function startDerivedSweep(exuluConfig: ExuluConfig): () => void {
  let running = false;
  let stopped = false;
  const run = async () => {
    if (running || stopped) return;
    running = true;
    try {
      const { deleted } = await sweepExpiredDerived({
        list: (prefix, token) => listS3ObjectsExact(prefix, token, exuluConfig),
        remove: (keys) => deleteS3ObjectsExact(keys, exuluConfig),
        s3prefix: exuluConfig.fileUploads?.s3prefix,
        cacheDays: documentCacheDays(),
      });
      if (deleted > 0) console.log(`[EXULU] derived sweep removed ${deleted} expired object(s)`);
    } catch (err) {
      console.error(`[EXULU] derived sweep failed: ${(err as Error).message}`);
    } finally {
      running = false;
    }
  };
  const first = setTimeout(run, FIRST_RUN_MS);
  const every = setInterval(run, INTERVAL_MS);
  first.unref();
  every.unref();
  return () => {
    stopped = true;
    clearTimeout(first);
    clearInterval(every);
  };
}
