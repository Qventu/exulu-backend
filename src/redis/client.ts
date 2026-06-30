import { createClient, type RedisClientType } from "redis";
import { redisServer } from "../../ee/queues/server.ts";
import { guardRedisStartup, logRedisErrors } from "../../ee/queues/redis-startup.ts";
let client: Record<string, RedisClientType> = {};

export async function redisClient(): Promise<{
  client: RedisClientType | null;
}> {
  // Early return if Redis is not configured
  if (!redisServer.host || !redisServer.port) {
    return { client: null };
  }

  if (!client["exulu"]) {
    try {
      let url = "";
      if (redisServer.password) {
        url = `redis://${redisServer.username}:${redisServer.password}@${redisServer.host}:${redisServer.port}`;
      } else {
        url = `redis://${redisServer.host}:${redisServer.port}`;
      }
      client["exulu"] = createClient({
        url,
      });
      // node-redis requires an `error` listener (an unhandled `error` event would throw); this also
      // surfaces the otherwise-swallowed connection failures with the target address.
      logRedisErrors(client["exulu"], "client");
      // Fail fast with a clear error after the timeout instead of retrying/hanging indefinitely.
      await guardRedisStartup("client", () => client["exulu"]!.connect().then(() => undefined), client["exulu"]);
    } catch (error) {
      console.error(`[EXULU] error connecting to redis:`, error);
      // Drop the half-initialized client: createClient() above assigns the slot BEFORE connect, so on
      // failure the `if (!client["exulu"])` guard would otherwise skip reconnect on every later call and
      // hand back a dead, never-connected client. Clearing it keeps the null contract and allows retry.
      delete client["exulu"];
      return { client: null };
    }
  }

  return {
    client: client["exulu"],
  };
}
