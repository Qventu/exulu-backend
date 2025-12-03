import type { Agent } from "@EXULU_TYPES/models/agent.ts";
import type { BullMqJobData } from "./decoraters/bullmq.ts";
import type { ExuluAgent, ExuluTool } from "./classes.ts";
import { postgresClient } from "../postgres/client.ts";
import { RBACResolver } from "./utils/graphql.ts";
import { rateLimiter } from "./rate-limiter.ts";
import type { User } from "@EXULU_TYPES/models/user.ts";

export const bullmq = {
    validate: (id: string | undefined, data: BullMqJobData): void => {
        if (!data) {
            throw new Error(`Missing job data for job ${id}.`)
        }

        if (!data.type) {
            throw new Error(`Missing property "type" in data for job ${id}.`)
        }

        if (!data.inputs) {
            throw new Error(`Missing property "inputs" in data for job ${id}.`)
        }

        if (data.type !== "embedder" && data.type !== "workflow" && data.type !== "processor" && data.type !== "eval_run" && data.type !== "eval_function" && data.type !== "source") {
            throw new Error(`Property "type" in data for job ${id} must be of value "embedder", "workflow", "processor", "eval_run", "eval_function" or "source".`)
        }

        if (!data.workflow && !data.embedder && !data.processor && !data.eval_run_id && !data.eval_functions?.length && !data.source) {
            throw new Error(`Either a workflow, embedder, processor, eval_run, eval_functions or source must be set for job ${id}.`)
        }
    }
}


export const getEnabledTools = async (
    agentInstance: Agent,
    allExuluTools: ExuluTool[],
    disabledTools: string[] = [],
    agents: ExuluAgent[],
    user?: User
) => {
    let enabledTools: ExuluTool[] = [];
    if (agentInstance.tools) {
        const results = await Promise.all(agentInstance.tools.map(
            async ({ config, id, type }) => {
                let hydrated: ExuluTool | null | undefined;
                if (
                    type === "agent"
                ) {
                    if (id === agentInstance.id) {
                        return null;
                    }
                    // The target agent instance, not the agentInstance that is calling the tool
                    const instance = await loadAgent(id) // for agents used as tools, the tool id === the agent id
                    if (!instance) {
                        throw new Error("Trying to load a tool of type 'agent', but the associated agent with id " + id + " was not found in the database.")
                    }
                    const backend = agents.find(a => a.id === instance.backend)
                    if (!backend) {
                        throw new Error("Trying to load a tool of type 'agent', but the associated agent with id " + id + " does not have a backend set for it.")
                    }
                    
                    // if no access do not return it
                    const hasAccessToAgent = await checkRecordAccess(instance, "read", user);

                    if (!hasAccessToAgent) {
                        return null;
                    }

                    hydrated = await backend.tool(instance.id, agents)
                } else {
                    hydrated = allExuluTools.find(t => t.id === id)
                }
                return hydrated
            }
        ))
        enabledTools = results.filter(Boolean) as ExuluTool[]
    }

    console.log("[EXULU] available tools", enabledTools?.length)

    // Message specific tools, the user can overwrite to disable specific tools
    // for individual messages.
    console.log("[EXULU] disabled tools", disabledTools?.length)
    enabledTools = enabledTools.filter(tool => !disabledTools.includes(tool.id));
    return enabledTools;
}

const loadAgentCache = new Map<string, {
    agent: Agent,
    expiresAt: Date
}>();

export const loadAgents = async () => {
    const { db } = await postgresClient();
    const agents = await db.from("agents");
    for (const agent of agents) {
        const agentRbac = await RBACResolver(db, "agent", agent.id, agent.rights_mode || "private");
        agent.RBAC = agentRbac;
        loadAgentCache.set(agent.id, {
            agent: agent,
            expiresAt: new Date(Date.now() + 1000 * 60 * 1) // 1 minute
        });
    }
    return agents;
}

export const loadAgent = async (id: string) => {
    const cachedAgent = loadAgentCache.get(id);
    if (cachedAgent && cachedAgent.expiresAt > new Date()) {
        return cachedAgent.agent;
    }
    const { db } = await postgresClient();
    const agentInstance: Agent = await db.from("agents").where({
        id
    }).first();
    const agentRbac = await RBACResolver(db, "agent", agentInstance.id, agentInstance.rights_mode || "private");
    agentInstance.RBAC = agentRbac;

    if (!agentInstance) {
        throw new Error("Agent instance not found.");
    }
    loadAgentCache.set(id, {
        agent: agentInstance,
        expiresAt: new Date(Date.now() + 1000 * 60 * 1) // 1 minute
    });
    return agentInstance;
}

export const checkAgentRateLimit = async (agent: ExuluAgent) => {
    if (agent.rateLimit) {
        console.log("[EXULU] rate limiting agent.", agent.rateLimit)
        const limit = await rateLimiter(
            agent.rateLimit.name || agent.id,
            agent.rateLimit.rate_limit.time,
            agent.rateLimit.rate_limit.limit,
            1
        )

        if (!limit.status) {
            throw new Error("Rate limit exceeded.");
        }
    }
}

// todo potentially remove memory caches and use redis instead, so we can scale better and potentially flush caches when agents or records are updated
const checkRecordAccessCache = new Map<string, {
    hasAccess: boolean,
    expiresAt: Date
}>();

export const checkRecordAccess = async (record: any & {
    rights_mode: 'private' | 'users' | 'roles' | 'public'/*  | 'projects' */,
    created_by: string,
    RBAC: {
        users: { id: number, rights: string }[],
        roles: { id: string, rights: string }[],
        /* projects: { id: string, rights: string }[] */
    }
}, request: "read" | "write", user?: User,): Promise<boolean> => {

    const setRecordAccessCache = (hasAccess: boolean) => {
        checkRecordAccessCache.set(`${record.id}-${request}-${user?.id}`, {
            hasAccess: hasAccess,
            expiresAt: new Date(Date.now() + 1000 * 60 * 1) // 1 minute
        });
    }

    const cachedAccess = checkRecordAccessCache.get(`${record.id}-${request}-${user?.id}`);
    if (cachedAccess && cachedAccess.expiresAt > new Date()) {
        return cachedAccess.hasAccess;
    }
    // Check access rights
    const isPublic = record.rights_mode === "public";
    const byUsers = record.rights_mode === "users";
    const byRoles = record.rights_mode === "roles";
    const isCreator = user ? record.created_by === user.id.toString() : false;
    const isAdmin = user ? user.super_admin : false;
    const isApi = user ? user.type === "api" : false;

    let hasAccess: "read" | "write" | "none" = "none";

    if (isPublic || isCreator || isAdmin || isApi) {
        setRecordAccessCache(true);
        return true;
    }

    if (byUsers) {
        if (!user) {
            setRecordAccessCache(false);
            return false;
        }
        console.log("record.RBAC?.users", record.RBAC?.users)
        console.log("user.id", user.id.toString())
        hasAccess = record.RBAC?.users?.find(x => x.id === user.id)?.rights as "read" | "write" | "none" || "none";
        if (!hasAccess || hasAccess === "none" || hasAccess !== request) {
            console.error(`Your current user ${user.id} does not have access to this record, current access type is: ${hasAccess}.`);
            setRecordAccessCache(false);
            return false;
        } else {
            setRecordAccessCache(true);
            return true;
        }
    }

    if (byRoles) {
        if (!user) {
            setRecordAccessCache(false);
            return false;
        }
        hasAccess = record.RBAC?.roles?.find(x => x.id === user.role?.id)?.rights as "read" | "write" | "none" || "none";
        if (!hasAccess || hasAccess === "none" || hasAccess !== request) {
            console.error(`Your current role ${user.role?.name} does not have access to this record, current access type is: ${hasAccess}.`);
            setRecordAccessCache(false);
            return false;
        } else {
            setRecordAccessCache(true);
            return true;
        }
    }
    // todo add projects
    setRecordAccessCache(false);
    return false;
}