import { STATISTICS_TYPE_ENUM } from "@EXULU_TYPES/enums/statistics"
import type { ExuluTableDefinition } from "../registry/routes"

const agentMessagesSchema: ExuluTableDefinition = {
    type: "agent_messages",
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
            name: "user",
            type: "number",
        },
        {
            name: "session",
            type: "text",
        }
    ]
}

const agentSessionsSchema: ExuluTableDefinition = {
    type: "agent_sessions",
    name: {
        plural: "agent_sessions",
        singular: "agent_session"
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
            type: "uuid"
        },
        {
            name: "title",
            type: "text"
        },
        {
            name: "project",
            type: "uuid"
        }
    ]
}


const variablesSchema: ExuluTableDefinition = {
    type: "variables",
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

const workflowTemplatesSchema: ExuluTableDefinition = {
    type: "workflow_templates",
    name: {
        plural: "workflow_templates",
        singular: "workflow_template"
    },
    RBAC: true,
    fields: [
        {
            name: "name",
            type: "text",
            required: true
        },
        {
            name: "description",
            type: "text"
        },
        {
            name: "owner",
            type: "number",
            required: true
        },
        {
            name: "visibility",
            type: "text",
            required: true
        },
        {
            name: "shared_user_ids",
            type: "json"
        },
        {
            name: "shared_role_ids",
            type: "json"
        },
        {
            name: "variables",
            type: "json"
        },
        {
            name: "steps_json",
            type: "json",
            required: true
        },
        {
            name: "example_metadata_json",
            type: "json"
        }
    ]
}

const projectsSchema: ExuluTableDefinition = {
    type: "projects",
    name: {
        plural: "projects",
        singular: "project"
    },
    RBAC: true,
    fields: [
        {
            name: "name",
            type: "text",
            required: true
        },
        {
            name: "description",
            type: "text"
        },
        {
            name: "image",
            type: "text"
        },
        {
            name: "custom_instructions",
            type: "longText"
        },
        {
            name: "context_files",
            type: "json"
        }
    ]
}

const agentsSchema: ExuluTableDefinition = {
    type: "agents",
    name: {
        plural: "agents",
        singular: "agent"
    },
    RBAC: true,
    fields: [
        {
            name: "name",
            type: "text"
        },
        {
            name: "image",
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
            name: "tools",
            type: "json"
        }
    ]
}

const usersSchema: ExuluTableDefinition = {
    type: "users",
    name: {
        plural: "users",
        singular: "user"
    },
    fields: [
        {
            name: "id",
            type: "number",
            index: true
        },
        {
            name: "favourite_agents",
            type: "json"
        },
        {
            name: "favourite_projects",
            type: "json"
        },
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
            name: "password",
            type: "text"
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

const rolesSchema: ExuluTableDefinition = {
    type: "roles",
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
            name: agentsSchema.name.plural,
            type: "text" // write | read access to agents
        },
        {
            name: "api",
            type: "text"
        },
        {
            name: "workflows",
            type: "text" // write | read access to workflows
        },
        {
            name: variablesSchema.name.plural,
            type: "text" // write | read access to variables
        },
        {
            name: usersSchema.name.plural,
            type: "text" // write | read access to users
        }
    ]
}

const statisticsSchema: ExuluTableDefinition = {
    type: "tracking",
    name: {
        plural: "tracking",
        singular: "tracking"
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
            type: "enum",
            enumValues: Object.values(STATISTICS_TYPE_ENUM)
        },
        {
            name: "total",
            type: "number"
        },
        {
            name: "user",
            type: "number"
        },
        {
            name: "role",
            type: "uuid"
        }
    ]
}

const evalResultsSchema: ExuluTableDefinition = {
    type: "eval_results",
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

const jobsSchema: ExuluTableDefinition = {
    type: "jobs",
    name: {
        plural: "jobs",
        singular: "job"
    },
    RBAC: true,
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

const rbacSchema: ExuluTableDefinition = {
    type: "rbac",
    name: {
        plural: "rbac",
        singular: "rbac"
    },
    graphql: false,
    fields: [
        {
            name: "entity",
            type: "text",
            required: true
        },
        {
            name: "access_type",
            type: "text",
            required: true
        },
        {
            name: "target_resource_id",
            type: "uuid",
            required: true
        },
        {
            name: "role_id",
            type: "uuid"
        },
        {
            name: "user_id",
            type: "number"
        },
        {
            name: "project_id",
            type: "uuid"
        },
        {
            name: "rights",
            type: "text",
            required: true
        }
    ]
}

export const addRBACfields = (schema: ExuluTableDefinition): ExuluTableDefinition => {
    if (schema.RBAC) {
        console.log(`[EXULU] Adding rights_mode field to ${schema.name.plural} table.`)
        schema.fields.push({
            name: "rights_mode",
            type: "text",
            required: false,
            default: "private"
        })
        schema.fields.push({
            name: "created_by",
            type: "number",
            required: true,
            default: 0
        })
    }
    return schema;
}

export const coreSchemas = {
    get: () => {
        return {
            agentsSchema: (): ExuluTableDefinition => addRBACfields(agentsSchema),
            agentMessagesSchema: (): ExuluTableDefinition => addRBACfields(agentMessagesSchema),
            agentSessionsSchema: (): ExuluTableDefinition => addRBACfields(agentSessionsSchema),
            projectsSchema: (): ExuluTableDefinition => addRBACfields(projectsSchema),
            usersSchema: (): ExuluTableDefinition => addRBACfields(usersSchema),
            rolesSchema: (): ExuluTableDefinition => addRBACfields(rolesSchema),
            statisticsSchema: (): ExuluTableDefinition => addRBACfields(statisticsSchema),
            evalResultsSchema: (): ExuluTableDefinition => addRBACfields(evalResultsSchema),
            jobsSchema: (): ExuluTableDefinition => addRBACfields(jobsSchema),
            variablesSchema: (): ExuluTableDefinition => addRBACfields(variablesSchema),
            rbacSchema: (): ExuluTableDefinition => addRBACfields(rbacSchema),
            workflowTemplatesSchema: (): ExuluTableDefinition => addRBACfields(workflowTemplatesSchema),
        }
    }
}


