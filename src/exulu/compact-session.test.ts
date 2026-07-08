import type { UIMessage } from "ai";
import { splitTail, serializeForSummary, compactSession, CompactionInsufficientError } from "./compact-session";
import { getCompaction, COMPACTION_INSUFFICIENT } from "./context-budget";
import type { User } from "@EXULU_TYPES/models/user";
import type { LanguageModel } from "ai";

jest.mock("./provider", () => ({
  getAgentMessages: jest.fn(),
  saveChat: jest.fn().mockResolvedValue(undefined),
}));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const providerMock = require("./provider") as { getAgentMessages: jest.Mock; saveChat: jest.Mock };

const msg = (role: "user" | "assistant", body: string, metadata?: object): UIMessage =>
  ({ id: `m_${Math.random().toString(36).slice(2)}`, role, parts: [{ type: "text", text: body }], ...(metadata ? { metadata } : {}) }) as UIMessage;

const user = { id: 1 } as User;
const languageModel = {} as LanguageModel;

afterEach(() => jest.clearAllMocks());

describe("splitTail", () => {
  it("keeps the longest suffix under the budget, minimum 2 messages", () => {
    const messages = [msg("user", "a".repeat(4_000)), msg("assistant", "b".repeat(4_000)), msg("user", "c"), msg("assistant", "d")];
    const { head, tail } = splitTail(messages, 200);
    expect(tail.length).toBe(2);
    expect(tail.map((m) => m.id)).toEqual([messages[2]!.id, messages[3]!.id]);
    expect(head.length).toBe(2);
  });

  it("keeps everything as tail when the whole history fits", () => {
    const messages = [msg("user", "a"), msg("assistant", "b")];
    const { head, tail } = splitTail(messages, 100_000);
    expect(head).toEqual([]);
    expect(tail.length).toBe(2);
  });
});

describe("serializeForSummary", () => {
  it("renders roles, text, and sliced tool parts", () => {
    const withTool = {
      ...msg("assistant", ""),
      parts: [
        { type: "tool-web_search", input: { q: "elevators" }, output: { value: "r".repeat(5_000) } },
        { type: "text", text: "done" },
      ],
    } as unknown as UIMessage;
    const out = serializeForSummary([msg("user", "hi"), withTool]);
    expect(out).toContain("USER:\nhi");
    expect(out).toContain("ASSISTANT:");
    expect(out).toContain("[tool tool-web_search:");
    expect(out.length).toBeLessThan(3_000); // tool output sliced to 1500 chars
  });
});

describe("compactSession", () => {
  const buildBigHistory = () => {
    // 20 fat turns + 2 small recent ones; window 10K → tail budget ~800 tokens
    // Fat messages ~525 tokens, small ~25 tokens. splitTail: messages 39-41 form
    // the tail (3 messages; msg[39] adds 525, but would exceed 800 at msg[38] which
    // is 4th msg beyond minTail=2), leaving messages[0..38] as head. lastHeadId = messages[38].
    const messages: UIMessage[] = [];
    for (let i = 0; i < 20; i++) {
      messages.push(msg("user", `question ${i} ` + "x".repeat(2_000)));
      messages.push(msg("assistant", `answer ${i} ` + "y".repeat(2_000)));
    }
    const tailUser = msg("user", "recent question");
    const tailAssistant = msg("assistant", "recent answer");
    messages.push(tailUser, tailAssistant);
    return {
      rows: messages.map((m) => ({ content: JSON.stringify(m) })),
      lastHeadId: messages[messages.length - 4]!.id,
      tailIds: [tailUser.id, tailAssistant.id],
    };
  };

  it("summarizes the head, saves and returns a checkpoint message", async () => {
    const history = buildBigHistory();
    providerMock.getAgentMessages.mockResolvedValue(history.rows);
    const summarize = jest.fn().mockResolvedValue("Dense summary of the work so far.");
    const result = await compactSession({
      sessionID: "s1",
      user,
      languageModel,
      contextWindow: 10_000,
      steer: "keep the exact figures",
      summarize,
    });
    expect(summarize).toHaveBeenCalledTimes(1);
    expect(summarize.mock.calls[0]![0].system).toContain("Focus especially on: keep the exact figures");
    const compaction = getCompaction(result.checkpoint)!;
    expect(compaction).toBeDefined();
    expect(compaction.occupancyEstimate).toBe(result.occupancyEstimate);
    expect(compaction.steer).toBe("keep the exact figures");
    expect(result.checkpoint.role).toBe("user");
    expect((result.checkpoint.parts![0] as { text: string }).text).toContain("[Conversation summary — earlier messages were compacted]");
    expect(providerMock.saveChat).toHaveBeenCalledWith(
      expect.objectContaining({ session: "s1", user: 1, messages: [result.checkpoint] }),
    );
    // coversUpTo marks the last HEAD message — never one of the tail messages.
    expect(compaction.coversUpTo).toBe(history.lastHeadId);
    expect(history.tailIds).not.toContain(compaction.coversUpTo);
  });

  it("throws CompactionInsufficientError when there is nothing to compact", async () => {
    providerMock.getAgentMessages.mockResolvedValue([
      { content: JSON.stringify(msg("user", "hi")) },
      { content: JSON.stringify(msg("assistant", "hello")) },
    ]);
    await expect(
      compactSession({ sessionID: "s1", user, languageModel, contextWindow: 200_000, summarize: jest.fn() }),
    ).rejects.toThrow(CompactionInsufficientError);
    expect(providerMock.saveChat).not.toHaveBeenCalled();
  });

  it("throws CompactionInsufficientError when the result still exceeds the block threshold", async () => {
    providerMock.getAgentMessages.mockResolvedValue(buildBigHistory().rows);
    // Summary so large it cannot help (summarize stub ignores maxOutputTokens).
    const summarize = jest.fn().mockResolvedValue("s".repeat(80_000));
    await expect(
      compactSession({ sessionID: "s1", user, languageModel, contextWindow: 10_000, summarize }),
    ).rejects.toThrow(COMPACTION_INSUFFICIENT);
    expect(providerMock.saveChat).not.toHaveBeenCalled();
  });
});
