export const redisServer = {
    host: `${process.env.REDIS_HOST}`,
    port: process.env.REDIS_PORT as any,
    password: process.env.REDIS_PASSWORD || undefined,
};