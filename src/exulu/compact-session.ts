import { randomUUID } from "node:crypto";
import { generateText, validateUIMessages, type LanguageModel, type UIMessage } from "ai";
import type { User } from "@EXULU_TYPES/models/user";
import { truncateToolOutput } from "@SRC/utils/truncate-tool-output";
import { getAgentMessages, saveChat } from "./provider";
import {
  COMPACTION_INSUFFICIENT,
  deriveContextBudget,
  estimateMessageTokens,
  estimateTokens,
  sliceHistoryAtCheckpoint,
  type CompactionMetadata,
} from "./context-budget";

export class CompactionInsufficientError extends Error {
  constructor(reason: string) {
    super(JSON.stringify({ code: COMPACTION_INSUFFICIENT, message: reason }));
    this.name = "CompactionInsufficientError";
  }
}

const MIN_TAIL_MESSAGES = 2;
const SUMMARY_TOOL_OUTPUT_SLICE = 1_500;
const SUMMARY_TOOL_INPUT_SLICE = 200;

const SUMMARY_SYSTEM = `You compress chat histories for an AI assistant. Produce a dense, factual summary of the conversation below. Preserve:
- the user's intent and any outstanding requests
- key facts, decisions, and constraints
- files, artifacts, and session files touched — ALWAYS keep exact file and item names so they stay retrievable
- errors encountered and how they were resolved
- pending tasks and the current state of the work
Do not invent information. Do not include pleasantries. Write compact prose or bullet points.`;

/** Tail = the longest suffix that fits the budget; never fewer than MIN_TAIL_MESSAGES. */
export const splitTail = (
  messages: UIMessage[],
  tailTokenBudget: number,
): { head: UIMessage[]; tail: UIMessage[] } => {
  const minTail = Math.min(MIN_TAIL_MESSAGES, messages.length);
  let cut = messages.length;
  let tokens = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const t = estimateMessageTokens(messages[i]!);
    const tailCount = messages.length - i;
    if (tailCount > minTail && tokens + t > tailTokenBudget) break;
    tokens += t;
    cut = i;
  }
  return { head: messages.slice(0, cut), tail: messages.slice(cut) };
};

/** Plain-text rendering of UIMessages for the summarizer prompt. */
export const serializeForSummary = (messages: UIMessage[]): string =>
  messages
    .map((m) => {
      const parts = (m.parts ?? [])
        .map((part) => {
          const p = part as {
            type?: string;
            text?: string;
            input?: unknown;
            output?: { value?: unknown } | unknown;
            filename?: string;
            url?: string;
          };
          if (p.type === "text") return p.text ?? "";
          if (p.type === "file") return `[file: ${p.filename ?? p.url ?? "attachment"}]`;
          if (p.type === "reasoning" || p.type === "step-start") return "";
          if (p.type?.startsWith("tool-") || p.type === "dynamic-tool") {
            const out = (p.output as { value?: unknown } | undefined)?.value ?? p.output;
            const outText = typeof out === "string" ? out : JSON.stringify(out ?? "");
            return `[tool ${p.type}: ${JSON.stringify(p.input ?? {}).slice(0, SUMMARY_TOOL_INPUT_SLICE)}] → ${outText.slice(0, SUMMARY_TOOL_OUTPUT_SLICE)}`;
          }
          return "";
        })
        .filter(Boolean)
        .join("\n");
      return `${m.role.toUpperCase()}:\n${parts}`;
    })
    .join("\n\n");

/**
 * Compact a session (spec §4): summarize everything before the verbatim tail
 * into a checkpoint message row. The checkpoint's metadata.compaction marks
 * coversUpTo; sliceHistoryAtCheckpoint (context-budget.ts) assembles the model
 * view as [checkpoint, ...messages newer than coversUpTo].
 */
export const compactSession = async ({
  sessionID,
  user,
  languageModel,
  contextWindow,
  steer,
  modelId,
  summarize,
}: {
  sessionID: string;
  user: User;
  languageModel: LanguageModel;
  contextWindow: number;
  steer?: string;
  modelId?: string;
  summarize?: (args: { system: string; prompt: string; maxOutputTokens: number }) => Promise<string>;
}): Promise<{ checkpoint: UIMessage; occupancyEstimate: number; originalTokens: number; summaryTokens: number }> => {
  const budget = deriveContextBudget(contextWindow);
  const rows = await getAgentMessages({ session: sessionID, user: user.id });
  const all = await validateUIMessages({ messages: rows.map((r: { content: string }) => JSON.parse(r.content)) });
  // Only what the model currently sees is compactable — prior checkpoints
  // already collapsed everything before them.
  const history = sliceHistoryAtCheckpoint(all as UIMessage[]);
  const { head, tail } = splitTail(history, budget.compactionTailTokens);
  if (head.length === 0) {
    throw new CompactionInsufficientError(
      "There is nothing left to compact — the recent messages already form the whole context. Start a new chat instead.",
    );
  }

  let corpus = serializeForSummary(head);
  const originalTokens = estimateTokens(corpus);
  // The summarization call itself must fit the window: head/tail split keeps
  // the notice-bearing prefixes, hard head/tail-truncate the middle if needed.
  corpus = truncateToolOutput(corpus, contextWindow, "history", 0.3, Math.floor(budget.usableWindow * 0.8) * 4);

  const system = steer?.trim() ? `${SUMMARY_SYSTEM}\n\nFocus especially on: ${steer.trim()}` : SUMMARY_SYSTEM;
  const doSummarize =
    summarize ??
    (async ({ system: sys, prompt, maxOutputTokens }: { system: string; prompt: string; maxOutputTokens: number }) => {
      const { text } = await generateText({
        model: languageModel,
        system: sys,
        prompt,
        temperature: 0,
        maxRetries: 2,
        maxOutputTokens,
      });
      return text;
    });

  const summary = await doSummarize({ system, prompt: corpus, maxOutputTokens: budget.summaryBudgetTokens });
  const summaryTokens = estimateTokens(summary);
  let tailTokens = 0;
  for (const m of tail) tailTokens += estimateMessageTokens(m);
  const occupancyEstimate = summaryTokens + tailTokens;

  if (occupancyEstimate >= budget.blockThreshold) {
    throw new CompactionInsufficientError(
      "Compacting cannot shrink this conversation below the context limit — a recent message or output is too large by itself. Start a new chat.",
    );
  }

  const compaction: CompactionMetadata = {
    coversUpTo: head[head.length - 1]!.id,
    originalTokens,
    summaryTokens,
    occupancyEstimate,
    ...(steer?.trim() ? { steer: steer.trim() } : {}),
  };
  const checkpoint = {
    id: `compaction_${randomUUID()}`,
    role: "user",
    parts: [{ type: "text", text: `[Conversation summary — earlier messages were compacted]\n\n${summary}` }],
    metadata: { compaction },
  } as unknown as UIMessage;

  await saveChat({ session: sessionID, user: user.id, messages: [checkpoint], ...(modelId ? { model: modelId } : {}) });
  return { checkpoint, occupancyEstimate, originalTokens, summaryTokens };
};
