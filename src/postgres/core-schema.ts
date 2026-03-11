import type { ExuluTableDefinition } from "@EXULU_TYPES/exulu-table-definition";
import {
  feedbackSchema,
  rolesSchema,
  statisticsSchema,
  testCasesSchema,
  evalSetsSchema,
  jobResultsSchema,
  evalRunsSchema,
  rbacSchema,
  workflowTemplatesSchema
} from "@EE/schemas"
import { checkLicense } from "@EE/entitlements";

const agentMessagesSchema: ExuluTableDefinition = {
  type: "agent_messages",
  name: {
    plural: "agent_messages",
    singular: "agent_message",
  },
  fields: [
    {
      name: "content",
      type: "text",
    },
    {
      name: "title",
      type: "text",
    },
    {
      name: "user",
      type: "number",
    },
    {
      name: "message_id",
      type: "text",
      index: true,
      unique: true,
    },
    {
      name: "session",
      type: "text",
    },
  ],
};

const agentSessionsSchema: ExuluTableDefinition = {
  type: "agent_sessions",
  name: {
    plural: "agent_sessions",
    singular: "agent_session",
  },
  RBAC: true,
  fields: [
    {
      name: "agent",
      type: "uuid",
    },
    {
      name: "user", // next auth stores users with id type SERIAL, so we need to use number
      type: "number",
    },
    {
      name: "role",
      type: "uuid",
    },
    {
      name: "session_items", // array of items as global ids ('<context_id>/<item_id>')
      type: "json",
    },
    {
      name: "title",
      type: "text",
    },
    {
      name: "project",
      type: "uuid",
      required: false,
    },
    {
      name: "metadata",
      type: "json",
    },
  ],
};

const variablesSchema: ExuluTableDefinition = {
  type: "variables",
  name: {
    plural: "variables",
    singular: "variable",
  },
  fields: [
    {
      name: "name",
      type: "text",
      index: true,
      unique: true,
    },
    {
      name: "value",
      type: "longText",
    },
    {
      name: "encrypted",
      type: "boolean",
      default: false,
    },
  ],
};

const projectsSchema: ExuluTableDefinition = {
  type: "projects",
  name: {
    plural: "projects",
    singular: "project",
  },
  RBAC: true,
  fields: [
    {
      name: "name",
      type: "text",
      required: true,
    },
    {
      name: "description",
      type: "text",
    },
    {
      name: "image",
      type: "text",
    },
    {
      name: "project_items", // array of items as global ids ('<context_id>/<item_id>')
      type: "json",
    },
    {
      name: "custom_instructions",
      type: "longText",
    },
  ],
};

const agentsSchema: ExuluTableDefinition = {
  type: "agents",
  name: {
    plural: "agents",
    singular: "agent",
  },
  RBAC: true,
  fields: [
    {
      name: "name",
      type: "text",
    },
    {
      name: "image",
      type: "text",
    },
    {
      name: "category",
      type: "text",
    },
    {
      name: "feedback",
      type: "boolean"
    },
    {
      name: "description",
      type: "text",
    },
    {
      name: "welcomemessage",
      type: "text",
    },
    {
      name: "instructions",
      type: "text",
    },
    {
      name: "memory",
      type: "text", // allows selecting a exulu context as native memory for the agent
    },
    {
      name: "providerapikey",
      type: "text",
    },
    {
      name: "provider",
      type: "text",
    },
    {
      name: "active",
      type: "boolean",
      default: false,
    },
    {
      name: "tools",
      type: "json",
    },
    {
      name: "animation_idle",
      type: "text",
    },
    {
      name: "animation_responding",
      type: "text",
    },
  ],
};

const usersSchema: ExuluTableDefinition = {
  type: "users",
  name: {
    plural: "users",
    singular: "user",
  },
  fields: [
    {
      name: "id",
      type: "number",
      index: true,
    },
    {
      name: "favourite_agents",
      type: "json",
    },
    {
      name: "favourite_projects",
      type: "json",
    },
    {
      name: "firstname",
      type: "text",
    },
    {
      name: "name",
      type: "text",
    },
    {
      name: "lastname",
      type: "text",
    },
    {
      name: "email",
      type: "text",
      index: true,
    },
    {
      name: "temporary_token",
      type: "text",
    },
    {
      name: "type",
      type: "text",
      index: true,
    },
    {
      name: "profile_image",
      type: "text",
    },
    {
      name: "super_admin",
      type: "boolean",
      default: false,
    },
    {
      name: "status",
      type: "text",
    },
    {
      name: "emailVerified",
      type: "text",
    },
    {
      name: "apikey",
      type: "text",
    },
    {
      name: "last_used",
      type: "date",
    },
    {
      name: "password",
      type: "text",
    },
    {
      name: "anthropic_token",
      type: "text",
    },
    {
      name: "role",
      type: "uuid",
    },
  ],
};

const platformConfigurationsSchema: ExuluTableDefinition = {
  type: "platform_configurations",
  name: {
    plural: "platform_configurations",
    singular: "platform_configuration",
  },
  fields: [
    {
      name: "config_key",
      type: "text",
      required: true,
      unique: true,
      index: true,
    },
    {
      name: "config_value",
      type: "json",
      required: true,
    },
    {
      name: "description",
      type: "text",
    },
  ],
};

const embedderSettingsSchema: ExuluTableDefinition = {
  type: "embedder_settings",
  name: {
    plural: "embedder_settings",
    singular: "embedder_setting",
  },
  RBAC: false,
  fields: [
    {
      name: "context",
      type: "text", // id of the ExuluContext class
    },
    {
      name: "embedder",
      type: "text", // id of the ExuluEmbedder class
    },
    {
      name: "name",
      type: "text",
    },
    {
      name: "value",
      type: "text", // reference to an exulu variable
    },
  ],
};

const promptLibrarySchema: ExuluTableDefinition = {
  type: "prompt_library",
  name: {
    plural: "prompt_library",
    singular: "prompt_library_item",
  },
  RBAC: true,
  fields: [
    {
      name: "name",
      type: "text",
      required: true,
    },
    {
      name: "description",
      type: "text",
    },
    {
      name: "content",
      type: "longText",
      required: true,
    },
    {
      name: "tags",
      type: "json",
    },
    {
      name: "usage_count",
      type: "number",
      default: 0,
    },
    {
      name: "favorite_count",
      type: "number",
      default: 0,
    },
    {
      name: "assigned_agents",
      type: "json",
    },
  ],
};

const promptFavoritesSchema: ExuluTableDefinition = {
  type: "prompt_favorites",
  name: {
    plural: "prompt_favorites",
    singular: "prompt_favorite",
  },
  fields: [
    {
      name: "user_id",
      type: "number",
      required: true,
      index: true,
    },
    {
      name: "prompt_id",
      type: "uuid",
      required: true,
      index: true,
    },
  ],
};

export const addCoreFields = (schema: ExuluTableDefinition): ExuluTableDefinition => {
  schema.fields.forEach((field) => {
    if (field.type === "file") {
      field.name = field.name + "_s3key";
    }
  });
  // todo only add these to items and chunks tables...
  schema.fields.push({
    name: "last_processed_at",
    type: "date",
  });
  schema.fields.push({
    name: "embeddings_updated_at",
    type: "date",
  });
  if (schema.RBAC) {
    if (!schema.fields.some((field) => field.name === "rights_mode")) {
      schema.fields.push({
        name: "rights_mode",
        type: "text",
        required: false,
        default: "private",
      });
    }
    if (!schema.fields.some((field) => field.name === "created_by")) {
      schema.fields.push({
        name: "created_by",
        type: "number",
        required: true,
        default: 0,
      });
    }
  }
  return schema;
};

export const coreSchemas = {
  get: () => {

    const license = checkLicense()

    const schemas: any = {
      agentsSchema: (): ExuluTableDefinition => addCoreFields(agentsSchema),
      agentMessagesSchema: (): ExuluTableDefinition => addCoreFields(agentMessagesSchema),
      agentSessionsSchema: (): ExuluTableDefinition => addCoreFields(agentSessionsSchema),
      projectsSchema: (): ExuluTableDefinition => addCoreFields(projectsSchema),
      usersSchema: (): ExuluTableDefinition => addCoreFields(usersSchema),
      statisticsSchema: (): ExuluTableDefinition => addCoreFields(statisticsSchema),
      variablesSchema: (): ExuluTableDefinition => addCoreFields(variablesSchema),
      platformConfigurationsSchema: (): ExuluTableDefinition => addCoreFields(platformConfigurationsSchema),
      promptLibrarySchema: (): ExuluTableDefinition => addCoreFields(promptLibrarySchema),
      embedderSettingsSchema: (): ExuluTableDefinition => addCoreFields(embedderSettingsSchema),
      promptFavoritesSchema: (): ExuluTableDefinition => addCoreFields(promptFavoritesSchema),
    }

    if (license["agent-feedback"]) {
      schemas.feedbackSchema = (): ExuluTableDefinition => addCoreFields(feedbackSchema)
    }
    
    if (license["rbac"]) {
      schemas.rolesSchema = (): ExuluTableDefinition => addCoreFields(rolesSchema)
      schemas.rbacSchema = (): ExuluTableDefinition => addCoreFields(rbacSchema)
    }

    if (license["evals"]) {
      schemas.testCasesSchema = (): ExuluTableDefinition => addCoreFields(testCasesSchema)
      schemas.evalSetsSchema = (): ExuluTableDefinition => addCoreFields(evalSetsSchema)
      schemas.evalRunsSchema = (): ExuluTableDefinition => addCoreFields(evalRunsSchema)
    }

    if (license["template-conversations"]) {
      schemas.workflowTemplatesSchema = (): ExuluTableDefinition => addCoreFields(workflowTemplatesSchema)
    }
    
    if (license["queues"]) {
      schemas.jobResultsSchema = (): ExuluTableDefinition => addCoreFields(jobResultsSchema)
    }

    return schemas;
  },
};
