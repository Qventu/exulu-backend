import type { ExuluTableDefinition } from "../registry/routes"

export const usersSchema: ExuluTableDefinition = {
    name: {
        plural: "users",
        singular: "user"
    },
    fields: [
        {
            name: "firstName",
            type: "text"
        },
        {
            name: "lastName",
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
            name: "apiKey",
            type: "text"
        },
        {
            name: "role",
            type: "reference",
            references: {
                table: "roles",
                field: "id",
                onDelete: "CASCADE"
            }
        },
        {
            name: "last_used",
            type: "date"
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
            type: "text"
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
            name: "user",
            type: "text"
        },
        {
            name: "item",
            type: "text"
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