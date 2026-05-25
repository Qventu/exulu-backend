import type { FetchFunction } from "@ai-sdk/provider-utils";

const MAX_LEN = 63;

function sanitizeTagKey(raw: string): string {
  let s = (raw ?? "").normalize("NFKC").toLowerCase().replace(/[^a-z0-9_-]/g, "-");
  if (!/^[a-z]/.test(s)) s = "k_" + s;
  return s.slice(0, MAX_LEN);
}

function sanitizeTagValue(
  raw: string | number | undefined | null,
): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  const s = String(raw).normalize("NFKC").toLowerCase().replace(/[^a-z0-9_-]/g, "-");
  return s.slice(0, MAX_LEN);
}

export function buildTags(input: {
  user?: number | string;
  role?: string;
  project?: string;
  agent?: string;
}): string[] {
  const candidates: (string | number | undefined)[] = [input.user, input.role, input.project, input.agent];
  const out: string[] = [];
  for (const candidate of candidates) {
    if (candidate === undefined || candidate === null) continue;
    const value = sanitizeTagValue(candidate);
    if (value === undefined || value === "") continue;
    out.push(sanitizeTagKey(value));
  }
  return out;
}

type FetchInit = Parameters<typeof globalThis.fetch>[1];

function decodeBody(body: unknown): string | undefined {
  if (typeof body === "string") return body;
  if (body instanceof Uint8Array) return new TextDecoder().decode(body);
  return undefined;
}

function stripContentLengthHeader(headers: unknown): unknown {
  if (!headers) return headers;
  if (typeof (headers as { delete?: unknown }).delete === "function") {
    // Headers instance
    const clone = new (globalThis as any).Headers(headers as any);
    clone.delete("content-length");
    return clone;
  }
  if (Array.isArray(headers)) {
    return (headers as Array<[string, string]>).filter(
      ([k]) => k.toLowerCase() !== "content-length",
    );
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers as Record<string, string>)) {
    if (k.toLowerCase() === "content-length") continue;
    out[k] = v;
  }
  return out;
}

export function createTaggedFetch(tags: string[]): FetchFunction {
  const labeled = async (input: Parameters<typeof globalThis.fetch>[0], init?: FetchInit) => {
    try {
      if (!init || !init.body) return globalThis.fetch(input, init);

      const method = (init.method ?? "POST").toUpperCase();
      if (method !== "POST" && method !== "PUT" && method !== "PATCH") {
        return globalThis.fetch(input, init);
      }

      const decoded = decodeBody(init.body);
      if (decoded === undefined) {
        console.warn("[vertex-labels] unsupported body type, forwarding unchanged");
        return globalThis.fetch(input, init);
      }

      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(decoded);
      } catch {
        console.warn("[vertex-labels] body is not JSON, forwarding unchanged");
        return globalThis.fetch(input, init);
      }

      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return globalThis.fetch(input, init);
      }

      const existing = (parsed.metadata as Record<string, string> | undefined) ?? {};
      parsed.metadata = { ...existing, tags: tags };

      console.log("[EXULU] tags", parsed.tags);

      const nextInit = {
        ...init,
        body: JSON.stringify(parsed),
        headers: stripContentLengthHeader(init.headers) as FetchInit extends infer T
          ? T extends { headers?: infer H }
          ? H
          : never
          : never,
      } as FetchInit;
      return globalThis.fetch(input, nextInit);
    } catch (err) {
      console.warn("[vertex-labels] label injection failed, forwarding unchanged", err);
      return globalThis.fetch(input, init);
    }
  };
  return labeled as unknown as FetchFunction;
}
