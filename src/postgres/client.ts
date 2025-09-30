import Knex from 'knex';
import { Knex as KnexType } from 'knex';
import pgvector from 'pgvector/knex'; // DONT REMOVE THIS
let db: Record<string, KnexType | undefined> = {};
let databaseExistsChecked = false;

// We have 3 databases, that are seperated on purpose. Exulu core is
// managed by the prisma schema and contains things like agent configurations,
// users, roles, statistics. The exulu knowledge and mastra
// databases are managed dynamically. The exulu knowledge database contains
// all the knowledge base items, while the mastra database contains the
// chat history and user sessions.

const dbName = process.env.POSTGRES_DB_NAME || "exulu";

async function ensureDatabaseExists(): Promise<void> {
    // Connect to default postgres database to check/create exulu database
    console.log(`[EXULU] Ensuring ${dbName} database exists...`)
    const defaultKnex = Knex({
        client: 'pg',
        connection: {
            host: process.env.POSTGRES_DB_HOST,
            port: parseInt(process.env.POSTGRES_DB_PORT || '5432'),
            user: process.env.POSTGRES_DB_USER,
            database: 'postgres', // Connect to default database
            password: process.env.POSTGRES_DB_PASSWORD,
            ssl: process.env.POSTGRES_DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
        }
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
        console.error("[EXULU] Error while checking to ensure the database exists, this could be if the user running the server does not have database admin rights, it is fine to ignore this if you are sure the database exists.", error)
        return;
    } finally {
        await defaultKnex.destroy();
    }
}

export async function postgresClient(): Promise<{
    db: KnexType
}> {
    if (!db["exulu"]) {
        try {
            console.log(`[EXULU] Connecting to ${dbName} database.`)
            console.log("[EXULU] POSTGRES_DB_HOST:", process.env.POSTGRES_DB_HOST)
            console.log("[EXULU] POSTGRES_DB_PORT:", process.env.POSTGRES_DB_PORT)
            console.log("[EXULU] POSTGRES_DB_USER:", process.env.POSTGRES_DB_USER)
            console.log("[EXULU] POSTGRES_DB_PASSWORD:", process.env.POSTGRES_DB_PASSWORD)
            console.log("[EXULU] POSTGRES_DB_SSL:", process.env.POSTGRES_DB_SSL)
            console.log("[EXULU] Database exists checked:", databaseExistsChecked)

            // Only check database existence once per application lifecycle
            if (!databaseExistsChecked) {
                console.log(`[EXULU] Ensuring ${dbName} database exists...`);
                await ensureDatabaseExists();
                databaseExistsChecked = true;
            }
            const knex = Knex({
                client: 'pg',
                connection: {
                    host: process.env.POSTGRES_DB_HOST,
                    port: parseInt(process.env.POSTGRES_DB_PORT || '5432'),
                    user: process.env.POSTGRES_DB_USER,
                    database: dbName,
                    password: process.env.POSTGRES_DB_PASSWORD,
                    ssl: process.env.POSTGRES_DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
                }
            });
            try {
                // @ts-ignore - createExtensionIfNotExists gets added by importing pgvector
                // but it's not typed so we must ignore this.
                await knex.schema.createExtensionIfNotExists('vector');
            } catch (error) {
                console.error("[EXULU] Error creating vector extension, this might be fine if you already activated the extension and the 'user' running this script does not have higher level database permissions.", error)
            }
            db["exulu"] = knex
        } catch (error) {
            console.error("[EXULU] Error initializing exulu database.", error)
            throw error
        }
    }

    return {
        db: db["exulu"]
    };
}

export const refreshPostgresClient = async (): Promise<{
    db: KnexType
}> => {
    if (db["exulu"]) {
        await db["exulu"].destroy();
        db["exulu"] = undefined;
    }
    const { db: refreshed } = await postgresClient();
    return {
        db: refreshed
    };
}
