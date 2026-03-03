import type { Knex } from "knex";
import { postgresClient } from "./client";
import { coreSchemas } from "./core-schema";
import { mapType } from "src/utils/map-types";
import { sanitizeName } from "src/utils/sanitize-name";
import { encryptString, generateApiKey } from "src/auth/generate-key";
import type { ExuluTableDefinition } from "@EXULU_TYPES/exulu-table-definition";
import type { ExuluContext } from "src/exulu/context";

const {
  agentsSchema,
  testCasesSchema,
  evalSetsSchema,
  evalRunsSchema,
  agentSessionsSchema,
  platformConfigurationsSchema,
  agentMessagesSchema,
  rolesSchema,
  usersSchema,
  statisticsSchema,
  variablesSchema,
  workflowTemplatesSchema,
  rbacSchema,
  projectsSchema,
  jobResultsSchema,
  promptLibrarySchema,
  embedderSettingsSchema,
  promptFavoritesSchema,
} = coreSchemas.get();

const addMissingFields = async (
  knex: Knex,
  tableName: string,
  fields: any[],
  skipFields: string[] = [],
) => {
  for (const field of fields) {
    const { type, name, default: defaultValue, unique } = field;
    if (!type || !name) {
      continue;
    }

    const sanitizedName = sanitizeName(name);

    if (skipFields.includes(name)) {
      continue;
    }

    const hasColumn = await knex.schema.hasColumn(tableName, sanitizedName);
    if (!hasColumn) {
      console.log(`[EXULU] Adding missing field '${sanitizedName}' to ${tableName} table.`);
      await knex.schema.alterTable(tableName, (table) => {
        mapType(table, type, sanitizedName, defaultValue, unique);
      });
    }
    console.log(`[EXULU] Field '${sanitizedName}' already exists in ${tableName} table.`);
  }
};

const up = async function (knex: Knex) {
  console.log("[EXULU] Database up.");

  const schemas = [
    agentSessionsSchema(),
    agentMessagesSchema(),
    rolesSchema(),
    testCasesSchema(),
    evalSetsSchema(),
    evalRunsSchema(),
    platformConfigurationsSchema(),
    statisticsSchema(),
    projectsSchema(),
    jobResultsSchema(),
    promptLibrarySchema(),
    embedderSettingsSchema(),
    promptFavoritesSchema(),
    rbacSchema(),
    agentsSchema(),
    variablesSchema(),
    workflowTemplatesSchema(),
  ];

  const createTable = async (schema: ExuluTableDefinition) => {
    if (!(await knex.schema.hasTable(schema.name.plural))) {
      console.log(`[EXULU] Creating ${schema.name.plural} table.`);
      await knex.schema.createTable(schema.name.plural, (table) => {
        table.uuid("id").primary().defaultTo(knex.fn.uuid());
        table.timestamp("createdAt").defaultTo(knex.fn.now());
        table.timestamp("updatedAt").defaultTo(knex.fn.now());

        for (const field of schema.fields) {
          const { type, name, default: defaultValue, unique } = field;
          if (!type || !name) {
            continue;
          }
          mapType(table, type, sanitizeName(name), defaultValue, unique);
        }
      });
    } else {
      console.log(`[EXULU] Checking missing fields to ${schema.name.plural} table.`);
      await addMissingFields(knex, schema.name.plural, schema.fields);
    }
  };
  for (const schema of schemas) {
    console.log(`[EXULU] Creating ${schema.name.plural} table.`, schema.fields);
    await createTable(schema);
  }

  // Next auth tables
  if (!(await knex.schema.hasTable("verification_token"))) {
    console.log("[EXULU] Creating verification_token table.");
    await knex.schema.createTable("verification_token", (table) => {
      table.text("identifier").notNullable();
      table.timestamp("expires", { useTz: true }).notNullable();
      table.text("token").notNullable();
      table.primary(["identifier", "token"]);
    });
  }

  if (!(await knex.schema.hasTable("users"))) {
    console.log("[EXULU] Creating users table.");
    await knex.schema.createTable("users", (table) => {
      table.increments("id").primary(); // next auth stores users with id type SERIAL, so we need to use number
      table.timestamp("createdAt").defaultTo(knex.fn.now());
      table.timestamp("updatedAt").defaultTo(knex.fn.now());
      table.string("name", 255);
      table.string("password", 255);
      table.string("email", 255);
      table.timestamp("emailVerified", { useTz: true });
      table.text("image");
      for (const field of usersSchema().fields) {
        console.log("[EXULU] field", field);
        const { type, name, default: defaultValue, unique } = field;
        if (
          name === "id" ||
          name === "name" ||
          name === "email" ||
          name === "emailVerified" ||
          name === "image" ||
          name === "password"
        ) {
          continue;
        }

        if (!type || !name) {
          continue;
        }
        mapType(table, type, sanitizeName(name), defaultValue, unique);
      }
    });
  } else {
    await addMissingFields(knex, "users", usersSchema().fields, [
      "id",
      "name",
      "email",
      "emailVerified",
      "image",
    ]);
  }

  if (!(await knex.schema.hasTable("accounts"))) {
    console.log("[EXULU] Creating accounts table.");
    await knex.schema.createTable("accounts", (table) => {
      table.increments("id").primary(); // next auth stores users with id type SERIAL, so we need to use number
      table.integer("userId").notNullable();
      table.string("type", 255).notNullable();
      table.string("provider", 255).notNullable();
      table.string("providerAccountId", 255).notNullable();
      table.text("refresh_token");
      table.text("access_token");
      table.bigInteger("expires_at");
      table.text("id_token");
      table.text("scope");
      table.text("session_state");
      table.text("token_type");
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

const contextDatabases = async (contexts: ExuluContext[]) => {
  for (const context of contexts) {
    const itemsTableExists = await context.tableExists();
    if (!itemsTableExists) {
      console.log("[EXULU] items table does not exist, creating it.");
      await context.createItemsTable();
    }
    const chunksTableExists = await context.chunksTableExists();
    if (!chunksTableExists && context.embedder) {
      console.log("[EXULU] chunks table does not exist, creating it.");
      await context.createChunksTable();
    }
  }
};

export const execute = async ({ contexts }: { contexts: ExuluContext[] }) => {
  const { db } = await postgresClient();
  console.log("[EXULU] Checking Exulu IMP database status.");
  await up(db);
  await contextDatabases(contexts);
  console.log("[EXULU] Inserting default user and admin role.");
  const existingAdminRole = await db.from("roles").where({ name: "admin" }).first();
  const existingDefaultRole = await db.from("roles").where({ name: "default" }).first();
  let adminRoleId;

  if (!existingAdminRole) {
    console.log("[EXULU] Creating admin role.");
    const role = await db
      .from("roles")
      .insert({
        name: "admin",
        agents: "write",
        api: "write",
        workflows: "write",
        variables: "write",
        users: "write",
        evals: "write",
      })
      .returning("id");
    adminRoleId = role[0].id;
  } else {
    adminRoleId = existingAdminRole.id;
  }

  if (!existingDefaultRole) {
    console.log("[EXULU] Creating default role.");
    await db
      .from("roles")
      .insert({
        name: "default",
        agents: "write",
        api: "read",
        workflows: "read",
        variables: "read",
        users: "read",
        evals: "read",
      })
      .returning("id");
  }

  const existingUser = await db.from("users").where({ email: "admin@exulu.com" }).first();
  if (!existingUser) {
    const password = await encryptString("admin");
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
      role: adminRoleId,
    });
  }

  const { key } = await generateApiKey("exulu", "api@exulu.com");
  console.log("[EXULU] Database initialized.");
  console.log("[EXULU] Default api key: ", `${key}`);
  console.log("[EXULU] Default password if using password auth: ", `admin`);
  console.log("[EXULU] Default email if using password auth: ", `admin@exulu.com`);
  return;
};
