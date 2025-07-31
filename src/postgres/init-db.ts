import type { Knex } from "knex";
import { postgresClient } from "./client";
import { agentsSchema, evalResultsSchema, jobsSchema, rolesSchema, statisticsSchema, usersSchema, agentSessionsSchema, agentMessagesSchema } from "./core-schema";
import { mapType } from "../registry/utils/map-types";
import { sanitizeName } from "../registry/utils/sanitize-name";
import { encryptString, generateApiKey } from "../auth/generate-key";

const up = async function (knex: Knex) {

    if (!await knex.schema.hasTable('agent_sessions')) {
        await knex.schema.createTable('agent_sessions', table => {
            table.uuid("id").primary().defaultTo(knex.fn.uuid());
            table.timestamp('createdAt').defaultTo(knex.fn.now());
            table.timestamp('updatedAt').defaultTo(knex.fn.now());
            for (const field of agentSessionsSchema.fields) {
                const { type, name, default: defaultValue } = field;
                if (!type || !name) {
                    continue;
                }
                mapType(table, type, sanitizeName(name), defaultValue);
            }
        });
    }

    if (!await knex.schema.hasTable('agent_messages')) {
        await knex.schema.createTable('agent_messages', table => {
            table.uuid("id").primary().defaultTo(knex.fn.uuid());
            table.timestamp('createdAt').defaultTo(knex.fn.now());
            table.timestamp('updatedAt').defaultTo(knex.fn.now());
            for (const field of agentMessagesSchema.fields) {
                const { type, name, default: defaultValue } = field;
                if (!type || !name) {
                    continue;
                }
                mapType(table, type, sanitizeName(name), defaultValue);
            }
        });
    }

    if (!await knex.schema.hasTable('roles')) {
        await knex.schema.createTable('roles', table => {
            table.uuid("id").primary().defaultTo(knex.fn.uuid());
            table.timestamp('createdAt').defaultTo(knex.fn.now());
            table.timestamp('updatedAt').defaultTo(knex.fn.now());
            for (const field of rolesSchema.fields) {
                const { type, name, default: defaultValue } = field;
                if (!type || !name) {
                    continue;
                }
                mapType(table, type, sanitizeName(name), defaultValue);
            }
        });
    }

    if (!await knex.schema.hasTable('eval_results')) {
        await knex.schema.createTable('eval_results', table => {
            table.uuid("id").primary().defaultTo(knex.fn.uuid());
            table.timestamp('createdAt').defaultTo(knex.fn.now());
            table.timestamp('updatedAt').defaultTo(knex.fn.now());
            for (const field of evalResultsSchema.fields) {
                const { type, name, default: defaultValue } = field;
                if (!type || !name) {
                    continue;
                }
                mapType(table, type, sanitizeName(name), defaultValue);
            }
        });
    }

    if (!await knex.schema.hasTable('statistics')) {
        await knex.schema.createTable('statistics', table => {
            table.uuid("id").primary().defaultTo(knex.fn.uuid());
            table.timestamp('createdAt').defaultTo(knex.fn.now());
            table.timestamp('updatedAt').defaultTo(knex.fn.now());
            for (const field of statisticsSchema.fields) {
                const { type, name, default: defaultValue } = field;
                if (!type || !name) {
                    continue;
                }
                mapType(table, type, sanitizeName(name), defaultValue);
            }
        });
    }

    if (!await knex.schema.hasTable('jobs')) {
        await knex.schema.createTable('jobs', table => {
            table.uuid("id").primary().defaultTo(knex.fn.uuid());
            table.timestamp('createdAt').defaultTo(knex.fn.now());
            table.timestamp('updatedAt').defaultTo(knex.fn.now());
            for (const field of jobsSchema.fields) {
                const { type, name, default: defaultValue } = field;
                if (!type || !name) {
                    continue;
                }
                mapType(table, type, sanitizeName(name), defaultValue);
            }
        });
    }

    if (!await knex.schema.hasTable('agents')) {
        await knex.schema.createTable('agents', table => {
            table.uuid("id").primary().defaultTo(knex.fn.uuid());
            table.timestamp('createdAt').defaultTo(knex.fn.now());
            table.timestamp('updatedAt').defaultTo(knex.fn.now());
            for (const field of agentsSchema.fields) {
                const { type, name, default: defaultValue } = field;
                if (!type || !name) {
                    continue;
                }
                mapType(table, type, sanitizeName(name), defaultValue);
            }
        });
    }

    // Next auth tables
    if (!await knex.schema.hasTable('verification_token')) {
        await knex.schema.createTable('verification_token', table => {
            table.text('identifier').notNullable();
            table.timestamp('expires', { useTz: true }).notNullable();
            table.text('token').notNullable();
            table.primary(['identifier', 'token']);
        });
    }

    if (!await knex.schema.hasTable('users')) {
        await knex.schema.createTable('users', table => {
            table.increments('id').primary(); // next auth stores users with id type SERIAL, so we need to use number
            table.timestamp('createdAt').defaultTo(knex.fn.now());
            table.timestamp('updatedAt').defaultTo(knex.fn.now());
            table.string('name', 255);
            table.string('password', 255);
            table.string('email', 255);
            table.timestamp('emailVerified', { useTz: true });
            table.text('image');

            for (const field of usersSchema.fields) {
                console.log("[EXULU] field", field)
                const { type, name, default: defaultValue } = field;
                if (
                    name === "id" ||
                    name === "name" ||
                    name === "email" ||
                    name === "emailVerified" ||
                    name === "image"
                ) {
                    continue;
                }

                if (!type || !name) {
                    continue;
                }
                mapType(table, type, sanitizeName(name), defaultValue);
            }
        });
    }

    if (!await knex.schema.hasTable('accounts')) {
        await knex.schema.createTable('accounts', table => {
            table.increments('id').primary(); // next auth stores users with id type SERIAL, so we need to use number
            table.integer('userId').notNullable();
            table.string('type', 255).notNullable();
            table.string('provider', 255).notNullable();
            table.string('providerAccountId', 255).notNullable();
            table.text('refresh_token');
            table.text('access_token');
            table.bigInteger('expires_at');
            table.text('id_token');
            table.text('scope');
            table.text('session_state');
            table.text('token_type');
        });
    }

   /*  if (!await knex.schema.hasTable('sessions')) {
        await knex.schema.createTable('sessions', table => {
            table.increments('id').primary();
            table.integer('userId').notNullable();
            table.timestamp('expires', { useTz: true }).notNullable();
            table.string('sessionToken', 255).notNullable();
        });
    } */
};

export const execute = async () => {
    console.log("[EXULU] Initializing Exulu IMP database.")
    const { db } = await postgresClient()

    await up(db)

    console.log("[EXULU] Inserting default user and admin role.")
    const existingRole = await db.from("roles").where({ name: "admin" }).first();
    let roleId;

    if (!existingRole) {
        console.log("[EXULU] Creating default admin role.");
        const role = await db.from("roles").insert({
            name: "admin",
            is_admin: true,
            agents: JSON.stringify([])
        }).returning("id");
        roleId = role[0].id;
    } else {
        roleId = existingRole.id;
    }

    const existingUser = await db.from("users").where({ email: "admin@exulu.com" }).first();
    if (!existingUser) {
        const password = await encryptString("admin")
        console.log("[EXULU] Creating default admin user.");
        await db.from("users").insert({
            name: "exulu",
            email: "admin@exulu.com",
            super_admin: true,
            createdAt: new Date(),
            emailVerified: new Date(),
            updatedAt: new Date(),
            password: password,
            type: "user",
            role: roleId
        });
    }

    const { key } = await generateApiKey("exulu", "api@exulu.com")
    console.log("[EXULU] Database initialized.")
    console.log("[EXULU] Default api key: ", `${key}`)
    console.log("[EXULU] Default password if using password auth: ", `admin`)
    console.log("[EXULU] Default email if using password auth: ", `admin@exulu.com`)
    return;
}