import type { ExuluTableDefinition } from "../registry/routes"

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
            name: "role",
            type: "reference",
            references: {
                table: "roles",
                field: "id",
                onDelete: "CASCADE"
            }
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
        },
        {
            name: "timeseries",
            type: "json"
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
            type: "text"
        },
        {
            name: "workflow_id",
            type: "text"
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


export const threadsSchema: ExuluTableDefinition = {
    name: {
        plural: "threads",
        singular: "thread"
    },
    fields: [
        {
            name: "resourceId",
            type: "text"
        },
        {
            name: "title",
            type: "text"
        },
        {
            name: "metadata",
            type: "text"
        }
    ]
}

export const messagesSchema: ExuluTableDefinition = {
    name: {
        plural: "messages",
        singular: "message"
    },
    fields: [        
        {
            name: "thread_id",
            type: "text"
        },
        {
            name: "content",
            type: "text"
        },
        {
            name: "role",
            type: "text"
        },
        {
            name: "type",
            type: "text"
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
            type: "text"
        },
        {
            name: "workflow",
            type: "text"
        },
        {
            name: "user",
            type: "text"
        },
        {
            name: "item",
            type: "text"
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