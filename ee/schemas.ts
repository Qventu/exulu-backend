// Ee edition specific schemas

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
            name: agentsSchema.name.plural,
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
            name: variablesSchema.name.plural,
            type: "text", // write | read access to variables
        },
        {
            name: usersSchema.name.plural,
            type: "text", // write | read access to users
        },
        {
            name: "evals",
            type: "text", // write | read access to evals
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
    ],
  };