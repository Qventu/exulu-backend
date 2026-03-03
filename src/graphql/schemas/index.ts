import type { ExuluTableDefinition } from "src/exulu/routes";
import { mapExuluFieldTypesToGraphqlTypes } from "src/graphql/utilities/map-types";
import { makeExecutableSchema } from "@graphql-tools/schema";
import GraphQLJSON from "graphql-type-json";
import cron from "cron-validator";
import {
  ExuluAgent,
  ExuluEval,
  ExuluReranker,
  ExuluTool,
  type ExuluContext,
  type ExuluQueueConfig,
  type ExuluWorkflow,
} from "src/exulu/classes.ts";
import { sanitizeName } from "src/utils/sanitize-name.ts";
import { postgresClient } from "src/postgres/client.ts";
import { loadAgent, loadAgents } from "src/utils/load-agent.ts";
import { checkRecordAccess } from "src/utils/check-record-access.ts";
import type { Agent } from "@EXULU_TYPES/models/agent";
import type { EvalRun } from "@EXULU_TYPES/models/eval-run";
import type { ExuluConfig } from "src/exulu/app/index.ts";
import type { Queue } from "bullmq";
import { ExuluQueues } from "src/index.ts";
import { redisClient as getRedisClient } from "src/redis/client.ts";
import type { BullMqJobData } from "src/bullmq/decorator.ts";
import { v4 as uuidv4 } from "uuid";
import { JOB_STATUS_ENUM } from "@EXULU_TYPES/enums/jobs";
import { processUiMessagesFlow, validateWorkflowPayload } from "src/exulu/workers.ts";
import type { UIMessage } from "ai";
import { createAgenticRetrievalTool } from "src/templates/tools/agentic-retrieval/index.ts";
import { GraphQLDate } from "src/graphql/types";
import { getRequestedFields } from "src/graphql/resolvers/utils";
import { applyAccessControl } from "src/graphql/utilities/access-control";
import { RBACResolver } from "src/graphql/resolvers/rbac-resolver";
import { createQueries } from "src/graphql/resolvers";
import { convertContextToTableDefinition } from "src/graphql/utilities/convert-context-to-table-definition";
import { getJobsByQueueName } from "../resolvers/job-queues";
import { createMutations } from "../mutations";

/* 
Auto generate schemas based on Exulu Table definitions in core-schema.ts
and the fields provided by the implementation at the customer through 
ExuluContext.
*/
function createExuluContextsTypeDefs(table: ExuluTableDefinition): string {
  // Generate enum definitions for enum fields
  const enumDefs = table.fields
    .filter((field) => field.type === "enum" && field.enumValues)
    .map((field) => {
      // @ts-ignore
      const enumValues = field.enumValues
        .map((value) => {
          // Convert enum values to valid GraphQL identifiers
          const sanitized = String(value)
            .replace(/[^a-zA-Z0-9_]/g, "_")
            .replace(/^[0-9]/, "_$&")
            .toUpperCase();
          return `  ${sanitized}`;
        })
        .join("\n");
      return `
  enum ${field.name}Enum {
  ${enumValues}
  }`;
    })
    .join("\n");

  let fields = table.fields.map((field) => {
    let type: string;
    type = mapExuluFieldTypesToGraphqlTypes(field);
    const required = field.required ? "!" : "";
    return `  ${field.name}: ${type}${required}`;
  });

  if (table.type === "items") {
    fields.push("  averageRelevance: Float");
    fields.push("  totalRelevance: Float");
    fields.push("  chunks: [ItemChunks]");
  }

  if (table.name.singular === "agent") {
    fields.push("  providerName: String");
    fields.push("  modelName: String");
    fields.push("  rateLimit: RateLimiterRule");
    fields.push("  streaming: Boolean");
    fields.push("  capabilities: AgentCapabilities");
    fields.push("  maxContextLength: Int");
    fields.push("  provider: String");
    fields.push("  authenticationInformation: String");
    fields.push("  systemInstructions: String");
    fields.push("  workflows: AgentWorkflows");
    fields.push("  slug: String");
  }

  if (table.name.singular === "workflow_template") {
    fields.push("  variables: [String]");
  }

  // Add RBAC field if enabled
  const rbacField = table.RBAC ? "  RBAC: RBACData" : "";

  // Allow defining a custom id type (for example the users entity has type number because of next-auth)
  const typeDef = `
    type ${table.name.singular} {
    ${fields.join("\n")}
      ${table.fields.find((field) => field.name === "id") ? "" : "id: ID!"}
  ${rbacField}
    }
    `;

  // Add RBAC input field if enabled
  const rbacInputField = table.RBAC ? "  RBAC: RBACInput" : "";

  const inputDef = `
  input ${table.name.singular}Input {
  ${table.fields.map((f) => `  ${f.name}: ${mapExuluFieldTypesToGraphqlTypes(f)}`).join("\n")}
  ${rbacInputField}
  }
  `;

  return enumDefs + typeDef + inputDef;
}

function createExuluContextsFilterTypeDefs(table: ExuluTableDefinition): string {
  const fieldFilters = table.fields.map((field) => {
    let type: string;
    if (field.type === "enum" && field.enumValues) {
      type = `${field.name}Enum`;
    } else {
      type = mapExuluFieldTypesToGraphqlTypes(field);
    }
    return `
    ${field.name}: FilterOperator${type}`;
  });

  let operatorTypes = "";
  let enumFilterOperators: string[] = [];
  const tableNameSingularUpperCaseFirst =
    table.name.singular.charAt(0).toUpperCase() + table.name.singular.slice(1);

  // Create enum-specific filter operators
  enumFilterOperators = table.fields
    .filter((field) => field.type === "enum" && field.enumValues)
    .map((field) => {
      const enumTypeName = `${field.name}Enum`;
      return `
  input FilterOperator${enumTypeName} {
    eq: ${enumTypeName}
    ne: ${enumTypeName}
    in: [${enumTypeName}]
    and: [FilterOperator${enumTypeName}]
    or: [FilterOperator${enumTypeName}]
  }`;
    });

  // Create filter operator types for each field type
  operatorTypes += `
  input FilterOperatorString {
    eq: String
    ne: String
    in: [String]
    contains: String
    and: [FilterOperatorString]
    or: [FilterOperatorString]
  }
  
  input FilterOperatorDate {
    lte: Date
    gte: Date
    and: [FilterOperatorDate]
    or: [FilterOperatorDate]
  }
  
  input FilterOperatorFloat {
    eq: Float
    ne: Float
    lte: Float
    gte: Float
    in: [Float]
    and: [FilterOperatorFloat]
    or: [FilterOperatorFloat]
  }
  
  input FilterOperatorBoolean {
    eq: Boolean
    ne: Boolean
    in: [Boolean]
    and: [FilterOperatorBoolean]
    or: [FilterOperatorBoolean]
  }
  
  input FilterOperatorJSON {
    eq: JSON
    ne: JSON
    in: [JSON]
    contains: JSON
  }
  
  input SortBy {
    field: String!
    direction: SortDirection!
  }
  
  enum SortDirection {
    ASC
    DESC
  }
  
  ${enumFilterOperators.join("\n")}
  
  input Filter${tableNameSingularUpperCaseFirst} {
  ${fieldFilters.join("\n")}
  }`;

  return operatorTypes;
}

export function createSDL(
  tables: ExuluTableDefinition[],
  contexts: ExuluContext[],
  agents: ExuluAgent[],
  tools: ExuluTool[],
  config: ExuluConfig,
  evals: ExuluEval[],
  queues: {
    queue: Queue;
    ratelimit: number;
    concurrency: {
      worker: number;
      queue: number;
    };
    timeoutInSeconds?: number;
  }[],
  rerankers: ExuluReranker[],
) {
  const contextSchemas: ExuluTableDefinition[] = contexts.map((context) =>
    convertContextToTableDefinition(context),
  );

  // Adding fields to SDL that are not defined via
  // ExuluContext instances but added in the
  // backend at createItemsTable().
  tables.forEach((table) => {
    if (!table.fields.some((field) => field.name === "createdAt")) {
      table.fields.push({
        name: "createdAt",
        type: "date",
      });
    }
    if (!table.fields.some((field) => field.name === "updatedAt")) {
      table.fields.push({
        name: "updatedAt",
        type: "date",
      });
    }
  });

  tables = [...tables, ...contextSchemas];

  console.log("[EXULU] Creating SDL.");
  let typeDefs = `
    scalar JSON
    scalar Date

    type RBACData {
      type: String!
      users: [RBACUser!]
      roles: [RBACRole!]

    }

    type RBACUser {
      id: ID!
      rights: String!
    }

    type RBACRole {
      id: ID!
      rights: String!
    }

    input RBACInput {
      users: [RBACUserInput!]
      roles: [RBACRoleInput!]
    }

    input RBACUserInput {
      id: ID!
      rights: String!
    }

    input RBACRoleInput {
      id: ID!
      rights: String!
    }

    type Query {
    `;

  let mutationDefs = `
    type Mutation {
    `;

  let modelDefs = "";
  const resolvers = {
    JSON: GraphQLJSON,
    Date: GraphQLDate,
    Query: {},
    Mutation: {},
  };

  // todo add the contexts from Exulu to the schema and then remove from the REST API make sure to also check if user has
  //   read / write access to the contexts table
  for (const table of tables) {
    // Skip tables with graphql: false
    if (table.graphql === false) {
      continue;
    }
    const tableNamePlural = table.name.plural.toLowerCase();
    const tableNameSingular = table.name.singular.toLowerCase();
    const tableNameSingularUpperCaseFirst =
      table.name.singular.charAt(0).toUpperCase() + table.name.singular.slice(1);

    typeDefs += `
        ${
          tableNameSingular === "agent"
            ? `${tableNameSingular}ById(id: ID!, project: ID): ${tableNameSingular}`
            : `${tableNameSingular}ById(id: ID!): ${tableNameSingular}`
        }

      ${tableNameSingular}ByIds(ids: [ID!]!): [${tableNameSingular}]!
      ${tableNamePlural}Pagination(limit: Int, page: Int, filters: [Filter${tableNameSingularUpperCaseFirst}], sort: SortBy): ${tableNameSingularUpperCaseFirst}PaginationResult
      ${tableNameSingular}One(filters: [Filter${tableNameSingularUpperCaseFirst}], sort: SortBy): ${tableNameSingular}
      ${tableNamePlural}Statistics(filters: [Filter${tableNameSingularUpperCaseFirst}], groupBy: String, limit: Int): [StatisticsResult]!
    `;
    if (table.type === "items") {
      typeDefs += `
      ${tableNamePlural}VectorSearch(query: String!, method: VectorMethodEnum!, itemFilters: [Filter${tableNameSingularUpperCaseFirst}], cutoffs: SearchCutoffs, expand: SearchExpand): ${tableNameSingular}VectorSearchResult
      ${tableNameSingular}ChunkById(id: ID!): ${tableNameSingular}VectorSearchChunk
    `;
    }
    // todo add the fields of each table as filter options
    mutationDefs += `
      ${tableNamePlural}CreateOne(input: ${tableNameSingular}Input!, upsert: Boolean): ${tableNameSingular}MutationPayload
      ${tableNamePlural}CopyOneById(id: ID!): ${tableNameSingular}MutationPayload

      ${tableNamePlural}UpdateOne(where: [Filter${tableNameSingularUpperCaseFirst}], input: ${tableNameSingular}Input!): ${tableNameSingular}MutationPayload
      ${tableNamePlural}UpdateOneById(id: ID!, input: ${tableNameSingular}Input!): ${tableNameSingular}MutationPayload
      ${tableNamePlural}RemoveOneById(id: ID!): ${tableNameSingular}
      ${tableNamePlural}RemoveOne(where: JSON!): ${tableNameSingular}
    `;

    if (table.type === "items") {
      mutationDefs += `
    ${tableNameSingular}GenerateChunks(where: [Filter${tableNameSingularUpperCaseFirst}], limit: Int): ${tableNameSingular}GenerateChunksReturnPayload
    ${tableNameSingular}ExecuteSource(source: ID!, inputs: JSON!): ${tableNameSingular}ExecuteSourceReturnPayload
    ${tableNameSingular}DeleteChunks(where: [Filter${tableNameSingularUpperCaseFirst}], limit: Int): ${tableNameSingular}DeleteChunksReturnPayload
    `;

      if (table.processor) {
        mutationDefs += `
    ${tableNameSingular}ProcessItem(item: ID!): ${tableNameSingular}ProcessItemFieldReturnPayload
    ${tableNameSingular}ProcessItems(limit: Int, filters: [Filter${tableNameSingularUpperCaseFirst}], sort: SortBy): ${tableNameSingular}ProcessItemFieldReturnPayload
    `;
      }

      modelDefs += `
    type ${tableNameSingular}GenerateChunksReturnPayload {
        message: String!
        items: Int!
        jobs: [String!]
    }

    type ${tableNameSingular}ExecuteSourceReturnPayload {
        message: String!
        jobs: [String!]
        items: [String!]
    }

    type ${tableNameSingular}ProcessItemFieldReturnPayload {
        message: String!
        results: [String]
        jobs: [String]
    }

    type ${tableNameSingular}DeleteChunksReturnPayload {
        message: String!
        items: Int!
        jobs: [String!]
    }

    enum VectorMethodEnum {
        cosineDistance
        hybridSearch
        tsvector
    }

    input SearchCutoffs {
        cosineDistance: Float
        hybrid: Float
        tsvector: Float
    }

    input SearchExpand {
        before: Int
        after: Int
    }

    type ${tableNameSingular}VectorSearchResult {
        chunks: [${tableNameSingular}VectorSearchChunk!]!
        context: VectoSearchResultContext!
        itemFilters: JSON!
        chunkFilters: JSON!
        query: String!
        method: VectorMethodEnum!
    }

    type ${tableNameSingular}VectorSearchChunk {
        chunk_content: String
        chunk_index: Int
        chunk_id: String
        chunk_source: String
        chunk_metadata: JSON
        chunk_created_at: Date
        chunk_updated_at: Date
        item_updated_at: Date
        item_created_at: Date
        item_id: String!
        item_external_id: String
        item_name: String!
        chunk_cosine_distance: Float
        chunk_fts_rank: Float
        chunk_hybrid_score: Float
    }

    type VectoSearchResultContext {
        name: String!
        id: ID!
        embedder: String!
    }

`;
    }

    modelDefs += createExuluContextsTypeDefs(table);
    modelDefs += createExuluContextsFilterTypeDefs(table);

    modelDefs += `type ${tableNameSingular}MutationPayload {
        item: ${tableNameSingular}!
        job: String
      }`;
    modelDefs += `
type ${tableNameSingularUpperCaseFirst}PaginationResult {
  pageInfo: PageInfo!
  items: [${tableNameSingular}]!
}
type PageInfo {
  pageCount: Int!
  itemCount: Int!
  currentPage: Int!
  hasPreviousPage: Boolean!
  hasNextPage: Boolean!
}
`;
    Object.assign(resolvers.Query, createQueries(table, agents, tools, contexts, rerankers));
    Object.assign(
      resolvers.Mutation,
      createMutations(table, agents, contexts, rerankers, tools, config),
    );

    // Add RBAC resolver if enabled
    if (table.RBAC) {
      const rbacResolverName = table.name.singular;
      if (!resolvers[rbacResolverName]) {
        resolvers[rbacResolverName] = {};
      }
      resolvers[rbacResolverName].RBAC = async (parent: any, args: any, context: any) => {
        const { db } = context;
        const resourceId = parent.id;
        const entityName = table.name.singular;
        const rights_mode = parent.rights_mode;
        return RBACResolver(db, entityName, resourceId, rights_mode);
      };
    }
  }

  // add additional resolvers
  typeDefs += `
   providers: ProviderPaginationResult
    `;

  typeDefs += `
    workflowSchedule(workflow: ID!): WorkflowScheduleResult
    `;

  typeDefs += `
    queue(queue: QueueEnum!): QueueResult
    `;

  typeDefs += `
    evals: EvalPaginationResult
    `;

  typeDefs += `
    contexts: ContextPaginationResult
    `;

  typeDefs += `
    rerankers: RerankerPaginationResult
    `;

  typeDefs += `
    contextById(id: ID!): Context
    `;

  typeDefs += `
    getUniquePromptTags: [String!]!
    `;

  mutationDefs += `
    runEval(id: ID!, test_case_ids: [ID!]): RunEvalReturnPayload
    `;

  mutationDefs += `
    runWorkflow(id: ID!, variables: JSON): RunWorkflowReturnPayload
    `;

  mutationDefs += `
    upsertWorkflowSchedule(workflow: ID!, schedule: String!): WorkflowScheduleReturnPayload
    `;

  mutationDefs += `
    deleteWorkflowSchedule(workflow: ID!): WorkflowScheduleReturnPayload
    `;

  mutationDefs += `
    drainQueue(queue: QueueEnum!): JobActionReturnPayload
    `;

  mutationDefs += `
    pauseQueue(queue: QueueEnum!): JobActionReturnPayload
    `;
  mutationDefs += `
    resumeQueue(queue: QueueEnum!): JobActionReturnPayload
    `;

  mutationDefs += `
    deleteJob(queue: QueueEnum!, id: String!): JobActionReturnPayload
    `;

  typeDefs += `
   tools(search: String, category: String, limit: Int, page: Int): ToolPaginationResult
   toolCategories: [String!]!
    `;

  typeDefs += `
   jobs(queue: QueueEnum!, statusses: [JobStateEnum!], page: Int, limit: Int): JobPaginationResult
    `;

  resolvers.Query["providers"] = async (_, args, context, info) => {
    const requestedFields = getRequestedFields(info);
    return {
      items: agents.map((agent) => {
        const object = {};
        requestedFields.forEach((field) => {
          object[field] = agent[field];
        });
        return object;
      }),
    };
  };

  resolvers.Query["workflowSchedule"] = async (_, args, context, info) => {
    // Creates a scheduled workflow execution, takes args.workflow (id) args.queue and args.schedule and args.variables

    if (!args.workflow) {
      throw new Error("Workflow template ID is required");
    }

    console.log("[EXULU] /workflows/run/:id", args.id);
    const user = context.user;
    const workflow_template_id = args.workflow;

    const { db } = await postgresClient();

    // Fetch the workflow template
    const workflowTemplate: ExuluWorkflow = await db
      .from("workflow_templates")
      .where({ id: workflow_template_id })
      .first();

    if (!workflowTemplate) {
      throw new Error("Workflow template not found in database.");
    }

    // Check RBAC access to workflow template
    const hasAccessToWorkflowTemplate = await checkRecordAccess(workflowTemplate, "write", user);

    if (!hasAccessToWorkflowTemplate) {
      throw new Error("You don't have access to this workflow template.");
    }

    // Get all variables {variable_name} from the UI Messages
    // Replace them with the values in args.variables
    // If any are missing, throw an error

    // Load the agent instance to validate it exists
    const agentInstance = await loadAgent(workflowTemplate.agent);
    if (!agentInstance) {
      throw new Error("Agent instance not found for workflow template.");
    }

    const agentBackend = agents.find((agent) => agent.id === agentInstance.backend);

    if (!agentBackend) {
      throw new Error(
        "Agent backend: " +
          agentInstance.backend +
          " not found for agent instance " +
          agentInstance.id +
          ".",
      );
    }

    let queue: ExuluQueueConfig | undefined;

    if (agentBackend?.workflows?.queue) {
      queue = await agentBackend.workflows.queue;
      const scheduler = await queue.queue?.getJobScheduler(args.workflow + "-workflow-schedule");
      if (scheduler) {
        return {
          id: scheduler.id,
          schedule: scheduler.pattern,
          next: scheduler.next,
          iteration: scheduler.iterationCount,
        };
      }
    }

    return {
      id: undefined,
      schedule: undefined,
      next: undefined,
      iteration: undefined,
    };
  };

  resolvers.Query["queue"] = async (_, args, context, info) => {
    if (!args.queue) {
      throw new Error("Queue name is required");
    }
    const queue = ExuluQueues.list.get(args.queue);
    if (!queue) {
      throw new Error("Queue not found");
    }
    const config = await queue.use();
    return {
      name: config.queue.name,
      concurrency: {
        worker: config.concurrency?.worker || undefined,
        queue: config.concurrency?.queue || undefined,
      },
      timeoutInSeconds: config.timeoutInSeconds,
      ratelimit: config.ratelimit,
      isMaxed: await config.queue.isMaxed(),
      isPaused: await config.queue.isPaused(),
      jobs: {
        paused: await config.queue.isPaused(),
        completed: await config.queue.getJobCountByTypes("completed"),
        failed: await config.queue.getJobCountByTypes("failed"),
        waiting: await config.queue.getJobCountByTypes("waiting"),
        active: await config.queue.getJobCountByTypes("active"),
        delayed: await config.queue.getJobCountByTypes("delayed"),
      },
    };
  };

  resolvers.Mutation["deleteWorkflowSchedule"] = async (_, args, context, info) => {
    // Creates a scheduled workflow execution, takes args.workflow (id) args.queue and args.schedule and args.variables

    if (!args.workflow) {
      throw new Error("Workflow template ID is required");
    }

    console.log("[EXULU] /workflows/run/:id", args.workflow);
    const user = context.user;
    const workflow_template_id = args.workflow;

    const { db } = await postgresClient();

    // Fetch the workflow template
    const workflowTemplate: ExuluWorkflow = await db
      .from("workflow_templates")
      .where({ id: workflow_template_id })
      .first();

    if (!workflowTemplate) {
      throw new Error("Workflow template not found in database.");
    }

    // Check RBAC access to workflow template
    const hasAccessToWorkflowTemplate = await checkRecordAccess(workflowTemplate, "write", user);

    if (!hasAccessToWorkflowTemplate) {
      throw new Error("You don't have access to this workflow template.");
    }

    // Get all variables {variable_name} from the UI Messages
    // Replace them with the values in args.variables
    // If any are missing, throw an error

    // Load the agent instance to validate it exists
    const agentInstance = await loadAgent(workflowTemplate.agent);
    if (!agentInstance) {
      throw new Error("Agent instance not found for workflow template.");
    }

    const agentBackend = agents.find((agent) => agent.id === agentInstance.backend);

    if (!agentBackend) {
      throw new Error(
        "Agent backend: " +
          agentInstance.backend +
          " not found for agent instance " +
          agentInstance.id +
          ".",
      );
    }

    let queue: ExuluQueueConfig | undefined;

    if (agentBackend?.workflows?.queue) {
      queue = await agentBackend.workflows.queue;
      await queue.queue?.removeJobScheduler(args.workflow + "-workflow-schedule");
      return {
        status: "deleted",
      };
    }

    return {
      status: "not found",
    };
  };
  resolvers.Mutation["upsertWorkflowSchedule"] = async (_, args, context, info) => {
    // Creates a scheduled workflow execution, takes args.workflow (id) args.queue and args.schedule and args.variables

    if (!args.workflow) {
      throw new Error("Workflow template ID is required");
    }

    if (!args.schedule) {
      throw new Error("Schedule is required");
    }

    console.log("[EXULU] /workflows/run/:id", args.workflow);
    const user = context.user;
    const workflow_template_id = args.workflow;

    const { db } = await postgresClient();

    // Fetch the workflow template
    const workflowTemplate: ExuluWorkflow = await db
      .from("workflow_templates")
      .where({ id: workflow_template_id })
      .first();

    if (!workflowTemplate) {
      throw new Error("Workflow template not found in database.");
    }

    // Check RBAC access to workflow template
    const hasAccessToWorkflowTemplate = await checkRecordAccess(workflowTemplate, "write", user);

    if (!hasAccessToWorkflowTemplate) {
      throw new Error("You don't have access to this workflow template.");
    }

    // Get all variables {variable_name} from the UI Messages
    // Replace them with the values in args.variables
    // If any are missing, throw an error

    // Load the agent instance to validate it exists
    const agentInstance = await loadAgent(workflowTemplate.agent);
    if (!agentInstance) {
      throw new Error("Agent instance not found for workflow template.");
    }

    const agentBackend = agents.find((agent) => agent.id === agentInstance.backend);

    if (!agentBackend) {
      throw new Error(
        "Agent backend: " +
          agentInstance.backend +
          " not found for agent instance " +
          agentInstance.id +
          ".",
      );
    }

    let queue: ExuluQueueConfig | undefined;

    if (agentBackend?.workflows?.queue) {
      queue = await agentBackend.workflows.queue;
    }

    const jobData: BullMqJobData = {
      label: `Workflow Run ${workflow_template_id}`,
      trigger: "api",
      timeoutInSeconds: queue?.timeoutInSeconds || 180, // default to 3 minutes
      type: "workflow",
      workflow: workflow_template_id,
      inputs: args.variables,
      user: user.id,
      role: user.role?.id,
    };

    if (!queue) {
      throw new Error(
        "Queue not found for agent backend: " +
          agentBackend?.id +
          " for workflow template: " +
          workflow_template_id,
      );
    }

    // Verify cron schedule is valid
    if (!cron.isValidCron(args.schedule)) {
      throw new Error("Invalid cron schedule: " + args.schedule);
    }

    // Create jobs every day at 3:15 (am)
    const firstJob = await queue.queue?.upsertJobScheduler(
      workflow_template_id + "-workflow-schedule",
      { pattern: args.schedule },
      {
        name: "my-job-name",
        data: jobData,
        opts: {
          backoff: queue?.backoff,
          attempts: queue?.retries || 3,
          removeOnFail: 200,
        },
      },
    );

    return {
      status: "created",
      job: firstJob.id,
    };
  };

  resolvers.Mutation["runWorkflow"] = async (_, args, context, info) => {
    console.log("[EXULU] /workflows/run/:id", args.id);
    const user = context.user;
    const workflow_template_id = args.id;

    const { db } = await postgresClient();

    // Fetch the workflow template
    const workflowTemplate: ExuluWorkflow = await db
      .from("workflow_templates")
      .where({ id: workflow_template_id })
      .first();

    if (!workflowTemplate) {
      throw new Error("Workflow template not found in database.");
    }

    // Check RBAC access to workflow template
    const hasAccessToWorkflowTemplate = await checkRecordAccess(workflowTemplate, "write", user);

    if (!hasAccessToWorkflowTemplate) {
      throw new Error("You don't have access to this workflow template.");
    }

    // Get all variables {variable_name} from the UI Messages
    // Replace them with the values in args.variables
    // If any are missing, throw an error

    // Load the agent instance to validate it exists
    const agentInstance = await loadAgent(workflowTemplate.agent);
    if (!agentInstance) {
      throw new Error("Agent instance not found for workflow template.");
    }

    const agentBackend = agents.find((agent) => agent.id === agentInstance.backend);

    if (!agentBackend) {
      throw new Error(
        "Agent backend: " +
          agentInstance.backend +
          " not found for agent instance " +
          agentInstance.id +
          ".",
      );
    }

    let queue: ExuluQueueConfig | undefined;
    if (agentBackend?.workflows?.queue) {
      queue = await agentBackend.workflows.queue;
    }

    const jobData: BullMqJobData = {
      label: `Workflow Run ${workflow_template_id}`,
      trigger: "api",
      timeoutInSeconds: queue?.timeoutInSeconds || 180, // default to 3 minutes
      type: "workflow",
      workflow: workflow_template_id,
      inputs: args.variables,
      user: user.id,
      role: user.role?.id,
    };

    if (queue) {
      const redisId = uuidv4();

      // Create job with type "eval" - worker will handle running agent + creating eval function jobs
      const job = await queue.queue.add("eval_run", jobData, {
        jobId: redisId,
        // Setting it to 3 as a sensible default, as
        // many AI services are quite unstable.
        attempts: queue.retries || 1,
        removeOnComplete: 5000,
        removeOnFail: 10000,
        backoff: queue.backoff || {
          type: "exponential",
          delay: 2000,
        },
      });

      return {
        result: undefined,
        job: job.id,
        metadata: undefined,
      };
    } else {
      console.log("[EXULU] running a workflow directly without queue.", jobData.label);

      const label = `workflow-run-${workflow_template_id}`;

      const jobResult = await db
        .from("job_results")
        .insert({
          job_id: undefined,
          label: label,
          state: "active",
          result: null,
          metadata: {},
          tries: 1,
        })
        .returning("id");

      const jobResultId = jobResult[0].id;

      try {
        const {
          agentInstance,
          backend: agentBackend,
          user,
          messages: inputMessages,
        } = await validateWorkflowPayload(jobData, agents);

        const retries = 3;
        let attempts = 0;

        // todo allow setting queue on agent backend and then create a job with type "agent"
        const promise = new Promise<{
          messages: UIMessage[];
          metadata: {
            tokens: {
              totalTokens: number;
              reasoningTokens: number;
              inputTokens: number;
              outputTokens: number;
              cachedInputTokens: number;
            };
            duration: number;
          };
        }>(async (resolve, reject) => {
          while (attempts < retries) {
            try {
              const messages = await processUiMessagesFlow({
                agents,
                agentInstance,
                agentBackend,
                inputMessages,
                contexts,
                rerankers,
                user,
                tools,
                config,
                variables: args.variables,
              });
              resolve(messages);
              break;
            } catch (error: unknown) {
              console.error(
                `[EXULU] error processing UI messages flow for agent ${agentInstance.name} (${agentInstance.id}).`,
                jobData.label,
                {
                  error: error instanceof Error ? error.message : String(error),
                },
              );
              attempts++;
              if (attempts >= retries) {
                reject(error);
              }
              await new Promise((resolve) => setTimeout(resolve, 2000));
            }
          }
        });

        const result = await promise;
        const messages = result.messages;
        const metadata = {
          messages,
          ...result.metadata,
        };

        await db
          .from("job_results")
          .where({ id: jobResultId })
          .update({
            state: "completed",
            result: JSON.stringify(messages[messages.length - 1]),
            metadata: JSON.stringify(metadata),
          });

        return {
          result: messages[messages.length - 1], // last message
          job: undefined,
          metadata,
        };
      } catch (error: unknown) {
        await db
          .from("job_results")
          .where({ id: jobResultId })
          .update({
            state: "failed",
            error: error instanceof Error ? error.message : String(error),
          });
        console.error(`[EXULU] error running workflow ${workflow_template_id}.`, jobData.label, {
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    }
  };
  resolvers.Mutation["runEval"] = async (_, args, context, info) => {
    console.log("[EXULU] /evals/run/:id", args.id);

    const user = context.user;
    const eval_run_id = args.id;

    // Check user has evals write access or is super admin
    if (!user.super_admin && (!user.role || user.role.evals !== "write")) {
      throw new Error(
        "You don't have permission to run evals. Required: super_admin or evals write access.",
      );
    }

    const { db } = await postgresClient();

    // Fetch the eval run
    const evalRun: EvalRun = await db.from("eval_runs").where({ id: eval_run_id }).first();
    if (!evalRun) {
      throw new Error("Eval run not found in database.");
    }

    // Check RBAC access to eval run
    const hasAccessToEvalRun = await checkRecordAccess(evalRun, "write", user);
    if (!hasAccessToEvalRun) {
      throw new Error("You don't have access to this eval run.");
    }

    // Get test case IDs and eval function IDs from eval run
    let testCaseIds: string[] = evalRun.test_case_ids
      ? typeof evalRun.test_case_ids === "string"
        ? JSON.parse(evalRun.test_case_ids)
        : evalRun.test_case_ids
      : [];

    const eval_functions = evalRun.eval_functions
      ? typeof evalRun.eval_functions === "string"
        ? JSON.parse(evalRun.eval_functions)
        : evalRun.eval_functions
      : [];

    if (!testCaseIds || testCaseIds.length === 0) {
      throw new Error("No test cases selected for this eval run.");
    }

    if (!eval_functions || eval_functions.length === 0) {
      throw new Error("No eval functions selected for this eval run.");
    }

    if (args.test_case_ids) {
      testCaseIds = testCaseIds.filter((testCase) => args.test_case_ids.includes(testCase));
    }

    console.log("[EXULU] test cases ids filtered", testCaseIds);

    // Fetch test cases
    const testCases = await db.from("test_cases").whereIn("id", testCaseIds);
    if (testCases.length === 0) {
      throw new Error("No test cases found for eval run.");
    }

    // Load the agent instance to validate it exists
    const agentInstance = await loadAgent(evalRun.agent_id);
    if (!agentInstance) {
      throw new Error("Agent instance not found for eval run.");
    }

    // Use a general eval queue for the main eval jobs
    const evalQueue = await ExuluQueues.register(
      "eval_runs",
      {
        worker: 1,
        queue: 1,
      },
      1,
    ).use();

    // Create one job per test case
    const jobIds: string[] = [];

    for (const testCase of testCases) {
      const jobData: BullMqJobData = {
        label: `Eval Run ${eval_run_id} - Test Case ${testCase.id}`,
        trigger: "api",
        timeoutInSeconds: evalRun.timeout_in_seconds || 180, // default to 3 minutes
        type: "eval_run",
        eval_run_id,
        eval_run_name: evalRun.name,
        test_case_id: testCase.id,
        test_case_name: testCase.name,
        eval_functions, // Array of eval function IDs - worker will create child jobs for these
        agent_id: evalRun.agent_id,
        inputs: testCase.inputs,
        expected_output: testCase.expected_output,
        expected_tools: testCase.expected_tools,
        expected_knowledge_sources: testCase.expected_knowledge_sources,
        expected_agent_tools: testCase.expected_agent_tools,
        config: evalRun.config,
        scoring_method: evalRun.scoring_method,
        pass_threshold: evalRun.pass_threshold,
        user: user.id,
        role: user.role?.id,
      };

      const redisId = uuidv4();

      // Create job with type "eval" - worker will handle running agent + creating eval function jobs
      const job = await evalQueue.queue.add("eval_run", jobData, {
        jobId: redisId,
        // Setting it to 3 as a sensible default, as
        // many AI services are quite unstable.
        attempts: evalQueue.retries || 1,
        removeOnComplete: 5000,
        removeOnFail: 10000,
        backoff: evalQueue.backoff || {
          type: "exponential",
          delay: 2000,
        },
      });

      jobIds.push(job.id as string);
    }

    const response = {
      jobs: jobIds,
      count: jobIds.length,
    };

    const requestedFields = getRequestedFields(info);
    const mapped = {};
    requestedFields.forEach((field) => {
      mapped[field] = response[field];
    });
    return mapped;
  };

  /**
   * Drains the queue, i.e., removes all jobs that are waiting
   * or delayed, but not active, completed or failed.
   */
  resolvers.Mutation["drainQueue"] = async (_, args, context, info) => {
    if (!args.queue) {
      throw new Error("Queue name is required");
    }
    const queue = ExuluQueues.list.get(args.queue);
    if (!queue) {
      throw new Error("Queue not found");
    }
    const config = await queue.use();
    await config.queue.drain();
    return { success: true };
  };

  resolvers.Mutation["pauseQueue"] = async (_, args, context, info) => {
    if (!args.queue) {
      throw new Error("Queue name is required");
    }
    const queue = ExuluQueues.list.get(args.queue);
    if (!queue) {
      throw new Error("Queue not found");
    }
    const config = await queue.use();
    await config.queue.pause();
    return { success: true };
  };

  resolvers.Mutation["resumeQueue"] = async (_, args, context, info) => {
    if (!args.queue) {
      throw new Error("Queue name is required");
    }
    const queue = ExuluQueues.list.get(args.queue);
    if (!queue) {
      throw new Error("Queue not found");
    }
    const config = await queue.use();
    await config.queue.resume();
    return { success: true };
  };

  resolvers.Mutation["deleteJob"] = async (_, args, context, info) => {
    if (!args.id) {
      throw new Error("Job ID is required");
    }
    if (!args.queue) {
      throw new Error("Queue name is required");
    }
    const queue = ExuluQueues.list.get(args.queue);
    if (!queue) {
      throw new Error("Queue not found");
    }
    const config = await queue.use();
    await config.queue.remove(args.id);
    return { success: true };
  };

  resolvers.Query["evals"] = async (_, args, context, info) => {
    const requestedFields = getRequestedFields(info);
    return {
      items: evals.map((_eval: ExuluEval) => {
        const object = {};
        requestedFields.forEach((field) => {
          object[field] = _eval[field];
        });
        return object;
      }),
    };
  };

  resolvers.Query["jobs"] = async (_, args, context, info) => {
    if (!args.queue) {
      throw new Error("Queue name is required");
    }

    const { client } = await getRedisClient();
    if (!client) {
      throw new Error("Redis client not created properly");
    }

    const { jobs, count } = await getJobsByQueueName(
      args.queue,
      args.statusses,
      args.page || 1,
      args.limit || 100,
    );

    const requestedFields = getRequestedFields(info);
    return {
      items: await Promise.all(
        jobs.map(async (job) => {
          const object = {};
          for (const field of requestedFields) {
            if (field === "data") {
              object[field] = job[field];
            } else if (field === "timestamp") {
              object[field] = new Date(job[field]).toISOString();
            } else if (field === "state") {
              object[field] = await job.getState();
            } else {
              object[field] = job[field];
            }
          }
          return object;
        }),
      ),
      pageInfo: {
        pageCount: Math.ceil(count / (args.limit || 100)),
        itemCount: count,
        currentPage: args.page || 1,
        hasPreviousPage: args.page && args.page > 1 ? true : false,
        hasNextPage: args.page && args.page < Math.ceil(count / (args.limit || 100)) ? true : false,
      },
    };
  };

  resolvers.Query["rerankers"] = async (_, args, context, info) => {
    const requestedFields = getRequestedFields(info);
    return {
      items: rerankers.map((reranker: ExuluReranker) => {
        const object = {};
        requestedFields.forEach((field) => {
          object[field] = reranker[field];
        });
        return object;
      }),
    };
  };

  resolvers.Query["contexts"] = async (_, args, context, info) => {
    const data = await Promise.all(
      contexts.map(async (context) => {
        let processor: {
          name: string;
          description: string;
          queue?: string;
          trigger: string;
          timeoutInSeconds: number;
          generateEmbeddings: boolean;
        } | null = null;

        if (context.processor) {
          processor = await new Promise(async (resolve, reject) => {
            const config = await context.processor?.config;
            const queue = await config?.queue;
            resolve({
              name: context.processor!.name,
              description: context.processor!.description,
              queue: queue?.queue?.name || undefined,
              trigger: context.processor?.config?.trigger || "manual",
              timeoutInSeconds: queue?.timeoutInSeconds || 600,
              generateEmbeddings: context.processor?.config?.generateEmbeddings || false,
            });
          });
        }

        const sources = await Promise.all(
          context.sources.map(async (source) => {
            let queueName: string | undefined = undefined;
            if (source.config) {
              const config = await source.config.queue;
              queueName = config?.queue?.name || undefined;
            }
            return {
              id: source.id,
              name: source.name,
              description: source.description,
              config: {
                schedule: source.config?.schedule,
                queue: queueName,
                retries: source.config?.retries,
                backoff: source.config?.backoff,
                params: source.config?.params,
              },
            };
          }),
        );

        return {
          id: context.id,
          name: context.name,
          description: context.description,
          embedder: context.embedder
            ? {
                name: context.embedder.name,
                id: context.embedder.id,
                config: context.embedder?.config || undefined,
              }
            : undefined,
          slug: "/contexts/" + context.id,
          active: context.active,
          sources,
          processor,
          fields: await Promise.all(
            context.fields.map(async (field) => {
              if (field.type === "file" && !field.name.endsWith("_s3key")) {
                field.name = field.name + "_s3key";
              }
              return {
                ...field,
                name: sanitizeName(field.name),
                editable: field.editable,
                ...(field.type === "file"
                  ? {
                      allowedFileTypes: field.allowedFileTypes,
                    }
                  : {}),
                label: field.name?.replace("_s3key", ""),
              };
            }),
          ),
        };
      }),
    );

    const requestedFields = getRequestedFields(info);
    return {
      items: data.map((context) => {
        const object = {};
        requestedFields.forEach((field) => {
          object[field] = context[field];
        });
        return object;
      }),
    };
  };

  resolvers.Query["contextById"] = async (_, args, context, info) => {
    let data: ExuluContext | undefined = contexts.find((context) => context.id === args.id);

    if (!data) {
      return null;
    }
    let processor: {
      name: string;
      description: string;
      queue?: string;
      trigger: string;
      timeoutInSeconds: number;
      generateEmbeddings: boolean;
    } | null = null;

    if (data.processor) {
      processor = await new Promise(async (resolve, reject) => {
        const config = await data.processor?.config;
        const queue = await config?.queue;
        resolve({
          name: data.processor!.name,
          description: data.processor!.description,
          queue: queue?.queue?.name || undefined,
          trigger: data.processor?.config?.trigger || "manual",
          timeoutInSeconds: queue?.timeoutInSeconds || 600,
          generateEmbeddings: data.processor?.config?.generateEmbeddings || false,
        });
      });
    }

    const sources = await Promise.all(
      data.sources.map(async (source) => {
        let queueName: string | undefined = undefined;
        if (source.config) {
          const config = await source.config.queue;
          queueName = config?.queue?.name || undefined;
        }
        return {
          id: source.id,
          name: source.name,
          description: source.description,
          config: {
            schedule: source.config?.schedule,
            queue: queueName,
            retries: source.config?.retries,
            backoff: source.config?.backoff,
            params: source.config?.params,
          },
        };
      }),
    );

    let embedderQueue: ExuluQueueConfig | undefined = undefined;
    if (data.embedder?.queue) {
      embedderQueue = await data.embedder.queue;
    }

    const clean = {
      id: data.id,
      name: data.name,
      description: data.description,
      embedder: data.embedder
        ? {
            name: data.embedder.name,
            id: data.embedder.id,
            config: data.embedder?.config || undefined,
            queue: embedderQueue?.queue.name || undefined,
          }
        : undefined,
      slug: "/contexts/" + data.id,
      active: data.active,
      sources,
      processor,
      fields: await Promise.all(
        data.fields.map(async (field) => {
          const label = field.name?.replace("_s3key", "");
          if (field.type === "file" && !field.name.endsWith("_s3key")) {
            field.name = field.name + "_s3key";
          }
          return {
            ...field,
            name: sanitizeName(field.name),
            editable: field.editable,
            ...(field.type === "file"
              ? {
                  allowedFileTypes: field.allowedFileTypes,
                }
              : {}),
            label,
          };
        }),
      ),
      configuration: data.configuration,
    };

    const requestedFields = getRequestedFields(info);
    const mapped = {};
    requestedFields.forEach((field) => {
      mapped[field] = clean[field];
    });
    return mapped;
  };

  resolvers.Query["tools"] = async (_, args, context, info) => {
    const requestedFields = getRequestedFields(info);
    const { search, category, limit = 100, page = 0 } = args;

    // Get all active agents and add them as tools
    // so agents can call other agents as tools.
    const instances = await loadAgents();
    let agentTools = await Promise.all(
      instances.map(async (instance: Agent) => {
        const backend: ExuluAgent | undefined = agents.find((a) => a.id === instance.backend);
        if (!backend) {
          return null;
        }
        return await backend.tool(instance.id, agents, contexts, rerankers);
      }),
    );

    let agenticRetrievalTool: ExuluTool | undefined = undefined;

    const filtered: ExuluTool[] = agentTools.filter((tool) => tool !== null) as ExuluTool[];
    let allTools = [...filtered, ...tools];

    if (contexts?.length) {
      agenticRetrievalTool = createAgenticRetrievalTool({
        contexts: contexts,
        rerankers: rerankers,
        user: context.user,
        role: context.user?.role?.id,
        model: undefined, // irrelevant at this point as we only retrieve the tool information here, not execute it
      });
      if (agenticRetrievalTool) {
        allTools.push(agenticRetrievalTool);
      }
    }

    // Apply search filter
    if (search && search.trim()) {
      const searchTerm = search.toLowerCase().trim();
      allTools = allTools.filter(
        (tool) =>
          tool.name?.toLowerCase().includes(searchTerm) ||
          tool.description?.toLowerCase().includes(searchTerm),
      );
    }

    // Apply category filter
    if (category && category.trim()) {
      allTools = allTools.filter((tool) => tool.category === category);
    }

    // Apply pagination
    const total = allTools.length;
    const start = page * limit;
    const end = start + limit;
    const paginatedTools = allTools.slice(start, end);

    return {
      items: paginatedTools.map((tool) => {
        const object = {};
        requestedFields.forEach((field) => {
          object[field] = tool[field];
        });
        return object;
      }),
      total,
      page,
      limit,
    };
  };

  resolvers.Query["toolCategories"] = async () => {
    // Extract unique categories from all tools
    const array = tools
      .map((tool) => tool.category)
      .filter((category) => category && typeof category === "string");
    array.push("contexts");
    array.push("agents");
    return [...new Set(array)].sort();
  };

  resolvers.Query["getUniquePromptTags"] = async (_, args, context, info) => {
    const { db } = context;
    const user = context.user;

    // Find the prompt_library table definition to apply access control
    const promptTable = tables.find((t) => t.name.plural === "prompt_library");
    if (!promptTable) {
      throw new Error("Prompt library table not found");
    }

    // Build query with access control
    let query = db.from("prompt_library").select("tags");
    query = applyAccessControl(promptTable, query, user);

    const results = await query;

    // Extract and flatten all tags
    const allTags: string[] = [];
    for (const row of results) {
      if (row.tags) {
        let tags: string[] = [];
        // Handle both JSON string and array formats
        if (typeof row.tags === "string") {
          try {
            tags = JSON.parse(row.tags);
          } catch (e) {
            // If it's not valid JSON, treat it as a single tag
            tags = [row.tags];
          }
        } else if (Array.isArray(row.tags)) {
          tags = row.tags;
        }

        // Add valid tags to the collection
        tags.forEach((tag) => {
          if (tag && typeof tag === "string" && tag.trim()) {
            allTags.push(tag.trim().toLowerCase());
          }
        });
      }
    }

    // Return unique tags, sorted alphabetically
    return [...new Set(allTags)].sort();
  };

  modelDefs += `
    type ProviderPaginationResult {
        items: [Provider]!
    }
    `;

  modelDefs += `
    type WorkflowScheduleResult {
        id: String
        schedule: String
        next: Date
        iteration: Int
    }
    `;

  modelDefs += `
    type QueueResult {
        name: String!
        concurrency: QueueConcurrency!
        timeoutInSeconds: Int!
        ratelimit: Int!
        isMaxed: Boolean!
        isPaused: Boolean!
        jobs: QueueJobsCounts
    }
    `;
  modelDefs += `
    type QueueConcurrency {
        worker: Int
        queue: Int
    }
    `;
  modelDefs += `
    type QueueJobsCounts {
        paused: Int!
        completed: Int!
        failed: Int!
        waiting: Int!
        active: Int!
        delayed: Int!
    }
    `;

  modelDefs += `
    type EvalPaginationResult {
    items: [Eval]!
    }
    `;

  modelDefs += `
    type ContextPaginationResult {
    items: [Context]!
    }
    `;

  modelDefs += `
    type RerankerPaginationResult {
    items: [Reranker]!
    }
    `;

  modelDefs += `
    type ToolPaginationResult {
    items: [Tool]!
    total: Int!
    page: Int!
    limit: Int!
    }
    `;

  modelDefs += `
    type JobPaginationResult {
        items: [Job]!
        pageInfo: PageInfo!
    }
    `;

  typeDefs += "}\n";
  mutationDefs += "}\n";

  // Add generic types used across all tables
  const genericTypes = `

type RateLimiterRule {
    name: String
    rate_limit: RateLimiterRuleRateLimit
}

type RateLimiterRuleRateLimit {
    time: Int
    limit: Int
}

type AgentCapabilities {
    text: Boolean
    images: [String]
    files: [String]
    audio: [String]
    video: [String]
}

type AgentWorkflows {
    enabled: Boolean
    queue: AgentWorkflowQueue
}

type AgentWorkflowQueue {
    name: String
}

type AgentEvalFunction {
    id: ID!
    name: String!
    description: String!
    config: [AgentEvalFunctionConfig!]
}

type AgentEvalFunctionConfig {
    name: String!
    description: String!
}

type ItemChunks {
    chunk_id: String!
    chunk_index: Int!
    chunk_content: String!
    chunk_source: String!
    chunk_created_at: Date!
    chunk_updated_at: Date!
}

type Provider {
  id: ID!
  name: String!
  description: String
  providerName: String
  provider: String
  modelName: String
  type: EnumProviderType!
}

type Eval {
    id: ID!
    name: String!
    description: String!
    llm: Boolean!
    config: [EvalConfig!]
}

type EvalConfig {
    name: String!
    description: String!
}

type Context {
    id: ID!
    name: String!
    description: String
    embedder: Embedder
    slug: String
    active: Boolean
    fields: JSON
    configuration: JSON
    sources: [ContextSource]
    processor: ContextProcessor
}
type Reranker {
    id: ID!
    name: String!
    description: String
}
type Embedder {
    name: String!
    id: ID!
    config: [EmbedderConfig!]
    queue: String
}
type EmbedderConfig {
    name: String!
    description: String
    default: String
}
type ContextProcessor {
    name: String!
    description: String
    queue: String
    trigger: String
    timeoutInSeconds: Int
    generateEmbeddings: Boolean
}

type ContextSource {
    id: String!
    name: String!
    description: String!
    config: ContextSourceConfig!
}

type ContextSourceConfig {
    schedule: String
    queue: String
    retries: Int
    backoff: ContextSourceBackoff
    params: [ContextSourceParam!]
}

type ContextSourceParam {
    name: String!
    description: String!
    default: String
}

type ContextSourceBackoff {
    type: String
    delay: Int
}

type RunEvalReturnPayload {
    jobs: [String!]!
    count: Int!
}

type RunWorkflowReturnPayload {
    result: JSON
    job: String
    metadata: JSON
}

type WorkflowScheduleReturnPayload {
    status: String!
    job: String
}

type JobActionReturnPayload {
    success: Boolean!
}

type ContextField {
    name: String!
    type: String!
    unique: Boolean
    label: String
}

type Tool {
  id: ID!
  name: String!
  description: String
  category: String
  type: String
  config: JSON
}

type Job {
  id: String!
  name: String!
  returnvalue: JSON
  stacktrace: [String]
  finishedOn: Date
  processedOn: Date
  attemptsMade: Int
  failedReason: String
  state: String!
  data: JSON
  timestamp: Date
}

enum EnumProviderType {
  agent
}

enum QueueEnum {
  ${ExuluQueues.list.keys().toArray().length > 0 ? ExuluQueues.list.keys().toArray().join("\n") : "NO_QUEUES"}
}

enum JobStateEnum {
  ${JOB_STATUS_ENUM.active}
  ${JOB_STATUS_ENUM.waiting}
  ${JOB_STATUS_ENUM.delayed}
  ${JOB_STATUS_ENUM.failed}
  ${JOB_STATUS_ENUM.completed}
  ${JOB_STATUS_ENUM.paused}
  ${JOB_STATUS_ENUM.stuck}
}

type StatisticsResult {
  group: String!
  count: Int!
}
`;

  const fullSDL = typeDefs + mutationDefs + modelDefs + genericTypes;

  // -------------- Create Schema ------------------

  const schema = makeExecutableSchema({
    typeDefs: fullSDL,
    resolvers,
  });

  return schema;
}
