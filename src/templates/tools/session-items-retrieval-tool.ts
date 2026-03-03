import type { User } from "@EXULU_TYPES/models/user";
import type { ExuluContext } from "src/exulu/context";
import { ExuluTool } from "src/exulu/tool";
import { z } from "zod";

export const createSessionItemsRetrievalTool = async ({
  user,
  role,
  contexts,
  items,
}: {
  user?: User;
  role?: string;
  contexts: ExuluContext[];
  items: string[];
}): Promise<ExuluTool | undefined> => {
  console.log("[EXULU] Session search tool created for session", items);

  const sessionItemsRetrievalTool = new ExuluTool({
    id: "session_items_information_context_search",
    name: "context_search in knowledge items added to session.",
    description: "Context search in knowledge items added to session.",
    inputSchema: z.object({
      query: z
        .string()
        .describe("The query to retrieve information from knowledge items added to the session."),
    }),
    type: "context",
    category: "session",
    config: [],
    execute: async ({ query }: any) => {
      console.log("[EXULU] Session search tool searching for session items", items);

      const set = {};
      for (const item of items) {
        // Items array in session are structured as
        // global ids ('<context_id>/<item_id>').
        const context: string | undefined = item.split("/")[0];

        if (!context) {
          throw new Error(
            "The item added to the project does not have a valid gid with the context id as the prefix before the first slash.",
          );
        }

        const id = item.split("/").slice(1).join("/");
        if (set[context]) {
          set[context].push(id);
        } else {
          set[context] = [id];
        }
      }

      console.log("[EXULU] Session search tool searching through contexts", Object.keys(set));
      // Run retrieval for each context in paralal.
      // todo add typing
      const results = await Promise.all(
        Object.keys(set).map(async (contextName) => {
          const context = contexts.find((context) => context.id === contextName);
          if (!context) {
            console.error(
              "[EXULU] Context not found for project information retrieval tool.",
              contextName,
            );
            return [];
          }
          const itemIds = set[contextName];

          console.log("[EXULU] Session search tool searching through items", itemIds);

          // Run retrieval over the items that are added to
          // the project.
          return await context.search({
            // todo check if it is more performant to use a concatenation of
            // the query and keywords, or just the keywords, instead of the
            // query itself.
            query: query,
            itemFilters: [
              {
                id: {
                  in: itemIds,
                },
              },
            ],
            chunkFilters: [],
            user: user,
            role: role,
            method: "hybridSearch",
            sort: {
              field: "updatedAt",
              direction: "desc",
            },
            trigger: "tool",
            limit: 10,
            page: 1,
          });
        }),
      );

      // Todo for contexts that dont have an embedder fall back to keyword search.
      console.log("[EXULU] Session search tool results", results);
      return {
        result: JSON.stringify(results.flat()),
      };
    },
  });

  return sessionItemsRetrievalTool;
};
