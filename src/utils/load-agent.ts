import type { Agent } from "@EXULU_TYPES/models/agent.ts";
import { postgresClient } from "../postgres/client.ts";
import { RBACResolver } from "src/graphql/resolvers/rbac-resolver.ts";

const loadAgentCache = new Map<
  string,
  {
    agent: Agent;
    expiresAt: Date;
  }
>();

export const loadAgents = async () => {
  const { db } = await postgresClient();
  const agents = await db.from("agents");
  for (const agent of agents) {
    const agentRbac = await RBACResolver(db, "agent", agent.id, agent.rights_mode || "private");
    agent.RBAC = agentRbac;
    loadAgentCache.set(agent.id, {
      agent: agent,
      expiresAt: new Date(Date.now() + 1000 * 60 * 1), // 1 minute
    });
  }
  return agents;
};

export const loadAgent = async (id: string): Promise<Agent> => {
  const cachedAgent = loadAgentCache.get(id);
  if (cachedAgent && cachedAgent.expiresAt > new Date()) {
    return cachedAgent.agent;
  }
  const { db } = await postgresClient();
  const agentInstance: Agent = await db
    .from("agents")
    .where({
      id,
    })
    .first();
  const agentRbac = await RBACResolver(
    db,
    "agent",
    agentInstance.id,
    agentInstance.rights_mode || "private",
  );
  agentInstance.RBAC = agentRbac;

  if (!agentInstance) {
    throw new Error("Agent instance not found.");
  }
  loadAgentCache.set(id, {
    agent: agentInstance,
    expiresAt: new Date(Date.now() + 1000 * 60 * 1), // 1 minute
  });
  return agentInstance;
};
