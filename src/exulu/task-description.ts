import { generateText, type LanguageModel } from "ai";
import { postgresClient } from "@SRC/postgres/client";

const AGENT_VISUALIZATION_ENABLED = process.env.NEXT_PUBLIC_AGENT_VISUALIZATION === "true";

/**
 * Generates a brief, privacy-safe description of what the agent is currently
 * working on and writes it to the session record — non-blocking.
 *
 * Call this with `.catch(() => {})` — it must never propagate errors into the
 * main generation path.
 */
export async function setSessionCurrentTask({
  session,
  userMessage,
  model,
}: {
  session: string;
  userMessage: string;
  model: LanguageModel
}): Promise<void> {
  console.log("[EXULU] Setting session current task: " + userMessage);
  console.log("[EXULU] AGENT_VISUALIZATION_ENABLED: " + AGENT_VISUALIZATION_ENABLED);
  if (!AGENT_VISUALIZATION_ENABLED || !session || !userMessage.trim()) {
    return;
  }

  const truncated = userMessage.slice(0, 500);

  console.log("[EXULU] Generating text for session current task: " + truncated);
  const { text } = await generateText({
    model: model,
    prompt: `You are a task labeler for an agent monitoring dashboard visible to all employees.
Given the user message below, write a 4–8 word present-tense description of what the AI assistant is working on.

Rules:
- Start with a present participle verb (e.g. Analyzing, Generating, Searching, Writing, Reviewing)
- Never include names, email addresses, phone numbers, IDs, URLs, or any personal data
- Be generic: "Analyzing sales data" not "Analyzing Q3 report for Acme Corp"
- Max 8 words, no punctuation at the end

Message: ${truncated}

Task:`,
  });

  console.log("[EXULU] Generated text for session current task: " + text);

  const task = text?.trim().replace(/[.!?]+$/, "").slice(0, 80);
  if (!task) return;

  const { db } = await postgresClient();
  await db("agent_sessions").where({ id: session }).update({ currenttask: task });
}

/**
 * Clears the current task on the session once generation is complete.
 * Non-blocking — call with `.catch(() => {})`.
 */
export async function clearSessionCurrentTask(session: string): Promise<void> {
  if (!AGENT_VISUALIZATION_ENABLED || !session) return;
  const { db } = await postgresClient();
  await db("agent_sessions").where({ id: session }).update({ currenttask: null });
}
