import type { Knex } from "knex";
import { checkLicense } from "@EE/entitlements.ts";
import { createLinkStore } from "./links";
import { safeError } from "./log";

const LOG = "[EXULU-CHANNEL]";

/**
 * The channel tables exist only on installations licensed for `channels`. The generic user
 * export and user deletion must not touch them otherwise. Read at call time (environment variable).
 */
const channelsLicensed = (): boolean => checkLicense()["channels"] === true;

/**
 * The user's WhatsApp links for the GDPR export, across all channels, with the FULL identity
 * (it is the user's own data). Empty without the licence. A failing query yields an empty
 * section, as the export's other optional sections do.
 */
export const channelLinksForExport = async (db: Knex, userId: number): Promise<unknown[]> => {
  if (!channelsLicensed()) return [];
  try {
    const links = await createLinkStore(db).listAllForUser(userId);
    return links.map((l) => ({
      channel: l.channel,
      identity: l.identity,
      linked_at: l.linked_at,
      expires_at: l.expires_at,
      revoked_at: l.revoked_at,
      last_seen_at: l.last_seen_at,
    }));
  } catch (error) {
    console.error(`${LOG} reading the links for a data export failed`, safeError(error));
    return [];
  }
};

/**
 * Hard-deletes every link of a deleted user (no soft revoke: the phone identity must not remain).
 * No-op without the licence. Errors propagate when licensed: pass the transaction so that the
 * user deletion rolls back with it.
 */
export const afterUserDelete = async (db: Knex, userId: unknown): Promise<void> => {
  const id = Number(userId);
  if (!Number.isFinite(id)) return;
  if (!channelsLicensed()) return;
  await createLinkStore(db).deleteForUser(id);
};

/** For deletions that are not transactional (the user row is already gone): never throws. */
export const afterUserDeleteBestEffort = async (db: Knex, userId: unknown): Promise<void> => {
  try {
    await afterUserDelete(db, userId);
  } catch (error) {
    console.error(`${LOG} removing the links of a deleted user failed`, safeError(error));
  }
};
