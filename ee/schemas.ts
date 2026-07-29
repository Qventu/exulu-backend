// Ee edition specific schemas

import { STATISTICS_TYPE_ENUM } from "@EXULU_TYPES/enums/statistics";
import type { ExuluTableDefinition } from "@EXULU_TYPES/exulu-table-definition";

export const feedbackSchema: ExuluTableDefinition = {
    type: "feedback",
    name: {
        plural: "feedback",
        singular: "feedback",
    },
    fields: [
        {
            name: "description",
            type: "text",
        },
        {
            name: "status",
            type: "enum",
            enumValues: ["open", "solved"],
        },
        {
            name: "agent",
            type: "uuid",
        },
        {
            name: "session", // the agent session the feedback refers to
            type: "uuid",
        },
        {
            name: "score",
            type: "number", // can be any value but usually 0 for negative and 1 for positive
        },
        {
            name: "user",
            type: "number",
        }
    ]
}

export const rolesSchema: ExuluTableDefinition = {
    type: "roles",
    name: {
        plural: "roles",
        singular: "role",
    },
    fields: [
        {
            name: "name",
            type: "text",
        },
        {
            name: "agents",
            type: "text", // write | read access to agents
        },
        {
            name: "api",
            type: "text",
        },
        {
            name: "workflows",
            type: "text", // write | read access to workflows
        },
        {
            name: "variables",
            type: "text", // write | read access to variables
        },
        {
            name: "users",
            type: "text", // write | read access to users
        },
        {
            name: "evals",
            type: "text", // write | read access to evals
        },
        {
            name: "budget_management",
            type: "text", // write | read access to budgets
        },
    ],
};

export const teamsSchema: ExuluTableDefinition = {
    type: "teams",
    name: {
        plural: "teams",
        singular: "team",
    },
    fields: [
        {
            name: "name",
            type: "text",
            index: true,
            unique: true,
            required: true,
        },
        {
            name: "description",
            type: "text",
        },
    ],
};

export const statisticsSchema: ExuluTableDefinition = {
    type: "tracking",
    name: {
        plural: "tracking",
        singular: "tracking",
    },
    fields: [
        {
            name: "name",
            type: "text",
        },
        {
            name: "label",
            type: "text",
        },
        {
            name: "type",
            type: "enum",
            enumValues: Object.values(STATISTICS_TYPE_ENUM),
        },
        {
            name: "total",
            type: "number",
        },
        {
            name: "user",
            type: "number",
        },
        {
            name: "role",
            type: "uuid",
        },
        {
            name: "project",
            type: "uuid",
        },
    ],
};

export const testCasesSchema: ExuluTableDefinition = {
    type: "test_cases",
    name: {
        plural: "test_cases",
        singular: "test_case",
    },
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
            name: "inputs",
            type: "json",
            required: true,
        },
        {
            name: "expected_output",
            type: "longText",
            required: true,
        },
        {
            name: "expected_tools",
            type: "json",
        },
        {
            name: "expected_knowledge_sources",
            type: "json",
        },
        {
            name: "expected_agent_tools",
            type: "json",
        },
        {
            name: "eval_set_id",
            type: "uuid",
        },
    ],
};

export const evalSetsSchema: ExuluTableDefinition = {
    type: "eval_sets",
    name: {
        plural: "eval_sets",
        singular: "eval_set",
    },
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
    ],
};

export const jobResultsSchema: ExuluTableDefinition = {
    type: "job_results",
    name: {
        plural: "job_results",
        singular: "job_result",
    },
    fields: [
        {
            name: "job_id",
            type: "text",
        },
        {
            name: "state",
            type: "text",
        },
        {
            name: "error",
            type: "json",
        },
        {
            name: "label",
            type: "text",
            index: true,
        },
        {
            name: "tries",
            type: "number",
            default: 0,
        },
        {
            name: "result",
            type: "json",
        },
        {
            name: "metadata",
            type: "json",
        },
        // Knowledge V2 (KB-7): per-item pipeline tracking. Written at ENQUEUE
        // time (state "waiting") by the queue decorator so the item page can
        // detect waiting jobs — not only worker-started ones. `type` is the
        // job kind (processor/embedder/...); item + context indexed for the
        // item-page query.
        {
            name: "item",
            type: "text",
            index: true,
        },
        {
            name: "context",
            type: "text",
            index: true,
        },
        {
            name: "type",
            type: "text",
        },
        // Email-triggered routines (spec 2026-07-15 §3.3): run provenance +
        // session cross-link. `workflow` replaces label-substring filtering
        // (indexed via the composite index created in init-exulu-db.ts).
        // Pre-migration rows keep trigger = NULL (displayed as "—").
        {
            name: "trigger",
            type: "text",
        },
        {
            name: "trigger_metadata",
            type: "json",
        },
        {
            name: "session",
            type: "text",
        },
        {
            name: "workflow",
            type: "text",
        },
    ],
};

export const evalRunsSchema: ExuluTableDefinition = {
    type: "eval_runs",
    name: {
        plural: "eval_runs",
        singular: "eval_run",
    },
    RBAC: true,
    fields: [
        {
            name: "name",
            type: "text",
        },
        {
            name: "timeout_in_seconds",
            type: "number",
            default: 180,
        },
        {
            name: "eval_set_id",
            type: "uuid",
            required: true,
        },
        {
            name: "agent_id",
            type: "uuid",
            required: true,
        },
        {
            name: "eval_functions",
            type: "json",
            required: true,
        },
        {
            name: "config",
            type: "json",
        },
        {
            name: "scoring_method",
            type: "enum",
            enumValues: ["median", "sum", "average"],
            required: true,
        },
        {
            name: "pass_threshold",
            type: "number",
            required: true,
        },
        {
            name: "test_case_ids",
            type: "json",
            required: true,
        },
    ],
};

export const rbacSchema: ExuluTableDefinition = {
    type: "rbac",
    name: {
        plural: "rbac",
        singular: "rbac",
    },
    graphql: false,
    fields: [
        {
            name: "entity",
            type: "text",
            required: true,
        },
        {
            name: "access_type",
            type: "text",
            required: true,
        },
        {
            name: "target_resource_id",
            type: "uuid",
            required: true,
        },
        {
            name: "role_id",
            type: "uuid",
        },
        {
            name: "team_id",
            type: "uuid",
        },
        {
            name: "user_id",
            type: "number",
        },
        /* {
                name: "project_id",
                type: "uuid"
            }, */
        {
            name: "rights",
            type: "text",
            required: true,
        },
    ],
};


export const workflowTemplatesSchema: ExuluTableDefinition = {
    type: "workflow_templates",
    name: {
      plural: "workflow_templates",
      singular: "workflow_template",
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
        name: "agent",
        type: "uuid",
      },
      {
        name: "steps_json",
        type: "json",
        required: true,
      },
      // Escape hatch for the approval behavior change (spec §5.2): when true
      // the run keeps the legacy blanket tool pre-approval and never pauses.
      {
        name: "auto_approve_tools",
        type: "boolean",
        default: false,
      },
      {
        name: "queue",
        type: "text"
      }
    ],
  };

  // Email-triggered routines (spec §3.1): one inbound trigger per routine.
  // RBAC is false — access is checked via the parent workflow_templates row
  // (routine read for listing, routine write + workflows:write role for CRUD),
  // resolved explicitly in the custom GraphQL resolvers. graphql: false keeps
  // the auto-CRUD generator away from this table; the API surface is the
  // custom workflowTriggers / upsertWorkflowEmailTrigger / deleteWorkflowTrigger
  // resolvers only.
  export const workflowTriggersSchema: ExuluTableDefinition = {
      type: "workflow_triggers",
      name: {
        plural: "workflow_triggers",
        singular: "workflow_trigger",
      },
      RBAC: false,
      graphql: false,
      fields: [
        {
          name: "workflow",
          type: "uuid",
          required: true,
        },
        {
          // 'email' for now; extensible ('webhook' later).
          name: "type",
          type: "text",
          required: true,
        },
        {
          name: "enabled",
          type: "boolean",
          default: false,
        },
        // Secret capability URL key: base64url randomBytes(32). Both routes
        // and authorizes the webhook (POST /webhooks/routine/:secret).
        { name: "secret", type: "text", required: true, unique: true, index: true },
        // Optional per-trigger HMAC shared secret, AES-encrypted at rest.
        { name: "signing_secret", type: "text" },
        // Stamped on every verified webhook hit; per-trigger setup aid.
        { name: "last_fired_at", type: "date" },
        {
          // allowed_senders / filters / filtered_run_retention /
          // rate_limit_per_hour / sender_rate_limit_per_hour (spec §3.1).
          name: "config",
          type: "json",
          required: true,
        },
        {
          // Captured from the admin who saves the trigger; email runs execute
          // under this identity (same principle as cron).
          name: "run_as_user",
          type: "number",
        },
        {
          name: "run_as_role",
          type: "uuid",
        },
        {
          // RBAC:false means addCoreFields does not add created_by; add it
          // explicitly (audit trail, spec §3.1 core fields).
          name: "created_by",
          type: "number",
        },
      ],
    };
