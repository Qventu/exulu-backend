import type { Express, Request, Response } from "express";
import { exuluApp } from "../app/singleton.ts";
import { requestValidators } from "../../validators/requests.ts";
import { checkRecordAccess } from "../../utils/check-record-access.ts";
import { isHermesEnabled } from "./config";
import { profileIdFor } from "./provisioner";
import {
  deleteProfileSkill,
  isSafeSkillId,
  listProfileSkills,
  readProfileSkill,
  writeProfileSkill,
} from "./skills-store";

/**
 * Surfaces the skills a Hermes profile accumulates over time — including the
 * ones Hermes auto-distills from past conversations — so users can review,
 * edit, or delete them from the chat UI.
 *
 * Skills live under `${profileDir}/skills/<skillId>/SKILL.md` (Hermes' default
 * skills home, since HERMES_HOME == profileDir). For shared-scope agents the
 * skills are common to all users of the agent; for private scope they are
 * per-user. Access is gated by the agent's existing RBAC.
 *
 * Design doc: docs/superpowers/specs/2026-06-03-hermes-agent-mode-design.md
 */

const log = (line: string) => console.log(`[EXULU-HERMES-SKILLS] ${line}`);

/**
 * Resolve the agent + caller for a skills request and enforce RBAC. Returns the
 * derived profileId, or sends the appropriate error response and returns null.
 */
const authorize = async (
  req: Request,
  res: Response,
  access: "read" | "write",
): Promise<string | null> => {
  const agentId = req.params.agentId;
  if (!agentId) {
    res.status(400).json({ message: "Missing agent id" });
    return null;
  }
  const agent = await exuluApp.get().agent(agentId);
  if (!agent) {
    res.status(404).json({ message: "Agent not found" });
    return null;
  }
  const authn = await requestValidators.authenticate(req);
  const user = authn.user;
  if (!user?.id && agent.rights_mode !== "public") {
    res.status(authn.code || 401).json({ message: authn.message });
    return null;
  }
  if (!(await checkRecordAccess(agent, access, user))) {
    res.status(403).json({ message: "You don't have access to this agent." });
    return null;
  }
  const scope =
    (agent as any).advanced_agent_profile_scope === "private"
      ? "private"
      : "shared";
  try {
    return profileIdFor(agent.id, scope, user?.id);
  } catch (err) {
    res.status(400).json({ message: (err as Error).message });
    return null;
  }
};

/** Mount the Hermes skills routes. No-op unless ENABLE_HERMES_AGENT is set. */
export const registerHermesSkillsRoutes = (app: Express): void => {
  if (!isHermesEnabled()) return;

  app.get("/agents/:agentId/hermes-skills", async (req, res) => {
    const profileId = await authorize(req, res, "read");
    if (!profileId) return;
    res.status(200).json({ skills: await listProfileSkills(profileId) });
  });

  app.get("/agents/:agentId/hermes-skills/:skillId", async (req, res) => {
    const profileId = await authorize(req, res, "read");
    if (!profileId) return;
    const skillId = req.params.skillId!;
    if (!isSafeSkillId(skillId)) {
      res.status(400).json({ message: "Invalid skill id" });
      return;
    }
    const content = await readProfileSkill(profileId, skillId);
    if (content === undefined) {
      res.status(404).json({ message: "Skill not found" });
      return;
    }
    res.status(200).json({ id: skillId, content });
  });

  app.put("/agents/:agentId/hermes-skills/:skillId", async (req, res) => {
    const profileId = await authorize(req, res, "write");
    if (!profileId) return;
    const skillId = req.params.skillId!;
    if (!isSafeSkillId(skillId)) {
      res.status(400).json({ message: "Invalid skill id" });
      return;
    }
    const content = req.body?.content;
    if (typeof content !== "string") {
      res.status(400).json({ message: "Body must include a string `content`." });
      return;
    }
    try {
      await writeProfileSkill(profileId, skillId, content);
      res.status(200).json({ id: skillId, content });
    } catch {
      res.status(404).json({ message: "Skill not found" });
    }
  });

  app.delete("/agents/:agentId/hermes-skills/:skillId", async (req, res) => {
    const profileId = await authorize(req, res, "write");
    if (!profileId) return;
    const skillId = req.params.skillId!;
    if (!isSafeSkillId(skillId)) {
      res.status(400).json({ message: "Invalid skill id" });
      return;
    }
    await deleteProfileSkill(profileId, skillId);
    res.status(200).json({ id: skillId, deleted: true });
  });

  log("Hermes skills routes mounted at /agents/:agentId/hermes-skills");
};
