import type { ExuluAgent } from "@SRC/exulu/agent";
import { redisClient } from "../redis/client.ts";

export const checkAgentRateLimit = async (agent: ExuluAgent) => {
  if (agent.rateLimit) {
    console.log("[EXULU] rate limiting agent.", agent.rateLimit);
    const limit = await agentRateLimiter(
      agent.rateLimit.name || agent.id,
      agent.rateLimit.rate_limit.time,
      agent.rateLimit.rate_limit.limit,
      1,
    );

    if (!limit.status) {
      throw new Error("Rate limit exceeded.");
    }
  }
};

const agentRateLimiter = async (
  key: string,
  windowSeconds: number,
  limit: number,
  points: number,
) => {
  try {
    const { client } = await redisClient();

    if (!client) {
      // If Redis is not available, allow the request but log a warning
      console.warn("[EXULU] Rate limiting disabled - Redis not available");
      return {
        status: true,
        retryAfter: null,
      };
    }

    const redisKey: any = `exulu/${key}`;
    const current = await client.incrBy(redisKey, points as any);

    if (current === points) {
      await client.expire(redisKey, windowSeconds as any);
    }

    if (current > limit) {
      const ttl = await client.ttl(redisKey);
      return {
        status: false,
        retryAfter: ttl,
      };
    }

    return {
      status: true,
      retryAfter: null,
    };
  } catch (error) {
    // If any Redis operation fails, allow the request but log the error
    console.error("[EXULU] Rate limiting error:", error);
    return {
      status: true,
      retryAfter: null,
    };
  }
};
