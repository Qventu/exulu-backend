import type { Request } from "express";
import { redisClient } from "../redis/client.ts";
import type { AgentRateLimits } from "@EXULU_TYPES/models/agent";

export type RateLimitOk = { ok: true };
export type RateLimitDenied = { ok: false; metric: RateLimitMetric; retryAfter: number };
export type RateLimitMetric = "requests" | "input_tokens" | "output_tokens";

export function resolveCallerId(req: Request, userId?: string | number | null): string {
  if (userId !== undefined && userId !== null && userId !== "") {
    return `user:${userId}`;
  }
  const fwd = (req.headers["x-forwarded-for"] as string | undefined)
    ?.split(",")[0]
    ?.trim();
  return `ip:${fwd ?? req.ip ?? "unknown"}`;
}

const key = (agentId: string, callerId: string, metric: RateLimitMetric) =>
  `exulu/ratelimit/agent/${agentId}/caller/${callerId}/${metric}`;

export async function preCheckAgentRateLimit(args: {
  agentId: string;
  callerId: string;
  limits: AgentRateLimits | null | undefined;
}): Promise<RateLimitOk | RateLimitDenied> {
  if (!args.limits) return { ok: true };
  const { client } = await redisClient();
  if (!client) {
    console.warn("[EXULU] Rate limiting disabled - Redis not available");
    return { ok: true };
  }

  // 1. Pre-check token counters (read-only)
  for (const metric of ["input_tokens", "output_tokens"] as const) {
    const cfg = args.limits[metric];
    if (!cfg) continue;
    const k = key(args.agentId, args.callerId, metric);
    const raw = await client.get(k);
    const used = raw ? Number(raw) : 0;
    if (used >= cfg.limit) {
      const ttl = await client.ttl(k);
      return { ok: false, metric, retryAfter: Math.max(ttl, 1) };
    }
  }

  // 2. Increment request counter
  const reqCfg = args.limits.requests;
  if (reqCfg) {
    const k = key(args.agentId, args.callerId, "requests");
    const current = await client.incrBy(k, 1);
    if (current === 1) await client.expire(k, reqCfg.window_seconds);
    if (current > reqCfg.limit) {
      const ttl = await client.ttl(k);
      return { ok: false, metric: "requests", retryAfter: Math.max(ttl, 1) };
    }
  }

  return { ok: true };
}

export async function recordAgentTokenUsage(args: {
  agentId: string;
  callerId: string;
  limits: AgentRateLimits | null | undefined;
  inputTokens?: number;
  outputTokens?: number;
}): Promise<void> {
  if (!args.limits) return;
  const { client } = await redisClient();
  if (!client) return;

  const work: Promise<unknown>[] = [];
  for (const metric of ["input_tokens", "output_tokens"] as const) {
    const cfg = args.limits[metric];
    if (!cfg) continue;
    const count = metric === "input_tokens" ? args.inputTokens : args.outputTokens;
    if (!count || count <= 0) continue;
    const k = key(args.agentId, args.callerId, metric);
    work.push((async () => {
      const v = await client.incrBy(k, count);
      if (v === count) await client.expire(k, cfg.window_seconds);
    })());
  }
  await Promise.allSettled(work);
}
