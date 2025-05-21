import Knex from 'knex';
import { Knex as KnexType } from 'knex';
import pgvector from 'pgvector/knex'; // DONT REMOVE THIS
let db: Record<string, KnexType> = {};

// We have 3 databases, that are seperated on purpose. Exulu core is
// managed by the prisma schema and contains things like agent configurations,
// users, roles, statistics. The exulu knowledge and mastra
// databases are managed dynamically. The exulu knowledge database contains
// all the knowledge base items, while the mastra database contains the
// chat history and user sessions.
export async function postgresClient(): Promise<{
    db: KnexType
}> {
    if (!db["exulu"]) {
        const knex = Knex({
            client: 'pg',
            connection: {
                host: process.env.POSTGRES_DB_HOST,
                port: parseInt(process.env.POSTGRES_DB_PORT || '5432'),
                user: process.env.POSTGRES_DB_USER,
                database: "exulu",
                password: process.env.POSTGRES_DB_PASSWORD,
                ssl: process.env.POSTGRES_DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
              }
        });
        // @ts-ignore - createExtensionIfNotExists gets added by importing pgvector
        // but it's not typed so we must ignore this.
        await knex.schema.createExtensionIfNotExists('vector');
        db["exulu"] = knex
    }

    return {
        db: db["exulu"]
    };
}
