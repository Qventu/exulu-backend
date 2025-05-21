import { createClient, type RedisClientType } from "redis"
import { redisServer } from "../bullmq/server.ts";
export let redisClient: RedisClientType | null = null;

(async () => {
    if (!redisClient) {
        const url = `redis://${redisServer.host}:${redisServer.port}`
        console.log(`[EXULU] connecting to redis.`)
        redisClient = createClient({ // todo add password
            url
        });
        await redisClient.connect()
    }
})();