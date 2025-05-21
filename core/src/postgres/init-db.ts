import type { Knex } from "knex";
import { postgresClient } from "./client";
import { agentsSchema, jobsSchema, rolesSchema, statisticsSchema, usersSchema } from "./core-schema";
import { mapType } from "../registry/utils/map-types";
import { sanitizeName } from "../registry/utils/sanitize-name";

const up = async function (knex: Knex) {
    if (!await knex.schema.hasTable('roles')) {
        await knex.schema.createTable('roles', table => {
            table.uuid("id").primary().defaultTo(knex.fn.uuid());
            table.date('createdAt').defaultTo(knex.fn.now());
            table.date('updatedAt').defaultTo(knex.fn.now());
            for (const field of rolesSchema.fields) {
                const { type, name, references, default: defaultValue } = field;
                if (!type || !name) {
                    continue;
                }
                if (type === "reference") {
                    if (!references) {
                        throw new Error("Field with type reference must have a reference definition.");
                    }
                    table.uuid(name).references(references.field).inTable(references.table);
                    return;
                }
                mapType(table, type, sanitizeName(name), defaultValue);
            }
        });
    }
   
    if (!await knex.schema.hasTable('statistics')) {
        await knex.schema.createTable('statistics', table => {
            table.uuid("id").primary().defaultTo(knex.fn.uuid());
            table.date('createdAt').defaultTo(knex.fn.now());
            table.date('updatedAt').defaultTo(knex.fn.now());
            for (const field of statisticsSchema.fields) {
            const { type, name, references, default: defaultValue } = field;
            if (!type || !name) {
                continue;
            }
            if (type === "reference") {
                if (!references) {
                    throw new Error("Field with type reference must have a reference definition.");
                }
                table.uuid(name).references(references.field).inTable(references.table);
                return;
            }
                mapType(table, type, sanitizeName(name), defaultValue);
            }
        });
    }

    if (!await knex.schema.hasTable('jobs')) {
    await knex.schema.createTable('jobs', table => {
        table.increments('id').primary();
        table.date('createdAt').defaultTo(knex.fn.now());
        table.date('updatedAt').defaultTo(knex.fn.now());
        for (const field of jobsSchema.fields) {
            const { type, name, references, default: defaultValue } = field;
            if (!type || !name) {
                continue;
            }
            if (type === "reference") {
                if (!references) {
                    throw new Error("Field with type reference must have a reference definition.");
                }
                table.uuid(name).references(references.field).inTable(references.table);
                return;
            }
            mapType(table, type, sanitizeName(name), defaultValue);
        }
        });
    }

    if (!await knex.schema.hasTable('agents')) {
        await knex.schema.createTable('agents', table => {
            table.increments('id').primary();
            table.date('createdAt').defaultTo(knex.fn.now());
            table.date('updatedAt').defaultTo(knex.fn.now());
            for (const field of agentsSchema.fields) {
            const { type, name, references, default: defaultValue } = field;
            if (!type || !name) {
                continue;
            }
            if (type === "reference") {
                if (!references) {
                    throw new Error("Field with type reference must have a reference definition.");
                }
                table.uuid(name).references(references.field).inTable(references.table);
                return;
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
            table.increments('id').primary();
            table.string('name', 255);
            table.string('password', 255);
            table.string('email', 255);
            table.timestamp('emailVerified', { useTz: true });
        table.text('image');

        for (const field of usersSchema.fields) {
            const { type, name, references, default: defaultValue } = field;
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
            if (type === "reference") {
                if (!references) {
                    throw new Error("Field with type reference must have a reference definition.");
                }
                table.uuid(name).references(references.field).inTable(references.table);
                return;
            }
            mapType(table, type, sanitizeName(name), defaultValue);
        }
        });
    }

    if (!await knex.schema.hasTable('accounts')) {
        await knex.schema.createTable('accounts', table => {
            table.increments('id').primary();
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

        // Optional: add foreign key constraint to users.id
        // table.foreign('userId').references('users.id').onDelete('CASCADE');
        });
    }

    if (!await knex.schema.hasTable('sessions')) {
        await knex.schema.createTable('sessions', table => {
            table.increments('id').primary();
            table.integer('userId').notNullable();
            table.timestamp('expires', { useTz: true }).notNullable();
            table.string('sessionToken', 255).notNullable();

        // Optional: add foreign key constraint to users.id
        // table.foreign('userId').references('users.id').onDelete('CASCADE');
        });
    }
};

export const execute = async () => {
    console.log("[EXULU] Initializing database.")
    const { db } = await postgresClient()

    await up(db)

    console.log("[EXULU] Inserting default user and admin role.")

    const role = await db.from("roles").insert({
        name: "admin",
        is_admin: true,
        agents: []
    }).returning("id");

    console.log("[EXULU] Inserting default admin user.")
    await db.from("users").insert({
        name: "exulu",
        email: "admin@exulu.com",
        super_admin: true,
        // password: "admin", todo add this again when we implement password auth / encryption as alternative to OTP
        role: role[0].id
    });

    console.log("[EXULU] Database initialized.")
    return;
}