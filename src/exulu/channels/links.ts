import type { Knex } from "knex";

export interface ChannelLink {
  id: string;
  channel: string;
  identity: string;
  user: number;
  linked_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
  last_seen_at: Date | null;
}

export type LinkState =
  | { state: "valid"; link: ChannelLink }
  | { state: "none" | "expired" | "revoked" };

const TABLE = "channel_links";
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Access-control rule: valid only if the link exists, is not revoked and
 * `now` is strictly before `expires_at` (exactly at expiry it is expired).
 * Revoked wins over an unexpired date.
 */
export const linkState = (link: ChannelLink | undefined, now: Date): LinkState => {
  if (!link) return { state: "none" };
  if (link.revoked_at) return { state: "revoked" };
  if (now.getTime() >= link.expires_at.getTime()) return { state: "expired" };
  return { state: "valid", link };
};

export const expiryFor = (linkedAt: Date, linkTtlDays: number): Date =>
  new Date(linkedAt.getTime() + linkTtlDays * DAY_MS);

const toDate = (v: unknown): Date => (v instanceof Date ? v : new Date(v as string | number));
const toDateOrNull = (v: unknown): Date | null => (v == null ? null : toDate(v));

// The driver may hand dates back as Date or string; linkState needs real Dates.
const fromRow = (row: any): ChannelLink => ({
  id: row.id,
  channel: row.channel,
  identity: row.identity,
  user: row.user,
  linked_at: toDate(row.linked_at),
  expires_at: toDate(row.expires_at),
  revoked_at: toDateOrNull(row.revoked_at),
  last_seen_at: toDateOrNull(row.last_seen_at),
});

export const createLinkStore = (db: Knex) => ({
  async find(channelId: string, identity: string): Promise<ChannelLink | undefined> {
    const row = await db(TABLE).where({ channel: channelId, identity }).first();
    return row ? fromRow(row) : undefined;
  },

  /** Atomic on the unique (channel, identity) index, so concurrent links cannot race. */
  async upsert(p: {
    channelId: string;
    identity: string;
    userId: number;
    linkTtlDays: number;
    now: Date;
  }): Promise<ChannelLink> {
    const values = {
      user: p.userId,
      linked_at: p.now,
      expires_at: expiryFor(p.now, p.linkTtlDays),
      revoked_at: null,
      last_seen_at: null,
      updatedAt: p.now,
    };
    const [row] = await db(TABLE)
      .insert({ channel: p.channelId, identity: p.identity, ...values })
      .onConflict(["channel", "identity"])
      .merge(values)
      .returning("*");
    return fromRow(row);
  },

  async revoke(linkId: string, now: Date): Promise<void> {
    await db(TABLE).where({ id: linkId }).update({ revoked_at: now, updatedAt: now });
  },

  /** Records activity only; never touches expires_at. */
  async touch(linkId: string, now: Date): Promise<void> {
    await db(TABLE).where({ id: linkId }).update({ last_seen_at: now });
  },

  async listForChannel(channelId: string): Promise<ChannelLink[]> {
    const rows = await db(TABLE).where({ channel: channelId }).orderBy("linked_at", "desc");
    return rows.map(fromRow);
  },

  async listForUser(channelId: string, userId: number): Promise<ChannelLink[]> {
    const rows = await db(TABLE)
      .where({ channel: channelId, user: userId })
      .orderBy("linked_at", "desc");
    return rows.map(fromRow);
  },

  /** All links of a user across channels (data export). */
  async listAllForUser(userId: number): Promise<ChannelLink[]> {
    const rows = await db(TABLE).where({ user: userId }).orderBy("linked_at", "desc");
    return rows.map(fromRow);
  },

  async deleteForUser(userId: number): Promise<number> {
    return db(TABLE).where({ user: userId }).del();
  },
});
