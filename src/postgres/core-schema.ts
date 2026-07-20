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
  workflowTemplatesSchema,
  workflowTriggersSchema
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
      name: "sandbox_enabled",
      type: "boolean",
      default: false,
    },
    {
      // Per-turn budget for ALL tool steps on one chat message (bash, files,
      // knowledge search, integrations). 0/null = platform default
      // (DEFAULT_MAX_STEPS in resolve-max-steps.ts). Auto-ALTERed on boot.
      name: "max_tool_steps",
      type: "number",
    },
    {
      name: "guest_access",
      type: "boolean",
      default: false,
    },
    {
      name: "guest_auth_mode",
      type: "text",
      default: "regular", // 'public' | 'password' | 'regular' (= login)
    },
    {
      // bcrypt hash (hashSharePassword); NEVER exposed via GraphQL/REST —
      // see sanitizeRequestedFields + createExuluContextsTypeDefs filtering.
      name: "guest_password_hash",
      type: "text",
      required: false,
      hidden: true,
    },
    {
      // S3 key of the custom login-page image shown on the public auth page.
      name: "guest_cover_image",
      type: "text",
      required: false,
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
      // Knowledge V2 (KB-1): favourited knowledge sources + items. JSON arrays
      // of ids, mirroring favourite_projects. Auto-added to existing DBs by
      // the init-exulu-db column sync. Read via userById, written via
      // usersUpdateOne.
      name: "favourite_contexts",
      type: "json",
    },
    {
      name: "favourite_items",
      type: "json",
    },
    {
      // Knowledge: per-user "recently viewed" data items. Ordered JSON array
      // of global item ids ("<contextId>/<itemId>"), most-recent first, capped
      // client-side. Auto-added to existing DBs by the init-exulu-db column
      // sync; read via userById, written via usersUpdateOne (mirrors
      // favourite_items).
      name: "recently_viewed_items",
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
      hidden: true,
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
      hidden: true,
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
      hidden: true,
    },
    {
      name: "anthropic_token",
      type: "text",
      hidden: true,
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
    {
      // Optional attribution target for API keys (type "api"): tags requests
      // triggered by the key with project_id_ for LiteLLM cost attribution.
      name: "project",
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

const entityTypeSettingsSchema: ExuluTableDefinition = {
  type: "entity_type_settings",
  name: {
    plural: "entity_type_settings",
    singular: "entity_type_setting",
  },
  RBAC: false,
  fields: [
    {
      name: "context",
      type: "text", // id of the ExuluContext class
    },
    {
      name: "name",
      type: "text", // entity type name, e.g. "Person"
    },
    {
      name: "description",
      type: "text", // extraction guidance for this type
    },
    {
      name: "active",
      type: "boolean",
      default: true,
    },
    {
      // "active" = a configured type (used in extraction); "suggested" = a type
      // the extractor proposed (active:false) awaiting promotion on the UI.
      name: "status",
      type: "text",
      default: "active",
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
    // Recall.ai meeting-bot fields. source discriminates the pipeline: whisper
    // rows are driven by the polling loop, recall rows by webhooks.
    // Design doc: docs/superpowers/specs/2026-06-19-recall-meeting-recording-design.md
    { name: "source", type: "text", default: "whisper", index: true },
    { name: "meeting_url", type: "text" },
    { name: "recall_bot_id", type: "text", index: true },
    { name: "recall_recording_id", type: "text", index: true },
    { name: "recall_transcript_id", type: "text", index: true },
    { name: "bot_status", type: "text" },
    { name: "join_at", type: "date" },
    // Selected per-meeting post-processing: [{ prompt_id, agent_id }].
    { name: "post_processing_prompts", type: "json" },
    // Results: [{ prompt_id, agent_id, prompt_name, status, output, error, ran_at }].
    { name: "post_processing_outputs", type: "json" },
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

const oauthTokensSchema: ExuluTableDefinition = {
  type: "oauth_tokens",
  name: {
    plural: "oauth_tokens",
    singular: "oauth_token",
  },
  // Rows are only ever read/written by the oauth token store for the owning
  // (provider, user_id) pair — never exposed via GraphQL — so no RBAC fields.
  RBAC: false,
  fields: [
    { name: "provider", type: "text", required: false, index: true },
    { name: "tool_id", type: "text", required: true, index: true },
    { name: "user_id", type: "number", required: true, index: true },
    { name: "access_token", type: "longText", required: true }, // AES-encrypted
    { name: "refresh_token", type: "longText", required: false }, // AES-encrypted
    { name: "token_type", type: "text", required: false },
    { name: "scopes", type: "text", required: false },
    { name: "expires_at", type: "date", required: false }, // null = non-expiring
  ],
};

const sharedArtifactsSchema: ExuluTableDefinition = {
  type: "shared_artifacts",
  name: {
    plural: "shared_artifacts",
    singular: "shared_artifact",
  },
  // RBAC drives the "regular" auth_mode: rights_mode + the rbac table scope
  // who may view. public/password modes ignore rights_mode.
  RBAC: true,
  fields: [
    { name: "name", type: "text", index: true, unique: true, required: true },
    { name: "s3key", type: "text", required: true },
    { name: "auth_mode", type: "text", default: "regular" },
    { name: "password_hash", type: "text", required: false, hidden: true }, // bcrypt; password mode only
    { name: "expires_at", type: "date", required: false }, // null = no expiry
    { name: "content_type", type: "text", required: false },
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
      entityTypeSettingsSchema: (): ExuluTableDefinition => addCoreFields(entityTypeSettingsSchema),
      promptFavoritesSchema: (): ExuluTableDefinition => addCoreFields(promptFavoritesSchema),
      contextPresetsSchema: (): ExuluTableDefinition => addCoreFields(contextPresetsSchema),
      oauthTokensSchema: (): ExuluTableDefinition => addCoreFields(oauthTokensSchema),
      sharedArtifactsSchema: (): ExuluTableDefinition => addCoreFields(sharedArtifactsSchema),
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
      schemas.workflowTriggersSchema = (): ExuluTableDefinition => addCoreFields(workflowTriggersSchema)
    }
    
    if (license["queues"]) {
      schemas.jobResultsSchema = (): ExuluTableDefinition => addCoreFields(jobResultsSchema)
    }

    return schemas;
  },
};
