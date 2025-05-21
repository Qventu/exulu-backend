import {redisClient} from "../redis/client.ts";

export const rateLimiter = async (key: string, windowSeconds: number, limit: number, points: number) => {

    if (!redisClient) {
        return {
            status: false,
            retryAfter: 10 // 10 seconds
        }
    }

    const redisKey: any = `exulu/${key}`;
    const current = await redisClient.incrBy(redisKey, points as any);

    if (current === points) {
        await redisClient.expire(redisKey, windowSeconds as any);
    }

    if (current > limit) {
        const ttl = await redisClient.ttl(redisKey);
        return {
            status: false,
            retryAfter: ttl
        }
    }

    return {
        status: true,
        retryAfter: null
    }
};