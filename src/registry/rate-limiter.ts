import {redisClient} from "../redis/client.ts";

export const rateLimiter = async (key: string, windowSeconds: number, limit: number, points: number) => {

    const { client } = await redisClient();

    if (!client) {
        return {
            status: false,
            retryAfter: 10 // 10 seconds
        }
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
            retryAfter: ttl
        }
    }

    return {
        status: true,
        retryAfter: null
    }
};