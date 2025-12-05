import { createClient, type RedisClientType } from "redis"
import { redisServer } from "../bullmq/server.ts";
let client: Record<string, RedisClientType> = {};

export async function redisClient(): Promise<{
    client: RedisClientType | null
}> {
    
    // Early return if Redis is not configured
    if (!redisServer.host || !redisServer.port) {
        return { client: null };
    }

    if (!client["exulu"]) {
        try {
            let url = ""
            if (redisServer.password) {
                url = `redis://${redisServer.username}:${redisServer.password}@${redisServer.host}:${redisServer.port}`
            } else {
                url = `redis://${redisServer.host}:${redisServer.port}`;
            }
            client["exulu"] = createClient({
                url
            });
            await client["exulu"].connect()
        } catch (error) {
            console.error(`[EXULU] error connecting to redis:`, error)
            return { client: null };
        }
    }

    return {
        client: client["exulu"]
    };
}