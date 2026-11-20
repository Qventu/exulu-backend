import type { Knex } from "knex";
import { channelsLicensed } from "./licence";
import { createLinkStore } from "./links";
import { safeError } from "./log";

const LOG = "[EXULU-CHANNEL]";
const TABLE = "channel_links";

// The channel tables exist only on installations licensed for `channels`: the generic user
// export and user deletion touch them only when channelsLicensed() (read at call time).

/**
 * The user's WhatsApp links for the GDPR export, across all channels, with the FULL identity
 * (it is the user's own data). Empty without the licence. A failing query yields an empty
 * section, as the export's other optional sections do.
 */
export const channelLinksForExport = async (db: Knex, userId: number): Promise<unknown[]> => {
  if (!channelsLicensed()) return [];
  try {
    if (!(await db.schema.hasTable(TABLE))) return [];
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
  // Licence added but the schema not yet initialised: no table, no personal data. Same guard as claim_checks.
  if (!(await db.schema.hasTable(TABLE))) return;
  await createLinkStore(db).deleteForUser(id);
};

/** For deletions that are not transactional (the user row is already gone): never throws. */
export const afterUserDeleteBestEffort = async (db: Knex, userId: unknown): Promise<void> => {
  try {
    await afterUserDelete(db, userId);
  } catch (error) {
    console.error(`${LOG} removing the links of deleted user ${Number(userId)} failed`, safeError(error));
  }
};
