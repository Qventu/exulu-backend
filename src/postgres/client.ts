import Knex from "knex";
import { Knex as KnexType } from "knex";
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import pgvector from "pgvector/knex"; // Side-effect import: registers pgvector methods with knex
let db: Record<string, KnexType | undefined> = {};
let databaseExistsChecked = false;

const dbName = process.env.POSTGRES_DB_NAME || "exulu";

async function ensureDatabaseExists(): Promise<void> {
  // Connect to default postgres database to check/create exulu database
  const defaultKnex = Knex({
    client: "pg",
    connection: {
      host: process.env.POSTGRES_DB_HOST,
      port: parseInt(process.env.POSTGRES_DB_PORT || "5432"),
      user: process.env.POSTGRES_DB_USER,
      database: "postgres", // Connect to default database
      password: process.env.POSTGRES_DB_PASSWORD,
      ssl: process.env.POSTGRES_DB_SSL === "true" ? { rejectUnauthorized: false } : false,
      connectionTimeoutMillis: 10000,
    },
    pool: {
      min: 2,
      max: 4,
      acquireTimeoutMillis: 30000,
      createTimeoutMillis: 30000,
      idleTimeoutMillis: 30000,
      reapIntervalMillis: 1000,
      createRetryIntervalMillis: 200,
    },
  });

  try {
    // Check if exulu database exists
    const result = await defaultKnex.raw(`
            SELECT 1 FROM pg_database WHERE datname = '${dbName}'
        `);

    if (result.rows.length === 0) {
      console.log(`[EXULU] Database '${dbName}' does not exist. Creating it...`);
      await defaultKnex.raw(`CREATE DATABASE ${dbName}`);
      console.log(`[EXULU] Database '${dbName}' created successfully.`);
    } else {
      console.log(`[EXULU] Database '${dbName}' already exists.`);
    }
  } catch (error) {
    console.error(
      "[EXULU] Error while checking to ensure the database exists, this could be if the user running the server does not have database admin rights, it is fine to ignore this if you are sure the database exists.",
      error,
    );
    return;
  } finally {
    await defaultKnex.destroy();
  }
}

export async function postgresClient(): Promise<{
  db: KnexType;
}> {
  if (!db["exulu"]) {
    try {
      // Only check database existence once per application lifecycle
      if (!databaseExistsChecked) {
        await ensureDatabaseExists();
        databaseExistsChecked = true;
      }
      const knex = Knex({
        client: "pg",
        connection: {
          host: process.env.POSTGRES_DB_HOST,
          port: parseInt(process.env.POSTGRES_DB_PORT || "5432"),
          user: process.env.POSTGRES_DB_USER,
          database: dbName,
          password: process.env.POSTGRES_DB_PASSWORD,
          ssl: process.env.POSTGRES_DB_SSL === "true" ? { rejectUnauthorized: false } : false,
          connectionTimeoutMillis: 30000, // Increased from 10s to 30s to handle connection spikes
          // PostgreSQL statement timeout (in milliseconds) - kills queries that run too long
          // This prevents runaway queries from blocking connections
          statement_timeout: 1800000, // 30 minutes - should be longer than max job timeout (1200s = 20m)
          // Connection idle timeout - how long pg client waits before timing out
          query_timeout: 1800000, // 30 minutes
        },
        pool: {
          min: 5, // Increased from 2 to ensure enough connections available
          max: 50, // Increased from 20 to handle more concurrent operations with processor jobs
          acquireTimeoutMillis: 60000, // Increased from 30s to 60s to handle pool contention
          createTimeoutMillis: 30000,
          idleTimeoutMillis: 60000, // Increased to keep connections alive longer
          reapIntervalMillis: 1000,
          createRetryIntervalMillis: 200,
          // Log pool events to help debug connection issues
          afterCreate: (conn: any, done: any) => {
            console.log("[EXULU] New database connection created");
            // Set statement_timeout on each new connection
            conn.query("SET statement_timeout = 1800000", (err: any) => {
              if (err) {
                console.error("[EXULU] Error setting statement_timeout:", err);
              }
              done(err, conn);
            });
          },
        },
      });
      try {
        // Unfortunately, knex does not include createExtensionIfNotExists in
        // its type definitions, so we need to cast it to any.
        await (knex.schema as any).createExtensionIfNotExists("vector");
      } catch (error) {
        console.error(
          "[EXULU] Error creating vector extension, this might be fine if you already activated the extension and the 'user' running this script does not have higher level database permissions.",
          error,
        );
      }
      db["exulu"] = knex;
    } catch (error) {
      console.error("[EXULU] Error initializing exulu database.", error);
      throw error;
    }
  }

  return {
    db: db["exulu"],
  };
}
