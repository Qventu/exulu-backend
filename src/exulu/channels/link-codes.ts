import { createHash, randomInt } from "crypto";

/** The slice of node-redis v4 this module needs; the real client is passed in by the caller. */
export interface KeyValueStore {
  set(key: string, value: string, opts: { EX: number }): Promise<unknown>;
  getDel(key: string): Promise<string | null>;
  del(key: string): Promise<unknown>;
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<unknown>;
  get(key: string): Promise<string | null>;
}

export const CODE_TTL_SECONDS = 600;
const ATTEMPT_WINDOW_SECONDS = 3600;
const MAX_ATTEMPTS = 5;
const PROMPT_WINDOW_SECONDS = 600;
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 8;

const hashCode = (raw: string): string => createHash("sha256").update(raw).digest("hex");
const codeKey = (raw: string) => `channel-link:code:${hashCode(raw)}`;
const userKey = (channelId: string, userId: number) => `channel-link:user:${channelId}:${userId}`;

/** Returns "XXXX-XXXX". */
export const generateCode = (): string => {
  let raw = "";
  for (let i = 0; i < CODE_LENGTH; i++) raw += ALPHABET[randomInt(ALPHABET.length)];
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
};

/** Whole-message match only: the trimmed text must be exactly one code. Otherwise null. */
export const normalizeCode = (text: string): string | null => {
  const raw = text.trim().toUpperCase().replace(/[\s-]/g, "");
  if (raw.length !== CODE_LENGTH) return null;
  for (const ch of raw) if (!ALPHABET.includes(ch)) return null;
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
};

export const issueCode = async (
  kv: KeyValueStore,
  p: { channelId: string; userId: number },
): Promise<string> => {
  const pointer = userKey(p.channelId, p.userId);
  const previous = await kv.getDel(pointer);
  if (previous) await kv.del(`channel-link:code:${previous}`);

  const code = generateCode();
  const hash = hashCode(code.replace("-", ""));
  await kv.set(`channel-link:code:${hash}`, JSON.stringify({ channelId: p.channelId, userId: p.userId }), {
    EX: CODE_TTL_SECONDS,
  });
  await kv.set(pointer, hash, { EX: CODE_TTL_SECONDS });
  return code;
};

export const consumeCode = async (
  kv: KeyValueStore,
  code: string,
): Promise<{ channelId: string; userId: number } | null> => {
  const normalized = normalizeCode(code);
  if (!normalized) return null;
  const value = await kv.getDel(codeKey(normalized.replace("-", "")));
  if (!value) return null;
  let parsed: { channelId: string; userId: number };
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  await kv.del(userKey(parsed.channelId, parsed.userId));
  return { channelId: parsed.channelId, userId: parsed.userId };
};

/** Counts this attempt. True from the 6th attempt within 3600 s of the first. */
export const codeAttemptsExceeded = async (
  kv: KeyValueStore,
  channelId: string,
  identity: string,
): Promise<boolean> => {
  const key = `channel-link:attempts:${channelId}:${identity}`;
  const n = await kv.incr(key);
  if (n === 1) await kv.expire(key, ATTEMPT_WINDOW_SECONDS);
  return n > MAX_ATTEMPTS;
};

/** True at most once per 600 s per identity. */
export const linkPromptAllowed = async (
  kv: KeyValueStore,
  channelId: string,
  identity: string,
): Promise<boolean> => {
  const key = `channel-link:prompt:${channelId}:${identity}`;
  const n = await kv.incr(key);
  if (n === 1) await kv.expire(key, PROMPT_WINDOW_SECONDS);
  return n === 1;
};
