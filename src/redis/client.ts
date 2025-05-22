import { createClient, type RedisClientType } from "redis"
import { redisServer } from "../bullmq/server.ts";
let client: Record<string, RedisClientType> = {};

export async function redisClient(): Promise<{
    client: RedisClientType | null
}> {
    if (!redisServer.host || !redisServer.port) {
        return {
            client: null
        }
    }

    if (!client["exulu"]) {
        const url = `redis://${redisServer.host}:${redisServer.port}`
        console.log(`[EXULU] connecting to redis.`)
        client["exulu"] = createClient({ // todo add password
            url
        });
        await client["exulu"].connect()
    }

    return {
        client: client["exulu"]
    };
}