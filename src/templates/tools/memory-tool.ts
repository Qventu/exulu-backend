import type { ExuluAgent } from "@EXULU_TYPES/models/agent";
import type { ExuluContext } from "@SRC/exulu/context";
import { ExuluTool } from "@SRC/exulu/tool";
import { z, ZodSchema } from "zod";
import { sanitizeName } from "@SRC/utils/sanitize-name";

export const createNewMemoryItemTool = (agent: ExuluAgent, context: ExuluContext): ExuluTool => {
  const fields: Record<string, ZodSchema> = {
    name: z.string().describe("The name of the item to create"),
    description: z.string().describe("The description of the item to create"),
    surroundingContext: z.string().describe("A description of the context surrounding this memory, for example if it relates to a question a user asked, a specific product, or entity etc..."),
  };
  for (const field of context.fields) {
    switch (field.type) {
      case "text":
      case "longText":
      case "shortText":
      case "code":
        fields[field.name] = z.string().describe("The " + field.name + " of the item to create");
        break;
      case "enum":
        if (field.enumValues && field.enumValues.length > 0) {
          const enumValues = field.enumValues as [string, ...string[]];
          fields[field.name] = z
            .preprocess(
              (v) => (typeof v === "string" ? v.toUpperCase() : v),
              z.enum(enumValues),
            )
            .describe(
              "The " + field.name + " of the item to create. Must be one of: " + field.enumValues.join(", "),
            );
        } else {
          fields[field.name] = z.string().describe("The " + field.name + " of the item to create");
        }
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

  // Add visibility as a fixed field (not dynamic from context.fields)
  fields["visibility"] = z
    .enum(["private", "public"])
    .optional()
    .describe(
      "Whether this memory is private to the user or shared (public). Ask the user if unknown.",
    );

  const toolName =  "create_" + sanitizeName(context.name) + "_memory_item"

  return new ExuluTool({
    id: toolName,
    name: "Create " + context.name + " Memory Item",
    category: agent.name + "_memory",
    description: "Create a new memory item in the " + agent.name + " memory context",
    type: "function",
    inputSchema: z.object(fields),
    config: [],
    execute: async (params: any) => {
      const { name, description, surroundingContext, information, visibility, exuluConfig, user } = params;
      let result: { result: string } = { result: "" };

      if (!visibility) {
        return {
          result:
            "Before saving this memory, ask the user whether it should be PRIVATE (visible only to them) " +
            `or PUBLIC (shared with the team), then call \`${toolName}\` again with \`visibility\` set.`,
        };
      }

      try {
        // Normalize enum fields: case-insensitive match against enumValues; drop if unknown.
        const extraFields: Record<string, unknown> = {};
        for (const field of context.fields ?? []) {
          if (field.type === "enum" && field.enumValues && field.enumValues.length > 0) {
            const raw: unknown = params[field.name];
            if (raw !== undefined && raw !== null && raw !== "") {
              const rawStr = String(raw);
              const canonical = field.enumValues.find(
                (v: string) => v.toUpperCase() === rawStr.toUpperCase(),
              );
              if (canonical !== undefined) {
                extraFields[field.name] = canonical;
              }
              // If no match: silently drop — do NOT persist an out-of-enum value.
            }
          }
        }

        const newItem = {
          name: name,
          description: "Description: " + description + "\n\nSurrounding Context: " + surroundingContext,
          information: "Information: " + information,
          rights_mode: visibility === "private" ? "private" : "public",
          ...extraFields,
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
      } catch (error) {
        console.error("[EXULU] Error creating memory item", error);
        result = {
          result: `Failed to create memory item: ${error instanceof Error ? error.message : String(error)}`,
        };
      }

      return result;
    },
  });
};
