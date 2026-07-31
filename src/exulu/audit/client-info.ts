import type { Request } from "express";

import type { AuditClient } from "./event";

const firstHeader = (v: string | string[] | undefined): string | undefined =>
  Array.isArray(v) ? v[0] : (v ?? undefined);

/**
 * Derive audit client info from an HTTP request. `ip` is the proxy-correct
 * client IP: leftmost x-forwarded-for hop, else req.ip, else the socket
 * remote address. Returns undefined when there is no request (e.g. worker
 * runs) or nothing could be derived, so an empty client is never emitted.
 */
export function extractClientInfo(
  req: Request | undefined | null,
): AuditClient | undefined {
  if (!req) return undefined;
  const headers = (req.headers ?? {}) as Record<string, string | string[] | undefined>;
  const forwardedFor = firstHeader(headers["x-forwarded-for"]);
  const ip =
    (forwardedFor ? forwardedFor.split(",")[0]?.trim() : undefined) ||
    req.ip ||
    req.socket?.remoteAddress ||
    undefined;
  const userAgent = firstHeader(headers["user-agent"]);
  const referer = firstHeader(headers["referer"]);
  const origin = firstHeader(headers["origin"]);

  const client: AuditClient = {};
  if (ip) client.ip = ip;
  if (userAgent) client.userAgent = userAgent;
  if (referer) client.referer = referer;
  if (origin) client.origin = origin;
  if (forwardedFor) client.forwardedFor = forwardedFor;

  return Object.keys(client).length > 0 ? client : undefined;
}
