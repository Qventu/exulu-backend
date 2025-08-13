import type { ExuluTableDefinition } from "../registry/routes"

export const agentMessagesSchema: ExuluTableDefinition = {
    name: {
        plural: "agent_messages",
        singular: "agent_message"
    },
    fields: [
        {
            name: "content",
            type: "text"
        },
        {
            name: "title",
            type: "text"
        },
        {
            name: "session",
            type: "text",
        }
    ]
}

export const agentSessionsSchema: ExuluTableDefinition = {
    name: {
        plural: "agent_sessions",
        singular: "agent_session"
    },
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
            name: "title",
            type: "text"
        }
    ]
}

export const usersSchema: ExuluTableDefinition = {
    name: {
        plural: "users",
        singular: "user"
    },
    fields: [
        {
            name: "firstname",
            type: "text"
        },
        {
            name: "name",
            type: "text"
        },
        {
            name: "lastname",
            type: "text"
        },
        {
            name: "email",
            type: "text",
            index: true
        },
        {
            name: "temporary_token",
            type: "text"
        },
        {
            name: "type",
            type: "text",
            index: true
        },
        {
            name: "profile_image",
            type: "text"
        },
        {
            name: "super_admin",
            type: "boolean",
            default: false
        },
        {
            name: "status",
            type: "text"
        },
        {
            name: "emailVerified",
            type: "text"
        },
        {
            name: "apikey",
            type: "text"
        },
        {
            name: "last_used",
            type: "date"
        },
        {
            name: "anthropic_token",
            type: "text"
        },
        {
            name: "role",
            type: "uuid"
        }
    ]
}

export const rolesSchema: ExuluTableDefinition = {
    name: {
        plural: "roles",
        singular: "role"
    },
    fields: [
        {
            name: "name",
            type: "text"
        },
        {
            name: "is_admin",
            type: "boolean",
            default: false
        },
        {
            name: "agents",
            type: "json"
        }
    ]
}

export const statisticsSchema: ExuluTableDefinition = {
    name: {
        plural: "statistics",
        singular: "statistic"
    },
    fields: [
        {
            name: "name",
            type: "text"
        },
        {
            name: "label",
            type: "text"
        },
        {
            name: "type",
            type: "text"
        },
        {
            name: "total",
            type: "number"
        }
    ]
}

export const workflowSchema: ExuluTableDefinition = {
    name: {
        plural: "workflows",
        singular: "workflow"
    },
    fields: [
        {
            name: "workflow_name",
            type: "text"
        },
        {
            name: "run_id",
            type: "text"
        },
        {
            name: "snapshot",
            type: "text"
        }
    ]
}

export const evalResultsSchema: ExuluTableDefinition = {
    name: {
        plural: "eval_results",
        singular: "eval_result"
    },
    fields: [
        {
            name: "input",
            type: "longText"
        },
        {
            name: "output",
            type: "longText"
        },
        {
            name: "duration",
            type: "number"
        },
        {
            name: "category",
            type: "text"
        },
        {
            name: "metadata",
            type: "json"
        },
        {
            name: "result",
            type: "number"
        },
        {
            name: "agent_id",
            type: "uuid"
        },
        {
            name: "workflow_id",
            type: "uuid"
        },
        {
            name: "eval_type",
            type: "text"
        },
        {
            name: "eval_name",
            type: "text"
        },
        {
            name: "comment",
            type: "longText"
        }
    ]
}

export const jobsSchema: ExuluTableDefinition = {
    name: {
        plural: "jobs",
        singular: "job"
    },
    fields: [
        {
            name: "redis",
            type: "text"
        },
        {
            name: "session",
            type: "text"
        },
        {
            name: "status",
            type: "text"
        },
        {
            name: "type",
            type: "text"
        },
        {
            name: "result",
            type: "longText"
        },
        {
            name: "name",
            type: "text"
        },
        {
            name: "agent",
            type: "uuid"
        },
        {
            name: "workflow",
            type: "uuid"
        },
        {
            name: "user", // next auth stores users with id type SERIAL, so we need to use number
            type: "number"
        },
        {
            name: "item",
            type: "uuid"
        },
        {
            name: "steps",
            type: "number"
        },
        {
            name: "inputs",
            type: "json"
        },
        {
            name: "finished_at",
            type: "date"
        },
        {
            name: "duration",
            type: "number"
        }
    ]
}

export const agentsSchema: ExuluTableDefinition = {
    name: {
        plural: "agents",
        singular: "agent"
    },
    fields: [
        {
            name: "name",
            type: "text"
        },
        {
            name: "description",
            type: "text"
        },
        {
            name: "providerApiKey",
            type: "text"
        },
        {
            name: "extensions",
            type: "json"
        },
        {
            name: "backend",
            type: "text"
        },
        {
            name: "type",
            type: "text"
        },
        {
            name: "active",
            type: "boolean",
            default: false
        },
        {
            name: "public",
            type: "boolean",
            default: false
        },
        {
            name: "tools",
            type: "json"
        }
    ]
}

export const variablesSchema: ExuluTableDefinition = {
    name: {
        plural: "variables",
        singular: "variable"
    },
    fields: [
        {
            name: "name",
            type: "text",
            index: true,
            unique: true
        },
        {
            name: "value",
            type: "longText"
        },
        {
            name: "encrypted",
            type: "boolean",
            default: false
        }
    ]
}