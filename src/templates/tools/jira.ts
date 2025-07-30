import { z } from "zod";
import { ExuluTool } from "../../registry/classes";

// todo move this to the own tools/browserbase package so it can be installed seperately and doesnt bloat the main Exulu package

const getTicket = new ExuluTool({
    id: `1414-5179-1423-1269`,
    name: "JIRA ticket retrieval.",
    type: "function",
    inputSchema: z.object({
        ticketId: z.string().describe("The id of the ticket to retrieve."),
    }),
    description: `Retrieves a ticket from Jira.`,
    execute: async ({ session, question }: any) => {
        return {
            name: "BYD-1234",
            id: "12345678",
            status: "Open",
            description: "This is a test ticket",
            assignee: "John Doe",
            createdAt: "2021-01-01",
            updatedAt: "2021-01-01",
            dueDate: "2021-01-01",
            priority: "High",
        }
    },
})

export { getTicket };