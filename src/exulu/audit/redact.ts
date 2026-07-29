// Aggressive by design: substring match, so "token" also catches accessToken.
export const SECRET_KEY_DENYLIST = [
  "oauth", "credentials", "accesstoken", "refreshtoken",
  "password", "secret", "token", "apikey", "authorization", "nonce",
];

// Injected by convertExuluToolsToAiSdkTools into tool inputs — never audited.
export const FRAMEWORK_INTERNAL_KEYS = new Set([
  "req", "model", "contexts", "upload", "memory", "exuluConfig",
  "toolVariablesConfig", "allExuluTools", "currentTools", "sessionItems", "audit",
]);

const isSecretKey = (key: string, extra: string[]): boolean => {
  const k = key.toLowerCase();
  if (extra.some((e) => k.includes(e.toLowerCase()))) return true;
  return SECRET_KEY_DENYLIST.some((term) => k.includes(term));
};

const redact = (value: unknown, redactKeys: string[], seen: WeakSet<object>): unknown => {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value as object)) return "[circular]";
  seen.add(value as object);
  if (Array.isArray(value)) return value.map((v) => redact(v, redactKeys, seen));
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    if (FRAMEWORK_INTERNAL_KEYS.has(key)) continue;
    if (isSecretKey(key, redactKeys)) {
      // For object values, keep the key as a "[redacted]" marker so the log
      // signals that a subtree was suppressed.  For primitive values, drop
      // the key entirely so the key name itself does not leak information.
      if (val !== null && typeof val === "object") {
        out[key] = "[redacted]";
      }
      continue;
    }
    out[key] = redact(val, redactKeys, seen);
  }
  return out;
};

/**
 * Deep-cleans `value` before it is persisted to the audit log.
 * Key matching is substring-based throughout (e.g. `"token"` catches `accessToken`).
 * Object-valued secret keys are replaced with `"[redacted]"` to signal that a
 * subtree was suppressed; primitive-valued secret keys are dropped entirely so
 * the key name itself does not leak information.
 */
export const sanitizeData = (
  value: unknown,
  opts: { maxBytes: number; redactKeys?: string[] },
): { value: unknown; truncated: boolean } => {
  let cleaned: unknown;
  try {
    cleaned = redact(value, opts.redactKeys ?? [], new WeakSet());
  } catch {
    cleaned = "[unserializable]";
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(cleaned) ?? "";
  } catch {
    return { value: "[unserializable]", truncated: false };
  }
  if (serialized.length <= opts.maxBytes) return { value: cleaned, truncated: false };
  return {
    value: { _truncated: true, preview: serialized.slice(0, opts.maxBytes) },
    truncated: true,
  };
};
