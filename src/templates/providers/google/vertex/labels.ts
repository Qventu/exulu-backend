import type { FetchFunction } from "@ai-sdk/provider-utils";

const MAX_LEN = 63;
const MAX_LABELS = 64;

export function sanitizeLabelKey(raw: string): string {
  let s = (raw ?? "").normalize("NFKC").toLowerCase().replace(/[^a-z0-9_-]/g, "-");
  if (!/^[a-z]/.test(s)) s = "k_" + s;
  return s.slice(0, MAX_LEN);
}

export function sanitizeLabelValue(
  raw: string | number | undefined | null,
): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  const s = String(raw).normalize("NFKC").toLowerCase().replace(/[^a-z0-9_-]/g, "-");
  return s.slice(0, MAX_LEN);
}

export function buildLabels(input: {
  providerId: string;
  providerName: string;
  user?: number | string;
  role?: string;
  project?: string;
  agent?: string;
}): Record<string, string> {
  const candidates: Array<[string, string | number | undefined]> = [
    ["provider_id", input.providerId],
    ["provider_name", input.providerName],
    ["user_id", input.user],
    ["role_id", input.role],
    ["project_id", input.project],
    ["agent_id", input.agent],
  ];

  const out: Record<string, string> = {};
  for (const [k, v] of candidates) {
    if (Object.keys(out).length >= MAX_LABELS) break;
    const value = sanitizeLabelValue(v);
    if (value === undefined || value === "") continue;
    out[sanitizeLabelKey(k)] = value;
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

export function createLabeledFetch(labels: Record<string, string>): FetchFunction {
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

      const existing = (parsed.labels as Record<string, string> | undefined) ?? {};
      parsed.labels = { ...existing, ...labels };

      console.log("[EXULU] Vertex labels", parsed.labels);

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
