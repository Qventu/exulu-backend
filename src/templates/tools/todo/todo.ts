import DESCRIPTION_WRITE from "./todowrite.txt"
import DESCRIPTION_READ from "./todoread.txt"
import z from "zod"
import { ExuluTool, getSession } from "src/exulu/classes.ts"
import { checkRecordAccess } from "src/utils/check-record-access.ts"
import type { AgentSession } from "@EXULU_TYPES/models/agent-session"
import { postgresClient } from "../../../postgres/client"

const TodoSchema = z
  .object({
    content: z.string().describe("Brief description of the task"),
    status: z.string().describe("Current status of the task: pending, in_progress, completed, cancelled"),
    priority: z.string().describe("Priority level of the task: high, medium, low"),
    id: z.string().describe("Unique identifier for the todo item"),
  })

const TodoWriteTool = new ExuluTool({
  id: "todo_write",
  name: "Todo Write",
  description: "Use this tool to write your todo list",
  type: "function",
  category: "todo",
  config: [{
    name: "description",
    description: "The description of the todo list, if set overwrites the default description.",
    type: "string",
    default: DESCRIPTION_WRITE
  }],
  inputSchema: z.object({
    todos: z.array(TodoSchema).describe("The updated todo list"),
  }), 
  execute: async (inputs) => {

    const { sessionID, todos, user } = inputs

    if (!user) {
      throw new Error("No authenticated user available, a user is required for the todo write tool, this likely means the tool was called outside a session like in an MCP or API call instead of as part of an authenticated session.")
    }

    if (!sessionID) {
      throw new Error("Session ID is required for the todo write tool, this likely means the tool was called outside a session like in an MCP or API call instead of as part of a conversation.")
    }
    const session = await getSession({ sessionID })

    if (!session?.id) {
      throw new Error("Session with ID " + sessionID + " not found in the todo write tool.")
    }

    const hasAccessToSession = await checkRecordAccess(session, "read", user)

    if (!hasAccessToSession) {
      throw new Error("You don't have access to this session " + session.id + ".")
    }
    await updateTodos({
      session,
      todos,
    })

    return {
      result: JSON.stringify(todos, null, 2)
    }
  },
})

const TodoReadTool = new ExuluTool({
  id: "todo_read",
  name: "Todo Read",
  description: "Use this tool to read your todo list",
  inputSchema: z.object({}),
  type: "function",
  category: "todo",
  config: [{
    name: "description",
    description: "The description of the todo list, if set overwrites the default description.",
    type: "string",
    default: DESCRIPTION_READ
  }],
  execute: async (inputs) => {
    const { sessionID } = inputs
    let todos = await getTodos(sessionID)
    return {
      result: JSON.stringify(todos, null, 2)
    }
  },
})

type TodoType = z.infer<typeof TodoSchema>

async function updateTodos(input: { session: AgentSession; todos: TodoType[] }) {
  const metadata = input.session.metadata || {}

  metadata["todos"] = input.todos

  const { db } = await postgresClient();

  await db.from("agent_sessions").where({ id: input.session.id }).update({
    metadata,
  })

  return input.session;
}

async function getTodos(sessionID: string) {
  const { db } = await postgresClient();
  const session = await db.from("agent_sessions").where({ id: sessionID }).first();
  if (!session) {
    throw new Error("Session not found for session ID: " + sessionID);
  }
  return session.metadata?.todos || []
}

export const todoTools = [
  TodoWriteTool,
  TodoReadTool,
]