import { Pool } from "pg";
import { safeError } from "./log";

let pool: Pool | undefined;

/**
 * The one `pg.Pool` per process that the chat SDK's state adapter uses (it wants a
 * pg.Pool, not knex). Created on first use, with the same connection settings as
 * postgresClient() and the initdb pool in init-exulu-db.ts.
 */
export const getChannelPgPool = (): Pool => {
  if (!pool) {
    pool = new Pool({
      host: process.env.POSTGRES_DB_HOST,
      port: parseInt(process.env.POSTGRES_DB_PORT || "5432"),
      user: process.env.POSTGRES_DB_USER,
      database: process.env.POSTGRES_DB_NAME || "exulu",
      password: process.env.POSTGRES_DB_PASSWORD,
      ssl: process.env.POSTGRES_DB_SSL === "true" ? { rejectUnauthorized: false } : false,
      max: 5,
    });
    // An idle client's error is emitted on the pool; without a listener it would crash the process.
    pool.on("error", (error: Error) => {
      console.error("[EXULU-CHANNEL] chat state database connection error", safeError(error));
    });
  }
  return pool;
};
