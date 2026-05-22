import DESCRIPTION_READ from "./questionread.txt";
import z from "zod";
import { ExuluTool } from "@SRC/exulu/tool.ts";
import { postgresClient } from "../../../postgres/client";
import { QuestionAskTool, type QuestionType } from "./question-ask";

export { QuestionAskTool } from "./question-ask";

const QuestionReadTool = new ExuluTool({
  id: "question_read",
  name: "Question Read",
  needsApproval: false,
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

async function getQuestions(sessionID: string): Promise<QuestionType[]> {
  const { db } = await postgresClient();
  const session = await db.from("agent_sessions").where({ id: sessionID }).first();
  if (!session) {
    throw new Error("Session not found for session ID: " + sessionID);
  }
  return session.metadata?.questions ?? [];
}

export const questionTools = [QuestionAskTool, QuestionReadTool];
