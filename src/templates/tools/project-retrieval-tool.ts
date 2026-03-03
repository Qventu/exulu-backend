import type { User } from "@EXULU_TYPES/models/user";
import type { ExuluContext } from "src/exulu/context";
import { ExuluTool } from "src/exulu/tool";
import { z } from "zod";
import { postgresClient } from "src/postgres/client";
import type { Project } from "@EXULU_TYPES/models/project";
import type { VectorSearchChunkResult } from "src/graphql/resolvers/vector-search";

export const createProjectItemsRetrievalTool = async ({
  user,
  role,
  contexts,
  projectId,
}: {
  user?: User;
  role?: string;
  contexts: ExuluContext[];
  projectId: string;
}): Promise<ExuluTool | undefined> => {
  let project: Project | undefined;

  // Check if cached project more than 1 minute old
  // this to avoid fetching the project for each tool
  // array generation.
  const { db } = await postgresClient();
  project = await db.from("projects").where("id", projectId).first();
  if (!project) {
    return;
  }
  console.log("[EXULU] Project search tool created for project", project);

  if (!project.project_items?.length) {
    return;
  }

  const projectRetrievalTool = new ExuluTool({
    id: "context_search_in_knowledge_items_added_to_project_" + projectId,
    name: "context_search in knowledge items added to project " + project.name,
    description:
      "This tool retrieves information about a project from conversations and items that were added to the project " +
      project.name +
      ".",
    inputSchema: z.object({
      query: z
        .string()
        .describe("The query to retrieve information about the project " + project.name + "."),
      keywords: z
        .array(z.string())
        .describe(
          "The most relevant keywords in the query, such as names of people, companies, products, etc. in the project " +
            project.name +
            ".",
        ),
    }),
    type: "context",
    category: "project",
    config: [],
    execute: async ({ query }: any) => {
      console.log("[EXULU] Project search tool searching for project", project);

      const items = project.project_items!;

      const set = {};
      for (const item of items) {
        // Items array in project are structured as
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

      console.log("[EXULU] Project search tool searching through contexts", Object.keys(set));
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
          console.log("[EXULU] Project search tool searching through items", itemIds);
          // Run retrieval over the items that are added to
          // the project.
          const result = await context.search({
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

          return {
            result: result.chunks.map((chunk: VectorSearchChunkResult) => ({
              ...chunk,
              context: {
                name: context.name,
                id: context.id,
              },
            })),
          };
        }),
      );

      // Todo for contexts that dont have an embedder fall back to keyword search.
      console.log("[EXULU] Project search tool results", results);
      return {
        result: JSON.stringify(results.flat()),
      };
    },
  });

  return projectRetrievalTool;
};
