import type { Knex } from "knex";
import { postgresClient } from "./client";
import { coreSchemas, userCredentialsSchema } from "./core-schema";
import { mapType } from "@SRC/utils/map-types";
import { sanitizeName } from "@SRC/utils/sanitize-name";
import { encryptString, generateApiKey } from "@SRC/auth/generate-key";
import type { ExuluTableDefinition } from "@EXULU_TYPES/exulu-table-definition";
import type { ExuluContext } from "@SRC/exulu/context";
import { ensureEntityTables } from "@SRC/exulu/entities";

const {
  agentsSchema,
  feedbackSchema,
  testCasesSchema,
  evalSetsSchema,
  evalRunsSchema,
  agentSessionsSchema,
  platformConfigurationsSchema,
  agentMessagesSchema,
  modelsSchema,
  rolesSchema,
  teamsSchema,
  usersSchema,
  skillsSchema,
  statisticsSchema,
  variablesSchema,
  workflowTemplatesSchema,
  workflowTriggersSchema,
  rbacSchema,
  projectsSchema,
  jobResultsSchema,
  promptLibrarySchema,
  contextPresetsSchema,
  entityTypeSettingsSchema,
  promptFavoritesSchema,
  transcriptionJobsSchema,
  imageGenerationsSchema,
  sharedArtifactsSchema,
  otpSendAttemptsSchema,
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

/**
 * user_credentials.data held CryptoJS-AES ciphertext (an opaque base64
 * string) in a jsonb column — Postgres rejects it, so no credential was
 * ever stored (spec 2026-07-22-tool-credentials-chat-ui §1.1). Column
 * becomes text. Idempotent: gated on information_schema reporting jsonb
 * (knex.schema.hasColumn cannot check types). The table is empty in every
 * environment (the bug made writes impossible), so USING data::text is
 * trivially safe.
 */
export const migrateUserCredentialsDataColumn = async (knex: Knex): Promise<void> => {
  const dataType = await knex.raw(
    `SELECT data_type FROM information_schema.columns
      WHERE table_name = 'user_credentials' AND column_name = 'data'`,
  );
  if (dataType.rows?.[0]?.data_type === "jsonb") {
    console.log("[EXULU] Migrating user_credentials.data jsonb -> text.");
    await knex.raw(
      "ALTER TABLE user_credentials ALTER COLUMN data TYPE text USING data::text",
    );
  }
};

export const migrateWorkflowTriggersToSecret = async (knex: Knex): Promise<void> => {
  const hasAddress = await knex.schema.hasColumn("workflow_triggers", "address");
  if (hasAddress) {
    // Unshipped feature: old rows carry Mailgun addresses that no longer route.
    // Clear them so addMissingFields can add the NOT NULL UNIQUE `secret` column.
    console.log("[EXULU] Migrating workflow_triggers address -> secret (clearing unshipped dev rows).");
    await knex("workflow_triggers").del();
    await knex.schema.alterTable("workflow_triggers", (t) => t.dropColumn("address"));
  }
  // Remove the retired platform-level inbound config (spec §3.2).
  await knex("platform_configurations").where({ config_key: "email_inbound" }).del();
};

const up = async function (knex: Knex) {
  console.log("[EXULU] Database up.");

  const schemas = [
    agentSessionsSchema(),
    agentMessagesSchema(),
    modelsSchema(),
    rolesSchema(),
    teamsSchema(),
    testCasesSchema(),
    evalSetsSchema(),
    evalRunsSchema(),
    platformConfigurationsSchema(),
    statisticsSchema(),
    projectsSchema(),
    jobResultsSchema(),
    promptLibrarySchema(),
    contextPresetsSchema(),
    entityTypeSettingsSchema(),
    promptFavoritesSchema(),
    transcriptionJobsSchema(),
    imageGenerationsSchema(),
    sharedArtifactsSchema(),
    rbacSchema(),
    agentsSchema(),
    feedbackSchema(),
    variablesSchema(),
    skillsSchema(),
    workflowTemplatesSchema(),
    workflowTriggersSchema(),
    otpSendAttemptsSchema(),
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

  // User credentials table replaces oauth_tokens. No backfill is required —
  // the feature had no production users. DROP IF EXISTS with CASCADE handles
  // dev installs that had the earlier oauth_tokens table.
  await knex.raw("DROP TABLE IF EXISTS oauth_tokens CASCADE;");
  await knex.raw(userCredentialsSchema());
  await migrateUserCredentialsDataColumn(knex);
  await migrateWorkflowTriggersToSecret(knex);

  // Email-trigger dedup (spec §4.4.5): Message-ID lookups per routine are
  // DB-backed so webhook retries, intake-job retries, and Redis restarts can
  // never double-fire a run. Gated on the columns existing so boot order
  // relative to the runs-engine migration (Plan 1) is safe; the index is
  // created on the first boot after both are present.
  if (
    (await knex.schema.hasColumn("job_results", "workflow")) &&
    (await knex.schema.hasColumn("job_results", "trigger_metadata"))
  ) {
    await knex.raw(
      "CREATE INDEX IF NOT EXISTS job_results_email_dedup_idx ON job_results (workflow, (trigger_metadata->>'message_id'))",
    );
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

  // Add the post_processing column to the existing transcriptions context
  // items table. Context tables are only created-if-absent (no add-missing
  // for existing context tables), so this targeted, idempotent migration backs
  // the Recall meeting-bot post-processing feature on already-provisioned DBs.
  // New installs get the column from the context field definition directly.
  // Design doc: docs/superpowers/specs/2026-06-19-recall-meeting-recording-design.md
  if (await knex.schema.hasTable("transcriptions_items")) {
    const hasPostProcessing = await knex.schema.hasColumn(
      "transcriptions_items",
      "post_processing",
    );
    if (!hasPostProcessing) {
      console.log(
        "[EXULU] Adding 'post_processing' column to transcriptions_items.",
      );
      await knex.schema.alterTable("transcriptions_items", (table) => {
        table.jsonb("post_processing");
      });
    }
  }

  // Email-triggered routines (spec 2026-07-15 §3.3): job_results gets an
  // explicit `workflow` column (added above by addMissingFields from
  // jobResultsSchema). One-time backfill parses the legacy label format
  // 'workflow-run-<workflow_template_id>' ('workflow-run-' = 13 chars) and
  // stamps type='workflow' so the runs API's type filter matches old rows.
  // Idempotent: the WHERE clause matches zero rows on every boot after the
  // first. `trigger` deliberately stays NULL for old rows (spec: don't guess).
  if (await knex.schema.hasColumn("job_results", "workflow")) {
    const backfilled = await knex.raw(
      `UPDATE job_results
          SET workflow = SUBSTRING(label FROM 14),
              type = COALESCE(type, 'workflow')
        WHERE label LIKE 'workflow-run-%'
          AND workflow IS NULL`,
    );
    if (backfilled?.rowCount) {
      console.log(
        `[EXULU] Backfilled job_results.workflow on ${backfilled.rowCount} rows from labels.`,
      );
    }
    // Runs views query by (workflow, state, trigger) ordered by createdAt.
    await knex.raw(
      `CREATE INDEX IF NOT EXISTS job_results_workflow_state_trigger_created_idx
          ON job_results (workflow, state, trigger, "createdAt")`,
    );
    // resumeRoutineRunIfWaiting queries by session on every chat turn;
    // the partial index keeps the common no-waiting-run case an index-only miss.
    await knex.raw(
      `CREATE INDEX IF NOT EXISTS job_results_session_waiting_idx
          ON job_results (session) WHERE state = 'waiting_approval'`,
    );
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
    // Create the entity-layer tables/columns for graph-enabled contexts.
    // No-op when the entity layer is disabled (no types declared/configured).
    await ensureEntityTables(context);
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
        budget_management: "write",
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

  const existingExternalRole = await db
    .from("roles")
    .where({ name: "external" })
    .first();
  if (!existingExternalRole) {
    console.log("[EXULU] Creating external role.");
    // All permission areas null: external (self-registered) users can chat
    // with guest-enabled agents but hold no platform rights.
    await db.from("roles").insert({ name: "external" }).returning("id");
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
