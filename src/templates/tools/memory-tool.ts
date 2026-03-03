import type { Agent } from "@EXULU_TYPES/models/agent";
import type { ExuluContext } from "src/exulu/context";
import { ExuluTool } from "src/exulu/tool";
import { z, ZodSchema } from "zod";

export const createNewMemoryItemTool = (agent: Agent, context: ExuluContext): ExuluTool => {
  const fields: Record<string, ZodSchema> = {
    name: z.string().describe("The name of the item to create"),
    description: z.string().describe("The description of the item to create"),
  };
  for (const field of context.fields) {
    switch (field.type) {
      case "text":
      case "longText":
      case "shortText":
      case "code":
      case "enum":
        fields[field.name] = z.string().describe("The " + field.name + " of the item to create");
        break;
      case "json":
        fields[field.name] = z
          .string({})
          .describe(
            "The " + field.name + " of the item to create, it should be a valid JSON string.",
          );
        break;
      case "markdown":
        fields[field.name] = z
          .string()
          .describe(
            "The " + field.name + " of the item to create, it should be a valid Markdown string.",
          );
        break;
      case "number":
        fields[field.name] = z.number().describe("The " + field.name + " of the item to create");
        break;
      case "boolean":
        fields[field.name] = z.boolean().describe("The " + field.name + " of the item to create");
        break;
      case "file":
      case "uuid":
      case "date":
        // not supported
        break;
      default:
        fields[field.name] = z.string().describe("The " + field.name + " of the item to create");
        break;
    }
  }

  return new ExuluTool({
    id: "create_" + agent.name + "_memory_item",
    name: "Create " + agent.name + " Memory Item",
    category: agent.name + "_memory",
    description: "Create a new memory item in the " + agent.name + " memory context",
    type: "function",
    inputSchema: z.object(fields),
    config: [],
    execute: async ({ name, description, mode, information, exuluConfig, user }) => {
      let result: { result: string } = { result: "" };
      switch (mode) {
        case "learnings":
          break;
        case "knowledge":
          const newItem = {
            name: name,
            description: description,
            information: information,
            rights_mode: "public",
          };
          const { item: createdItem, job: createdJob } = await context.createItem(
            newItem,
            exuluConfig,
            user?.id,
            user?.role?.id,
            false,
          );

          if (createdJob) {
            result = {
              result: `Created a Job to create the memory item with the following ID: ${createdJob}`,
            };
          } else if (createdItem) {
            result = {
              result: `Created memory item with the following ID: ${createdItem.id}`,
            };
          } else {
            result = {
              result: `Failed to create memory item`,
            };
          }
          break;
        default:
          throw new Error(`Invalid mode: ${mode}`);
      }

      return result;
    },
  });
};
