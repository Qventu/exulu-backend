import DESCRIPTION_ASK from "./questionask.txt";
import DESCRIPTION_READ from "./questionread.txt";
import z from "zod";
import { ExuluTool } from "@SRC/exulu/tool.ts";
import { checkRecordAccess } from "@SRC/utils/check-record-access.ts";
import type { AgentSession } from "@EXULU_TYPES/models/agent-session";
import { postgresClient } from "../../../postgres/client";
import { getSession } from "@SRC/exulu/provider";
import { randomUUID } from "node:crypto";

const AnswerOptionSchema = z.object({
  id: z.string().describe("Unique identifier for the answer option"),
  text: z.string().describe("The text of the answer option"),
});

const _QuestionSchema = z.object({
  id: z.string().describe("Unique identifier for the question"),
  question: z.string().describe("The question to ask the user"),
  answerOptions: z
    .array(AnswerOptionSchema)
    .describe("Array of possible answer options"),
  selectedAnswerId: z
    .string()
    .optional()
    .describe("The ID of the answer option selected by the user"),
  status: z
    .enum(["pending", "answered"])
    .describe("Status of the question: pending or answered"),
});

const QuestionAskTool = new ExuluTool({
  id: "question_ask",
  name: "Question Ask",
  description: "Use this tool to ask a question to the user with multiple choice answers",
  type: "function",
  category: "question",
  config: [
    {
      name: "description",
      description:
        "The description of the question tool, if set overwrites the default description.",
      type: "string",
      default: DESCRIPTION_ASK,
    },
  ],
  inputSchema: z.object({
    question: z.string().describe("The question to ask the user"),
    answerOptions: z
      .array(z.string())
      .describe("Array of possible answer options (strings)"),
  }),
  execute: async (inputs) => {
    const { sessionID, question, answerOptions, user } = inputs;

    if (!user) {
      throw new Error(
        "No authenticated user available, a user is required for the question ask tool, this likely means the tool was called outside a session like in an MCP or API call instead of as part of an authenticated session.",
      );
    }

    if (!sessionID) {
      throw new Error(
        "Session ID is required for the question ask tool, this likely means the tool was called outside a session like in an MCP or API call instead of as part of a conversation.",
      );
    }

    const session = await getSession({ sessionID });

    if (!session?.id) {
      throw new Error(
        "Session with ID " + sessionID + " not found in the question ask tool.",
      );
    }

    const hasAccessToSession = await checkRecordAccess(session, "read", user);

    if (!hasAccessToSession) {
      throw new Error("You don't have access to this session " + session.id + ".");
    }

    // Convert string array to answer option objects with IDs
    const answerOptionsWithIds: z.infer<typeof AnswerOptionSchema>[] =
      answerOptions.map((text: string) => ({
        id: randomUUID(),
        text,
      }));

    // Add "None of the above..." option
    answerOptionsWithIds.push({
      id: randomUUID(),
      text: "None of the above...",
    });

    // Create question object
    const newQuestion: z.infer<typeof _QuestionSchema> = {
      id: randomUUID(),
      question,
      answerOptions: answerOptionsWithIds,
      status: "pending",
    };

    await addQuestion({
      session,
      question: newQuestion,
    });

    return {
      result: JSON.stringify(
        {
          questionId: newQuestion.id,
          question: newQuestion.question,
          answerOptions: newQuestion.answerOptions,
          status: newQuestion.status,
        },
        null,
        2,
      ),
    };
  },
});

const QuestionReadTool = new ExuluTool({
  id: "question_read",
  name: "Question Read",
  description: "Use this tool to read questions and their answers",
  inputSchema: z.object({}),
  type: "function",
  category: "question",
  config: [
    {
      name: "description",
      description:
        "The description of the question read tool, if set overwrites the default description.",
      type: "string",
      default: DESCRIPTION_READ,
    },
  ],
  execute: async (inputs) => {
    const { sessionID } = inputs;
    const questions = await getQuestions(sessionID);
    return {
      result: JSON.stringify(questions, null, 2),
    };
  },
});

type QuestionType = z.infer<typeof _QuestionSchema>;

async function addQuestion(input: {
  session: AgentSession;
  question: QuestionType;
}): Promise<AgentSession> {
  const metadata = input.session.metadata ?? {};

  metadata["questions"] ??= [];

  metadata["questions"].push(input.question);

  const { db } = await postgresClient();

  await db.from("agent_sessions").where({ id: input.session.id }).update({
    metadata,
  });

  return input.session;
}

async function getQuestions(sessionID: string): Promise<QuestionType[]> {
  const { db } = await postgresClient();
  const session = await db.from("agent_sessions").where({ id: sessionID }).first();
  if (!session) {
    throw new Error("Session not found for session ID: " + sessionID);
  }
  return session.metadata?.questions ?? [];
}

export const questionTools = [QuestionAskTool, QuestionReadTool];
