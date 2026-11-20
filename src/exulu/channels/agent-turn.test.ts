jest.mock("../generate-stream", () => ({ generateSync: jest.fn(), saveChat: jest.fn() }));
jest.mock("@SRC/utils/enabled-tools", () => ({ getEnabledTools: jest.fn() }));
jest.mock("@SRC/utils/enabled-skills", () => ({ getEnabledSkills: jest.fn() }));
jest.mock("../resolve-model", () => ({ resolveModel: jest.fn() }));
jest.mock("../resolve-context-window", () => ({ resolveContextWindow: jest.fn() }));
jest.mock("../session-activity", () => ({
  markSessionGenerating: jest.fn(async () => {}),
  markSessionAnswered: jest.fn(async () => {}),
  markSessionIdle: jest.fn(async () => {}),
}));

import { generateSync, saveChat } from "../generate-stream";
import { getEnabledTools } from "@SRC/utils/enabled-tools";
import { getEnabledSkills } from "@SRC/utils/enabled-skills";
import { resolveModel } from "../resolve-model";
import { resolveContextWindow } from "../resolve-context-window";
import { markSessionAnswered, markSessionGenerating, markSessionIdle } from "../session-activity";
import { isPublicSurface, treatAsGuest } from "../public-surface";
import { loadTurnUser, runChannelAgentTurn, type AgentTurnContext } from "./agent-turn";

const m = (fn: unknown) => fn as jest.Mock;

const agent = {
  id: "agent-1",
  name: "Newton",
  model: "gemini-pro",
  instructions: "Be helpful.",
  tools: [],
};
const user = { id: 7, email: "a@b.c", role: { id: "r1", name: "external" } };

/** db(table).where(...).first() → the configured row. */
const fakeDb = (tables: Record<string, any>) => {
  const db: any = (table: string) => ({ where: () => ({ first: async () => tables[table] }) });
  return db;
};

const ctx = (over: Partial<AgentTurnContext> = {}): AgentTurnContext => ({
  tools: [{ id: "t1" }] as any,
  contexts: [{ id: "c1" }] as any,
  config: { some: "config" } as any,
  getDb: async () => fakeDb({ users: { id: 7, email: "a@b.c", role: "r1" }, roles: { id: "r1", name: "external" } }),
  loadAgent: async () => agent as any,
  ...over,
});

const turn = { agentId: "agent-1", userId: 7, sessionId: "sess-1", text: "Wie tausche ich das Relais?" };

beforeEach(() => {
  jest.clearAllMocks();
  m(getEnabledSkills).mockResolvedValue([{ name: "skill" }]);
  m(getEnabledTools).mockResolvedValue([{ id: "t1" }]);
  m(resolveModel).mockResolvedValue({ languageModel: { lm: true }, model: { id: "gemini-pro" } });
  m(resolveContextWindow).mockResolvedValue(1_000_000);
  m(generateSync).mockResolvedValue("Das Relais tauschen Sie so ...");
});

describe("runChannelAgentTurn", () => {
  it("runs the agent as the linked user, as a guest turn, and returns the answer", async () => {
    const answer = await runChannelAgentTurn(turn, ctx());
    expect(answer).toBe("Das Relais tauschen Sie so ...");

    expect(getEnabledSkills).toHaveBeenCalledWith(agent, []);
    const [toolAgent, allTools, contexts, disabled, toolUser] = m(getEnabledTools).mock.calls[0];
    expect(toolAgent).toBe(agent);
    expect(allTools).toEqual([{ id: "t1" }]);
    expect(contexts).toEqual([{ id: "c1" }]);
    expect(disabled).toEqual([]);
    expect(toolUser.id).toBe(7);
    expect(resolveModel).toHaveBeenCalledWith({ modelId: "gemini-pro", user: expect.objectContaining({ id: 7 }), agent });

    const args = m(generateSync).mock.calls[0][0];
    expect(args.user.id).toBe(7);
    expect(args.user.role).toEqual({ id: "r1", name: "external" });
    expect(args.session).toBe("sess-1");
    expect(args.agent).toBe(agent);
    expect(args.instructions).toBe("Be helpful.");
    expect(args.inputMessages).toHaveLength(1);
    expect(args.inputMessages[0]).toMatchObject({ role: "user", parts: [{ type: "text", text: turn.text }] });
    expect(typeof args.inputMessages[0].id).toBe("string");
    expect(args.statistics).toEqual({ label: "Newton", trigger: "agent" });
    expect(args.req).toEqual({ headers: { "x-public-surface": "1" } });
    expect(isPublicSurface(args.req)).toBe(true);
    expect(treatAsGuest(args.req, args.user)).toBe(true);
    expect(args.currentTools).toEqual([{ id: "t1" }]);
    expect(args.currentSkills).toEqual([{ name: "skill" }]);
    expect(args.allExuluTools).toEqual([{ id: "t1" }]);
    expect(args.contexts).toEqual([{ id: "c1" }]);
    expect(args.languageModel).toEqual({ lm: true });
    expect(args.exuluConfig).toEqual({ some: "config" });
    expect(args.contextWindow).toBe(1_000_000);
    expect(args.disabledTools).toEqual([]);
  });

  it("persists the question and the answer to the session and marks it answered", async () => {
    await runChannelAgentTurn(turn, ctx());
    expect(markSessionGenerating).toHaveBeenCalled();
    const saved = m(saveChat).mock.calls[0][0];
    expect(saved.session).toBe("sess-1");
    expect(saved.user).toBe(7);
    expect(saved.model).toBe("gemini-pro");
    expect(saved.messages.map((x: any) => x.role)).toEqual(["user", "assistant"]);
    expect(saved.messages[0]).toEqual(m(generateSync).mock.calls[0][0].inputMessages[0]);
    expect(saved.messages[1].parts).toEqual([{ type: "text", text: "Das Relais tauschen Sie so ..." }]);
    expect(markSessionAnswered).toHaveBeenCalled();
    expect(markSessionIdle).not.toHaveBeenCalled();
  });

  it("persists the answer with its citations and returns it without them", async () => {
    const cited = "Das Relais tauschen Sie so {item_name: FST.pdf, item_id: i1, context: tech_doc, chunk_id: c1, chunk_index: 0}.";
    m(generateSync).mockResolvedValue(cited);
    expect(await runChannelAgentTurn(turn, ctx())).toBe("Das Relais tauschen Sie so.");
    expect(m(saveChat).mock.calls[0][0].messages[1].parts).toEqual([{ type: "text", text: cited }]);
    expect(markSessionAnswered).toHaveBeenCalled();
  });

  it("an answer that is only citations is persisted and returned empty", async () => {
    const cited = "{item_name: FST.pdf, item_id: i1, context: tech_doc, chunk_id: c1, chunk_index: 0}";
    m(generateSync).mockResolvedValue(cited);
    expect(await runChannelAgentTurn(turn, ctx())).toBe("");
    expect(m(saveChat).mock.calls[0][0].messages[1].parts).toEqual([{ type: "text", text: cited }]);
  });

  it("a failing run persists nothing, leaves the session idle and rethrows", async () => {
    m(generateSync).mockRejectedValue(new Error("model down"));
    await expect(runChannelAgentTurn(turn, ctx())).rejects.toThrow("model down");
    expect(saveChat).not.toHaveBeenCalled();
    expect(markSessionIdle).toHaveBeenCalled();
  });

  it("an empty answer is returned as empty and not persisted", async () => {
    m(generateSync).mockResolvedValue("  ");
    expect(await runChannelAgentTurn(turn, ctx())).toBe("  ");
    expect(saveChat).not.toHaveBeenCalled();
    expect(markSessionIdle).toHaveBeenCalled();
  });

  it("refuses a missing user, agent or model", async () => {
    await expect(runChannelAgentTurn(turn, ctx({ getDb: async () => fakeDb({}) }))).rejects.toThrow(/user/i);
    await expect(runChannelAgentTurn(turn, ctx({ loadAgent: async () => undefined }))).rejects.toThrow(/agent/i);
    await expect(
      runChannelAgentTurn(turn, ctx({ loadAgent: async () => ({ ...agent, model: undefined }) as any })),
    ).rejects.toThrow(/model/i);
    expect(generateSync).not.toHaveBeenCalled();
  });
});

describe("loadTurnUser", () => {
  it("hydrates role, team and project the way sign-in does", async () => {
    const db = fakeDb({
      users: { id: 7, role: "r1", team: "t1", project: "p1" },
      roles: { id: "r1", name: "external" },
      teams: { id: "t1" },
      projects: { id: "p1" },
    });
    const loaded = await loadTurnUser(db, 7);
    expect(loaded).toEqual({ id: 7, role: { id: "r1", name: "external" }, team: { id: "t1" }, project: { id: "p1" } });
  });

  it("returns undefined for a missing user", async () => {
    expect(await loadTurnUser(fakeDb({}), 7)).toBeUndefined();
  });
});
