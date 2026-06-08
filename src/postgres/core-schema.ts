import type { ExuluTableDefinition } from "@EXULU_TYPES/exulu-table-definition";
import {
  feedbackSchema,
  rolesSchema,
  teamsSchema,
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
    {
      name: "model",
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
    {
      name: "currenttask",
      type: "text",
      required: false,
    },
    {
      // Hermes session id (e.g. "sess_…") for sessions run in advanced mode.
      // Maps this Exulu session onto its Hermes-side session/run; access stays
      // governed by this table's existing RBAC. Null for non-advanced sessions.
      name: "hermes_session_id",
      type: "text",
      required: false,
    },
  ],
};

const skillsSchema: ExuluTableDefinition = {
  type: "skills",
  name: {
    plural: "skills",
    singular: "skill",
  },
  RBAC: true,
  fields: [
    {
      name: "name",
      type: "text",
      index: true,
      unique: true,
    },
    {
      name: "description",
      type: "text",
    },
    {
      name: "s3folder",
      type: "text",
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
      name: "history",
      type: "json",
    },
    {
      name: "current_version",
      type: "number",
      default: 1,
    },
  ]
}

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
      name: "defaultagent",
      type: "boolean",
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
      name: "suggestions_enabled",
      type: "boolean",
      default: false,
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
      name: "model",
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
      name: "skills",
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
    {
      // Advanced (Hermes) agent mode toggle. When true and ENABLE_HERMES_AGENT
      // is set, requests route through the Hermes harness instead of the
      // default AI SDK → LiteLLM flow.
      name: "advanced_mode",
      type: "boolean",
      default: false,
    },
    {
      // 'shared' (default): one Hermes profile shared by all users of the
      // agent. 'private': one profile per agent/user. Distinct from RBAC
      // rights_mode, which still controls who can access the agent.
      name: "advanced_agent_profile_scope",
      type: "text",
    },
  ],
};

const modelsSchema: ExuluTableDefinition = {
  type: "models",
  name: {
    plural: "models",
    singular: "model",
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
      name: "provider",
      type: "text",
      required: true,
    },
    {
      name: "authvariable",
      type: "text",
    },
    {
      name: "active",
      type: "boolean",
      default: true,
    },
    {
      name: "requests_per_window",
      type: "number",
    },
    {
      name: "window_seconds",
      type: "number",
    },
    {
      name: "token_budget",
      type: "number",
    },
    {
      name: "cost_budget_usd",
      type: "number",
    },
    {
      name: "budget_window",
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
      name: "scope_mode",
      type: "text",
      default: "admin",
    },
    {
      name: "agent_ids",
      type: "json",
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
      name: "personal_system_prompt",
      type: "longText",
    },
    {
      name: "role",
      type: "uuid",
    },
    {
      name: "team",
      type: "uuid",
    },
  ],
};

const platformConfigurationsSchema: ExuluTableDefinition = {
  type: "platform_configurations",
  RBAC: true,
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
    {
      name: "history",
      type: "json",
    }
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

const transcriptionJobsSchema: ExuluTableDefinition = {
  type: "transcription_jobs",
  name: {
    plural: "transcription_jobs",
    singular: "transcription_job",
  },
  RBAC: true,
  fields: [
    { name: "audio", type: "file" },
    { name: "title", type: "text" },
    { name: "status", type: "text", index: true },
    { name: "whisper_job_id", type: "text" },
    { name: "raw_segments", type: "json" },
    { name: "speakers", type: "json" },
    { name: "language", type: "text" },
    { name: "duration_seconds", type: "number" },
    { name: "project_id", type: "uuid", required: false },
    { name: "target_rights_mode", type: "text", default: "private" },
    { name: "target_rbac_users", type: "json" },
    { name: "target_rbac_roles", type: "json" },
    { name: "saved_item_id", type: "uuid", required: false },
    { name: "error", type: "text" },
  ],
};

const imageGenerationsSchema: ExuluTableDefinition = {
  type: "image_generations",
  name: {
    plural: "image_generations",
    singular: "image_generation",
  },
  // Access is gated by the parent agent_sessions RBAC — rows have no
  // independent visibility, so no row-level RBAC fields are needed here.
  RBAC: false,
  fields: [
    { name: "session_id", type: "uuid", required: true, index: true },
    { name: "tool_call_id", type: "text", required: true, index: true },
    { name: "user_id", type: "number", required: true, index: true },
    { name: "operation", type: "text", required: true }, // 'generate' | 'edit'
    { name: "model", type: "text", required: true },
    { name: "prompt", type: "longText", required: true },
    { name: "applied_style_id", type: "uuid", required: false },
    { name: "applied_style_markdown", type: "longText", required: false },
    { name: "size", type: "text", required: false },
    { name: "quality", type: "text", required: false },
    { name: "n", type: "number", default: 1 },
    { name: "reference_image_keys", type: "json", required: false },
    { name: "mask_image_key", type: "text", required: false },
    { name: "image_keys", type: "json", required: true },
    { name: "revised_prompts", type: "json", required: false },
    { name: "selected", type: "boolean", default: false },
    { name: "error", type: "text", required: false },
  ],
};

const contextPresetsSchema: ExuluTableDefinition = {
  type: "context_presets",
  name: {
    plural: "context_presets",
    singular: "context_preset",
  },
  RBAC: true,
  fields: [
    {
      name: "name",
      type: "text",
      required: true,
      index: true,
    },
    {
      name: "description",
      type: "text",
    },
    {
      name: "preset_items",
      type: "json",
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
      modelsSchema: (): ExuluTableDefinition => addCoreFields(modelsSchema),
      projectsSchema: (): ExuluTableDefinition => addCoreFields(projectsSchema),
      usersSchema: (): ExuluTableDefinition => addCoreFields(usersSchema),
      skillsSchema: (): ExuluTableDefinition => addCoreFields(skillsSchema),
      statisticsSchema: (): ExuluTableDefinition => addCoreFields(statisticsSchema),
      variablesSchema: (): ExuluTableDefinition => addCoreFields(variablesSchema),
      platformConfigurationsSchema: (): ExuluTableDefinition => addCoreFields(platformConfigurationsSchema),
      promptLibrarySchema: (): ExuluTableDefinition => addCoreFields(promptLibrarySchema),
      embedderSettingsSchema: (): ExuluTableDefinition => addCoreFields(embedderSettingsSchema),
      promptFavoritesSchema: (): ExuluTableDefinition => addCoreFields(promptFavoritesSchema),
      contextPresetsSchema: (): ExuluTableDefinition => addCoreFields(contextPresetsSchema),
      transcriptionJobsSchema: (): ExuluTableDefinition => addCoreFields(transcriptionJobsSchema),
      imageGenerationsSchema: (): ExuluTableDefinition => addCoreFields(imageGenerationsSchema),
    }

    if (license["agent-feedback"]) {
      schemas.feedbackSchema = (): ExuluTableDefinition => addCoreFields(feedbackSchema)
    }
    
    if (license["rbac"]) {
      schemas.rolesSchema = (): ExuluTableDefinition => addCoreFields(rolesSchema)
      schemas.teamsSchema = (): ExuluTableDefinition => addCoreFields(teamsSchema)
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
