import type { Knex } from "knex";
import type { Request } from "express";
import { createIdGenerator, type UIMessage } from "ai";
import type { ExuluAgent } from "@EXULU_TYPES/models/agent";
import type { User } from "@EXULU_TYPES/models/user";
import type { ExuluSkill } from "@EXULU_TYPES/skill";
import { getEnabledTools } from "@SRC/utils/enabled-tools";
import { getEnabledSkills } from "@SRC/utils/enabled-skills";
import { withGlossary } from "@SRC/utils/agent-glossary";
import type { ExuluConfig } from "../app";
import type { ExuluContext } from "../context";
import type { ExuluTool } from "../tool";
import { generateSync, saveChat } from "../generate-stream";
import { resolveModel } from "../resolve-model";
import { resolveContextWindow } from "../resolve-context-window";
import { markSessionAnswered, markSessionGenerating, markSessionIdle } from "../session-activity";
import { PUBLIC_SURFACE_HEADER } from "../public-surface";
import { stripCitations } from "./plain-text";

/**
 * A channel turn has no browser request. This header is what the public agent page's
 * proxy sets; isPublicSurface/treatAsGuest read only it, so the turn gets guest
 * treatment although a user is signed in. It can only remove privileges.
 */
const GUEST_TURN_REQUEST = { headers: { [PUBLIC_SURFACE_HEADER]: "1" } } as unknown as Request;

const newMessageId = createIdGenerator({ prefix: "msg_", size: 16 });

export interface AgentTurnContext {
  tools: ExuluTool[];
  contexts: ExuluContext[];
  config: ExuluConfig;
  getDb(): Promise<Knex>;
  loadAgent(id: string): Promise<ExuluAgent | undefined>;
}

/** The user as sign-in builds it (src/auth/auth.ts): row with role, team and project resolved. */
export const loadTurnUser = async (db: Knex, userId: number): Promise<User | undefined> => {
  const user = await db("users").where({ id: userId }).first();
  if (!user) return undefined;
  if (user.role) {
    const role = await db("roles").where({ id: user.role }).first();
    if (role) user.role = role;
  }
  if (user.team) {
    const team = await db("teams").where({ id: user.team }).first();
    if (team) user.team = team;
  }
  if (user.project) {
    const project = await db("projects").where({ id: user.project }).first();
    if (project) user.project = project;
  }
  return user;
};

/**
 * RunDeps.runAgentTurn. Follows the non-stream branch of the agent run route
 * (routes.ts, `generateSync`): agent, enabled skills and tools, model and context window,
 * glossary-extended instructions. That branch persists nothing, so the turn is saved
 * here the way the stream branch's onFinish does (saveChat + session activity marks),
 * which is what puts it in the user's history and gives the next turn its context.
 * The returned text has the inline citation markup removed (plain-text.ts).
 */
export const runChannelAgentTurn = async (
  p: { agentId: string; userId: number; sessionId: string; text: string },
  ctx: AgentTurnContext,
): Promise<string> => {
  const db = await ctx.getDb();
  const agent = await ctx.loadAgent(p.agentId);
  if (!agent) throw new Error(`Agent ${p.agentId} not found.`);
  const user = await loadTurnUser(db, p.userId);
  if (!user) throw new Error(`User ${p.userId} not found.`);

  const enabledSkills: ExuluSkill[] = await getEnabledSkills(agent, []);
  const enabledTools: ExuluTool[] = await getEnabledTools(agent, ctx.tools, ctx.contexts, [], user);

  if (!agent.model) throw new Error(`Agent ${agent.name} (${agent.id}) has no model configured.`);
  const resolved = await resolveModel({ modelId: agent.model, user, agent });
  const contextWindow = await resolveContextWindow({ modelId: resolved.model.id });
  const instructions = withGlossary(agent.instructions, agent.tools);

  const question: UIMessage = { id: newMessageId(), role: "user", parts: [{ type: "text", text: p.text }] };

  await markSessionGenerating(db, p.sessionId);
  let answer: unknown;
  try {
    answer = await generateSync({
      contexts: ctx.contexts,
      agent,
      user,
      req: GUEST_TURN_REQUEST,
      instructions,
      session: p.sessionId,
      inputMessages: [question],
      currentTools: enabledTools,
      currentSkills: enabledSkills,
      allExuluTools: ctx.tools,
      languageModel: resolved.languageModel,
      exuluConfig: ctx.config,
      toolConfigs: agent.tools,
      contextWindow,
      disabledTools: [],
      statistics: { label: agent.name, trigger: "agent" },
    });
  } catch (error) {
    await markSessionIdle(db, p.sessionId);
    throw error;
  }

  const text = typeof answer === "string" ? answer : "";
  if (text.trim() === "") {
    await markSessionIdle(db, p.sessionId);
    return text;
  }
  await saveChat({
    session: p.sessionId,
    user: user.id,
    messages: [question, { id: newMessageId(), role: "assistant", parts: [{ type: "text", text }] }],
    model: resolved.model.id,
  });
  await markSessionAnswered(db, p.sessionId);
  // The history keeps the citations (the web chat renders them); WhatsApp gets plain text.
  // Nothing but citations → empty, so the caller posts runFailed.
  const plain = stripCitations(text);
  return plain.trim() === "" ? "" : plain;
};
