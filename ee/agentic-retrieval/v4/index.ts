
import { z } from "zod";
import { getTableName, type ExuluContext } from "@SRC/exulu/context";
import type { ExuluReranker } from "@SRC/exulu/reranker";
import { ExuluTool } from "@SRC/exulu/tool";
import type { User } from "@EXULU_TYPES/models/user";
import type { LanguageModel } from "ai";
import { checkLicense } from "@EE/entitlements";
import { ContextSampler, type ContextSample } from "./context-sampler";
import { generateText, stepCountIs, tool, Output } from "ai";
import type { ExuluItem } from "@SRC/index";
import { withRetry } from "@SRC/utils/with-retry";
import { runAgentLoop } from "./agent-loop";
import type { AgenticRetrievalOutput } from "./types";
import { postgresClient } from "@SRC/postgres/client";
import type { SearchFilters } from "@SRC/graphql/types";
import path from "path";
import fs from "fs";

export interface ChunkResult {
    item_name: string;
    item_id: string;
    context?: {
        name: string;
        id: string;
    };
    chunk_id?: string;
    chunk_index?: number;
    chunk_content?: string;
    metadata?: Record<string, any>;
}

export type ContextRetrievalConfig = {
    context: ExuluContext;
    maxResults: number;
    maxSteps: number;
    expandChunks: number;
    items: { id: string; name: string; description: string; }[] | null;
    instructions: string | null;
    priority: number;
}

const DEFAULT_MAX_RESULTS = 10;
export const DEFAULT_MAX_STEPS = 5;

export type AgenticRetrievalLog = {
    start_tsp: string;
    end_tsp?: string;
    session: string;
    userQuery: string;
    entries: {
        label: string;
        timestamp: string;
        message: string;
    }[]
}

// Module-level sampler — shared across all tool instances so the cache is warm
// across requests within the same process.
const sampler = new ContextSampler();
const itemsCache = new Map<string, {
    item: ExuluItem;
    expiresAt: number;
}>();
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

const getItem = async (contextId: string, itemId: string): Promise<ExuluItem | undefined> => {
    const gid = contextId + "/" + itemId;

    // Check cache first
    const cached = itemsCache.get(gid);
    if (cached && Date.now() < cached.expiresAt) {
        return cached.item;
    }

    // Fetch from database if not cached or expired
    const { db } = await postgresClient();
    const tableName = getTableName(contextId);
    const item = await db.from(tableName).where({ id: itemId }).first() as ExuluItem;

    // Store in cache with expiry
    if (item) {
        itemsCache.set(gid, {
            item,
            expiresAt: Date.now() + CACHE_TTL_MS
        });
    }

    return item;
}

export async function parsePreselectedItems(preselected: string[]): Promise<Map<string, {
    id: string;
    name: string;
    description: string;
}[] | null>> {
    // Returns a map of context ids to item ids, if 
    // the entire context is selected the context
    // id is mapped to null or [].
    const map = new Map<string, { id: string; name: string; description: string; }[] | null>();
    for (const gid of preselected) {
        const slashIdx = gid.lastIndexOf("/");
        if (slashIdx === -1) {
            // No slash → entire context selected
            if (gid) map.set(gid, null);
            continue;
        }
        const contextId = gid.slice(0, slashIdx);
        const itemId = gid.slice(slashIdx + 1);
        if (!contextId || !itemId) continue;
        // Full-context entry already wins — don't downgrade to specific items
        if (map.get(contextId) === null) continue;
        const existing: { id: string; name: string; description: string; }[] = map.get(contextId) ?? [];
        const item = await getItem(contextId, itemId);
        existing.push({
            id: itemId,
            name: item?.name ?? "",
            description: item?.description ?? ""
        });
        map.set(contextId, existing);
    }
    return map;
}

/**
 * Creates the v4 ExuluTool for agentic context retrieval.
 */
export function createAgenticRetrievalToolV4({
    contexts,
    rerankers,
    user,
    role,
    model,
    preselected, // can be either entire contexts (<context_id>) or specific items (<context_id>/<item_id>)
    memoryItems // items retrieved from the agent's memory with a high relevance to the query passed to the agentic retrieval tool
}: {
    contexts: ExuluContext[];
    rerankers: ExuluReranker[];
    user?: User;
    role?: string;
    model?: LanguageModel;
    preselected?: string[];
    memoryItems?: ExuluItem[]
}): ExuluTool | undefined {

    const license = checkLicense();

    if (!license["agentic-retrieval"]) {
        console.warn("[EXULU] Not licensed for agentic retrieval");
        return undefined;
    }

    const contextNames = contexts.map((c) => c.id).join(", ");

    return ExuluTool.internal({
        id: "agentic_context_search",
        name: "Context Search",
        description: `Intelligent context search with query classification, strategy-based retrieval, and virtual filesystem filtering. Searches: ${contextNames}`,
        category: "contexts",
        needsApproval: false,
        type: "context",
        config: [
            {
                name: "reranker",
                description: "Reranker to use for result ranking",
                type: "string",
                default: "none",
            },
            {
                name: "managed_context",
                description: "Forces the user to explicitly define which items from which contexts the agentic retrieval tool will search in",
                type: "boolean",
                default: false,
            },
            {
                name: "logging",
                description: "Save a detailed markdown + JSON log of every retrieval execution to disk. Useful for debugging and evaluation.",
                type: "boolean",
                default: false,
            },
            ...contexts.map((ctx) => ({
                name: ctx.id + "_|_enabled",
                description: `Enable search in "${ctx.name}". ${ctx.description}`,
                type: "boolean" as const,
                default: true,
            }
            )),
            ...contexts.map((ctx) => ({
                name: `${ctx.id}_|_instructions`,
                description: `Instructions for the retrieval agent about how to search in the ${ctx.name} context`,
                type: "string" as const,
                default: "",
            })),
            ...contexts.map((ctx) => ({
                name: `${ctx.id}_|_priority`,
                description: `Defines in which order the context should be searched in, the higher the number the higher the priority, if contexts have the same priority they are searched in parallel`,
                type: "number" as const,
                default: 0,
            })),
            ...contexts.map((ctx) => ({
                name: `${ctx.id}_|_max_results`,
                description: `Defines the maximum number of results to return for the ${ctx.name} context`,
                type: "number" as const,
                default: 0,
            })),
            ...contexts.map((ctx) => ({
                name: `${ctx.id}_|_max_steps`,
                description: `Defines the maximum number of steps the agent is allowed to take when searching the ${ctx.name} context`,
                type: "number" as const,
                default: 0,
            })),
            ...contexts.map((ctx) => ({
                name: `${ctx.id}_|_expand_chunks`,
                description: `Defines if the agent automatically retrieves nearby chunks around the matched chunks, usefull if relevant content might be split up`,
                type: "number" as const,
                default: 0,
            }))
        ],
        inputSchema: z.object({
            userQuery: z.string().describe("The original unaltered question from the user"),
            userInstructions: z
                .string()
                .optional()
                .describe("Additional instructions from the user to guide retrieval"),
        }),
        execute: async function* ({
            userQuery,
            userInstructions,
            toolVariablesConfig,
            sessionID,
        }: {
            userQuery: string;
            userInstructions?: string;
            toolVariablesConfig?: Record<string, any>;
            sessionID?: string;
        }) {

            let log: AgenticRetrievalLog = {
                start_tsp: new Date().toISOString(),
                session: sessionID ?? "",
                userQuery: userQuery,
                entries: [],
            }

            if (!model) {
                yield { result: "Model is required for executing the agentic retrieval tool" };
                return;
            }

            if (!toolVariablesConfig) {
                yield { result: "No tool variables config found, please check if the tool is enabled and configured correctly." };
                return;
            }

            let reranker: ExuluReranker | undefined = toolVariablesConfig["reranker"] ? rerankers.find((r) => r.id === toolVariablesConfig["reranker"]) : undefined;
            let logging: boolean = checkTrue(toolVariablesConfig["logging"]);
            let managed: boolean = checkTrue(toolVariablesConfig["managed_context"]);

            log.entries.push({
                label: "Tool variables config",
                timestamp: new Date().toISOString(),
                message: JSON.stringify(toolVariablesConfig),
            });

            let active: Map<string, {
                items: { id: string; name: string; description: string; }[] | null;
                context: ExuluContext;
                instructions: string | null;
                maxResults: number;
                maxSteps: number;
                expandChunks: number;
                priority: number;
            } | null> = new Map(contexts.filter(
                (ctx) => checkTrue(toolVariablesConfig[ctx.id + "_|_enabled"])
            ).map(ctx => [ctx.id, {
                items: null,
                context: ctx,
                maxResults: toolVariablesConfig[ctx.id + "_|_max_results"] ?? DEFAULT_MAX_RESULTS,
                maxSteps: toolVariablesConfig[ctx.id + "_|_max_steps"] ?? DEFAULT_MAX_STEPS,
                expandChunks: toolVariablesConfig[ctx.id + "_|_expand_chunks"] ?? 0,
                instructions: toolVariablesConfig[ctx.id + "_|_instructions"] ?? "",
                priority: toolVariablesConfig[ctx.id + "_|_priority"] ?? 0,
            }]));

            log.entries.push({
                label: "Active contexts",
                timestamp: new Date().toISOString(),
                message: JSON.stringify(active),
            });

            if (!active.size) {
                console.log("[EXULU] No contexts are enabled for the agentic retrieval tool, let the user know that the admin needs to enable at least one context before the agentic retrieval tool can be used.");
                console.log("[EXULU] Log: ", log);
                yield { result: "No contexts are enabled for the agentic retrieval tool, let the user know that the admin needs to enable at least one context before the agentic retrieval tool can be used." };
                return;
            };

            if (
                managed &&
                !preselected?.length
            ) {
                console.log("[EXULU] Managed context was enabled for the agentic retrieval tool. This means that the user must preselect items that the agentic retrieval tool will search in, please notify the user to preselect items before executing the tool.");
                console.log("[EXULU] Log: ", log);
                yield { result: "Managed context was enabled for the agentic retrieval tool. This means that the user must preselect items that the agentic retrieval tool will search in, please notify the user to preselect items before executing the tool." };
                return;
            }

            if (preselected?.length) {

                const preselectedContextMap = await parsePreselectedItems(preselected);
                active = new Map(contexts.filter(ctx => preselectedContextMap.has(ctx.id)).map(ctx => [ctx.id, {
                    items: preselectedContextMap.get(ctx.id) ?? null,
                    context: ctx,
                    maxResults: toolVariablesConfig[ctx.id + "_|_max_results"] ?? DEFAULT_MAX_RESULTS,
                    maxSteps: toolVariablesConfig[ctx.id + "_|_max_steps"] ?? DEFAULT_MAX_STEPS,
                    expandChunks: toolVariablesConfig[ctx.id + "_|_expand_chunks"] ?? 0,
                    instructions: toolVariablesConfig[ctx.id + "_|_instructions"] ?? "",
                    priority: toolVariablesConfig[ctx.id + "_|_priority"] ?? 0,
                }]));

                log.entries.push({
                    label: "Preselected contexts",
                    timestamp: new Date().toISOString(),
                    message: JSON.stringify(active),
                });
            }

            for await (const output of execute({
                userQuery,
                log,
                activeContexts: active,
                reranker,
                model,
                user,
                role,
                sessionID: sessionID,
                memoryItems: memoryItems,
            })) {
                yield { result: JSON.stringify(output) };
            }

            if (logging) {
                log.end_tsp = new Date().toISOString();
                log.entries.push({
                    label: "Log completed",
                    timestamp: new Date().toISOString(),
                    message: "Log completed, writing to file",
                });
                const logDir = path.join(process.cwd(), "logs", "agentic-retrieval");
                const filePath = path.join(logDir, `${log.session}-${log.start_tsp}.json`);
                // Ensure directory exists before writing
                fs.mkdirSync(logDir, { recursive: true });
                fs.writeFileSync(filePath, JSON.stringify(log, null, 2));
                console.log(`[EXULU] Log written to ${filePath}`);
            }
            return;
        },
    });
}

const checkTrue = (value: any): boolean => {
    return value === true || value === "true" || value === 1 || value === "1";
}

async function* execute({
    userQuery,
    activeContexts,
    sessionID,
    reranker,
    model,
    user,
    role,
    log,
    memoryItems,
}: {
    log: AgenticRetrievalLog;
    userQuery: string;
    sessionID?: string;
    activeContexts: Map<string, {
        context: ExuluContext;
        items: { id: string; name: string; description: string; }[] | null;
        maxResults: number;
        maxSteps: number;
        expandChunks: number;
        instructions: string | null;
        priority: number;
    } | null>;
    reranker?: ExuluReranker;
    model: LanguageModel;
    user?: User;
    role?: string;
    memoryItems?: ExuluItem[];
}): AsyncGenerator<AgenticRetrievalOutput> {

    // ── Sample example records from each context (cached) ──────────────────
    console.log("[EXULU] v3 — sampling contexts");

    const samples: ContextSample[] = await sampler.getSamples(Array.from(
        activeContexts.values()).map(
            data => data?.context
        ).filter(
            ctx => ctx !== null
        ) as ExuluContext[], user, role);

    // -- Add sample records to each context's instructions --
    for (const [contextId, data] of activeContexts.entries()) {
        if (data?.context) {
            const sample = samples.find(sample => sample.contextId === contextId);
            log.entries.push({
                label: "Context sample for " + contextId,
                timestamp: new Date().toISOString(),
                message: JSON.stringify(sample),
            });
            if (sample) {
                data.instructions = `
                Custom instructions for this knowledge base:
                ${data.instructions ?? ""}
                
                Available item fields for this knowledge base:
                <item_fields>
                ${sample.fields.join(", ")}
                </item_fields>

                Example records for this knowledge base:
                <item_records>
                ${sample.exampleItems.map(item => JSON.stringify(item)).join("\n")}
                </item_records>

                Relevant memories for this knowledge base (these are things the agent has learned from past conversations with the user):
                <relevant_memories>
                ${memoryItems?.map(item => JSON.stringify(item)).join("\n")}
                </relevant_memories>
            }
            `; // todo find a way to add glossary and general company information to the instructions
            }
            log.entries.push({
                label: "Updated context instructions for " + contextId,
                timestamp: new Date().toISOString(),
                message: data.instructions ?? "",
            });
        }
    }

    const prioritized = new Map<number, ContextRetrievalConfig[]>();

    for (const [_contextId, data] of activeContexts.entries()) {
        // Map the payload to a priority in the map, i.e. priority 1 could be
        // 2 context payloads if they have the same priority, the higher the priority 
        // the higher the priority in the map
        if (!data) continue;
        const priority = data.priority || 0;
        if (prioritized.has(priority)) {
            prioritized.get(priority)?.push(data);
        } else {
            prioritized.set(priority, [data]);
        }
    }

    for (const [_priority, contexts] of prioritized.entries()) {

        // Process contexts sequentially to allow yielding results as they come
        for (const data of contexts) {
            const search = tool({
                description: `
                Search '${data.context.name}' knowledge base for relevant information based on the user's question.`,
                inputSchema: z.object({
                    resultType: z.enum(["list", "count", "content"]).describe(`
                        The type of results to return:
                        - list: return a list of items with basic data such as their name and id
                        - count: return the number of items
                        - content: return the content of the items, this is the default if no result type is specified
                    `).default("content"),
                    userQuery: z.string().describe("The original unaltered question from the user."),
                    limit: z
                        .number()
                        .default(DEFAULT_MAX_RESULTS)
                        .describe(`The maximum number of results to return, can be a maximum of ${data.maxResults || DEFAULT_MAX_RESULTS}.`),
                }),
                execute: async ({
                    resultType,
                    userQuery,
                    limit,
                }) => {

                    let effectiveLimit = Math.min(limit ?? data.maxResults, data.maxResults);
                    const ctx = data.context;
                    const includeContent = resultType === "content";

                    try {
                        let itemFilters: SearchFilters = [];

                        if (data.items) {
                            itemFilters.push({ id: { in: data.items.map(item => item.id) } });
                        }

                        const { chunks } = await ctx.search({
                            query: userQuery,
                            keywords: [],
                            method: "hybridSearch",
                            limit: effectiveLimit,
                            page: 1,
                            itemFilters: itemFilters,
                            chunkFilters: [],
                            sort: { field: "updatedAt", direction: "desc" },
                            user,
                            role,
                            trigger: "tool",
                            expand: data.expandChunks ? {
                                before: data.expandChunks,
                                after: data.expandChunks,
                            } : undefined,
                        });

                        let stepChunks =
                            chunks.map(
                                (chunk): ChunkResult => ({
                                    item_name: chunk.item_name,
                                    item_id: chunk.item_id,
                                    context: {
                                        name: chunk.context?.name ?? "",
                                        id: chunk.context?.id ?? ctx.id
                                    },
                                    chunk_id: chunk.chunk_id,
                                    chunk_index: chunk.chunk_index,
                                    chunk_content: includeContent ? chunk.chunk_content : undefined,
                                    metadata: {
                                        ...chunk.chunk_metadata,
                                        cosine_distance: chunk.chunk_cosine_distance,
                                        fts_rank: chunk.chunk_fts_rank,
                                        hybrid_score: chunk.chunk_hybrid_score,
                                    },
                                }),
                            )

                        return JSON.stringify(stepChunks);
                    } catch (err) {
                        console.error(`[EXULU] search_content failed for context "${ctx.id}":`, err);
                        return JSON.stringify([]);
                    }
                },
            });

            const system_prompt = `
                You are an information retrieval assistant. Your job is to retrieve all relevant information from
                the '${data.context.name}' knowledge base and return it. You do NOT answer the user's question yourself —
                another agent will do that based on what you retrieve.
            `;

            const user_prompt = `
                The user has asked the following question:
                <user_query>
                ${userQuery}
                </user_query>

                ${data.items ? `
                The user has also preselected the following items to search in, these will be automatically included as a prefilter
                in the search tool.
                <preselected_items>
                ${data.items?.map(item => `${item.id} - ${item.name} ${item.description ? `- ${item.description}` : ""}`).join("\n")}
                </preselected_items>
                ` : ""}

                You have the following instructions for this context to help you understand what this knowledge base
                and how to search it, these are very important, and should be followed strictly:
                <instructions>
                ${data.instructions}
                </instructions>

                Please come up with a plan / todo list of steps to retrieve the information
                the user is looking for.

                The plan / todo list should be a JSON array of objects with the following fields:

                - status: "planned" | "completed"
                - description: string

                The description should be a short description of the step you need to take to retrieve the information
                the user is looking for.

                You have one tool available called "search" that you can use to search the knowledge base. It takes
                the following parameters:

                - resultType: "list" | "count" | "content"
                - userQuery: string
                - limit: number (currently set to a maximum of ${data.maxResults || DEFAULT_MAX_RESULTS})

                The resultType determines the type of results you want to retrieve:
                - list: return a list of items with basic data such as their name and id
                - count: return the number of items
                - content: return the content of the items, this is the default if no result type is specified

                The final todo MUST be to call the finish_retrieval tool to signal that retrieval is complete.
            `;

            log.entries.push({
                label: "Created plan prompt for context " + data.context.id,
                timestamp: new Date().toISOString(),
                message: `
                ${system_prompt}
                ${user_prompt}
                `,
            });

            const { output } = await withRetry(() =>
                generateText({
                    model,
                    temperature: 0,
                    system: system_prompt,
                    messages: [{ role: "user", content: user_prompt }],
                    output: Output.object({
                        schema: z.object({
                            todos: z.array(z.object({
                                status: z.enum(["planned", "completed"]),
                                description: z.string(),
                                tool: z.string(),
                            })),
                        }),
                    }),
                    stopWhen: stepCountIs(3),
                }),
            );

            // todo add tokens to total

            log.entries.push({
                label: "Created plan for context " + data.context.id,
                timestamp: new Date().toISOString(),
                message: JSON.stringify(output.todos),
            });

            // 2. Loop the agent, execute a step, then evaluate the todo list, and move on to the next
            // step until the todo list is completed or the max number of steps is reached.

            let finalOutput: AgenticRetrievalOutput | undefined;
            let executionError: Error | undefined;

            try {
                for await (const result of runAgentLoop({
                    userQuery,
                    sessionID,
                    log,
                    todos: output.todos.map((todo, index) => ({
                        status: todo.status,
                        description: todo.description,
                        current: index === 0,
                    })),
                    config: data,
                    tools: {
                        search: search,
                    },
                    model,
                    reranker,
                    onStepComplete: (step) => log.entries.push({
                        label: "Step completed",
                        timestamp: new Date().toISOString(),
                        message: JSON.stringify(step),
                    })
                })) {
                    finalOutput = result;
                    yield result;
                }

            } catch (err) {
                executionError = err as Error;
                console.error("[EXULU] v3 — agent loop error:", err);
                throw err;
            } finally {
                if (finalOutput) {
                    log.entries.push({
                        label: "Final output",
                        timestamp: new Date().toISOString(),
                        message: JSON.stringify(finalOutput),
                    });
                }
                if (executionError) {
                    log.entries.push({
                        label: "Execution error",
                        timestamp: new Date().toISOString(),
                        message: JSON.stringify(executionError),
                    });
                }
            }
        }
    }
}


// todos
// within the agentic loops use a global plimit to manage 
// concurrent context search llm call rate limiting.