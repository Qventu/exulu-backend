import type { ExuluTableDefinition } from "@EXULU_TYPES/exulu-table-definition";
import { mapExuluFieldTypesToGraphqlTypes } from "@SRC/graphql/utilities/map-types";
import { makeExecutableSchema } from "@graphql-tools/schema";
import GraphQLJSON from "graphql-type-json";
import cron from "cron-validator";
import { parseRerankerModels } from "@SRC/exulu/litellm/parse-reranker-models";
import { resolveLiteLLMConfigPath } from "@SRC/exulu/litellm/parse-embedding-models";
import type { ExuluTool } from "@SRC/exulu/tool";
import type { ExuluContext } from "@SRC/exulu/context";
import { getTableName } from "@SRC/exulu/context.ts";
import type { ExuluProvider } from "@SRC/exulu/provider";
import { resolveAgentProvider } from "@SRC/exulu/resolve-agent-provider";
import type { ExuluQueueConfig } from "@EXULU_TYPES/queue-config";
import type { ExuluWorkflow } from "@EXULU_TYPES/workflow";
import { sanitizeName } from "@SRC/utils/sanitize-name.ts";
import { postgresClient } from "@SRC/postgres/client.ts";
import { checkRecordAccess } from "@SRC/utils/check-record-access.ts";
import type { ExuluAgent } from "@EXULU_TYPES/models/agent";
import type { EvalRun } from "@EXULU_TYPES/models/eval-run";
import type { ExuluConfig } from "@SRC/exulu/app/index.ts";
import { queues as ExuluQueues } from "@EE/queues/queues";
import { redisClient as getRedisClient } from "@SRC/redis/client.ts";
import type { BullMqJobData } from "@EE/queues/decorator.ts";
import { v4 as uuidv4 } from "uuid";
import { JOB_STATUS_ENUM } from "@EXULU_TYPES/enums/jobs";
import type { UIMessage } from "ai";
import { createAgenticRetrievalTool } from "@EE/agentic-retrieval/pipeline/index";
import { createKbEditorPickerTool } from "@SRC/templates/tools/context-write-tools";
import { GraphQLDate } from "@SRC/graphql/types";
import { getRequestedFields } from "@SRC/graphql/resolvers/utils";
import { applyAccessControl } from "@SRC/graphql/utilities/access-control";
import { RBACResolver } from "../../../ee/rbac-resolver.ts";
import { createQueries } from "@SRC/graphql/resolvers";
import { convertContextToTableDefinition } from "@SRC/graphql/utilities/convert-context-to-table-definition";
import { getJobsByQueueName } from "../resolvers/job-queues";
import { createMutations } from "../mutations";
import type { ExuluEval } from "@SRC/exulu/evals";
import { exuluApp } from "@SRC/exulu/app/singleton";
import { processUiMessagesFlow, validateWorkflowPayload } from "@EE/workers.ts";
import { createRunSession } from "@SRC/exulu/routines/run-session.ts";
import { cancelRoutineRunRow, casJobResultState, parseRunMetadata } from "@SRC/exulu/routines/run-state.ts";
import { applyRoutineRunFilters, mapRoutineRunRow } from "@SRC/exulu/routines/runs-query.ts";
import { workflowTemplatesSchema } from "@EE/schemas";
import { checkLicense } from "@EE/entitlements.ts";
import fs from "fs";
import { transcriptionService } from "@SRC/exulu/transcription/service";
import { transcriptionClient } from "@SRC/exulu/transcription/client";
import { recallService } from "@SRC/exulu/recall/service";
import { recallEnabled, RECALL_NOT_CONFIGURED_MESSAGE } from "@SRC/exulu/recall/env";
import {
  validateEmailTriggerConfig,
  generateTriggerSecret,
  generateSigningSecret,
} from "@SRC/exulu/email-inbound/trigger-config";
import { encrypt } from "@SRC/exulu/auth/credential-store";
import type { WorkflowTriggerRow } from "@SRC/exulu/email-inbound/types";
import {
  toWorkflowTriggerPayload,
  insertTriggerWithSecretRetry,
} from "@SRC/exulu/email-inbound/resolver-helpers";

/* 
Auto generate schemas based on Exulu Table definitions in core-schema.ts
and the fields provided by the implementation at the customer through 
ExuluContext.
*/
export function createExuluContextsTypeDefs(table: ExuluTableDefinition): string {
  // Generate enum definitions for enum fields
  const enumDefs: string = table.fields
    .filter((field) => field.type === "enum" && field.enumValues)
    .map((field) => {
      if (!field.enumValues) {
        return null;
      }
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
    .filter((enumDef) => enumDef !== null)
    .join("\n");

  // Hidden fields (hidden: true) are write-only secrets: excluded from the
  // GraphQL object type so they can never be read via any query or mutation
  // return payload.
  const graphqlFields = table.fields.filter((field) => field.hidden !== true);
  let fields = graphqlFields.map((field) => {
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
    fields.push("  streaming: Boolean");
    fields.push("  capabilities: AgentCapabilities");
    fields.push("  maxContextLength: Int");
    fields.push("  authenticationInformation: String");
    fields.push("  systemInstructions: String");
    fields.push("  workflows: AgentWorkflows");
    fields.push("  slug: String");
    fields.push("  guest_has_password: Boolean");
  }

  if (table.name.singular === "workflow_template") {
    fields.push("  variables: [String]");
  }

  // Computed budget field: resolved from LiteLLM at query time (not a DB
  // column). Null when the entity has no budget. See finalizeRequestedFields.
  if (
    ["user", "role", "team", "project", "agent", "workflow_template"].includes(table.name.singular)
  ) {
    fields.push("  budget: JSON");
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

  // Input type includes hidden secret fields (password, apikey, anthropic_token,
  // temporary_token) because the mutation layer reads and hashes/stores them —
  // they must remain writable via input even though they are excluded from read
  // payloads (graphqlFields above). The sole name-based exclusion here is
  // guest_password_hash: clients must never set it directly; they use the
  // guest_password input field instead (the resolver derives the hash).
  const inputFields = table.fields.filter((f) => f.name !== "guest_password_hash");
  const inputExtra =
    table.name.singular === "agent" ? "  guest_password: String" : "";
  const inputDef = `
  input ${table.name.singular}Input {
  ${inputFields.map((f) => `  ${f.name}: ${mapExuluFieldTypesToGraphqlTypes(f)}`).join("\n")}
  ${inputExtra}
  ${rbacInputField}
  }
  `;

  return enumDefs + typeDef + inputDef;
}

export function createExuluContextsFilterTypeDefs(table: ExuluTableDefinition): string {
  // Hidden fields (hidden: true) are write-only secrets: excluded from all
  // Filter input types so clients cannot use boolean / timing oracles to
  // enumerate or probe secret values (bcrypt hashes, tokens, API keys, etc.).
  const filterFields = table.fields.filter((field) => field.hidden !== true);
  const fieldFilters = filterFields.map((field) => {
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
  enumFilterOperators = filterFields
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
  providers: ExuluProvider[],
  tools: ExuluTool[],
  config: ExuluConfig,
  evals: ExuluEval[],
) {
  const contextSchemas: ExuluTableDefinition[] = contexts.map((context) =>
    convertContextToTableDefinition(context),
  );

  // Adding fields to SDL that are not defined via
  // ExuluContext instances but added in the
  // provider at createItemsTable().
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
      teams: [RBACTeam!]
    }

    type RBACUser {
      id: ID!
      rights: String!
    }

    type RBACRole {
      id: ID!
      rights: String!
    }

    type RBACTeam {
      id: ID!
      rights: String!
    }

    input RBACInput {
      users: [RBACUserInput!]
      roles: [RBACRoleInput!]
      teams: [RBACTeamInput!]
    }

    input RBACUserInput {
      id: ID!
      rights: String!
    }

    input RBACRoleInput {
      id: ID!
      rights: String!
    }

    input RBACTeamInput {
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
        ${tableNameSingular === "agent"
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
      ${tableNamePlural}VectorSearch(limit: Int, query: String!, method: VectorMethodEnum!, itemFilters: [Filter${tableNameSingularUpperCaseFirst}], cutoffs: SearchCutoffs, expand: SearchExpand, entityFilter: ${tableNameSingular}EntityFilterInput): ${tableNameSingular}VectorSearchResult
      ${tableNameSingular}ChunkById(id: ID!): ${tableNameSingular}VectorSearchChunk
      ${tableNameSingular}StaleEntityCount: Int
      ${tableNameSingular}EntityModel: ${tableNameSingular}EntityModelInfo
      ${tableNameSingular}EntitiesForItem(item: ID!): [${tableNameSingular}ItemEntity!]
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
    ${tableNameSingular}BackfillEntities(onlyStale: Boolean, limit: Int): ${tableNameSingular}EntityBackfillPayload
    ${tableNameSingular}PurgeEntityType(type: String!): ${tableNameSingular}EntityPurgePayload
    ${tableNameSingular}SetEntityModel(model: String): ${tableNameSingular}EntityModelInfo
    ${tableNameSingular}ExtractEntities(item: ID!): ${tableNameSingular}EntityExtractPayload
    ${tableNameSingular}DetachEntities(item: ID!): ${tableNameSingular}EntityDetachPayload
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
        entityInsights: ${tableNameSingular}EntityInsights
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
        chunk_entities: [${tableNameSingular}ChunkEntity!]
    }

    type VectoSearchResultContext {
        name: String!
        id: ID!
        embedder: String!
    }

    input ${tableNameSingular}EntityRefInput {
        type: String!
        name: String!
    }

    input ${tableNameSingular}EntityFilterInput {
        entityIds: [ID!]
        entities: [${tableNameSingular}EntityRefInput!]
        mode: String
    }

    type ${tableNameSingular}ChunkEntity {
        id: ID!
        name: String!
        type: String!
    }

    type ${tableNameSingular}RelatedEntity {
        id: ID!
        name: String!
        type: String!
        weight: Float!
    }

    type ${tableNameSingular}QueryEntityInsight {
        id: ID!
        type: String!
        name: String!
        matchedInResults: Int!
        relatedDocCount: Int!
        relatedEntities: [${tableNameSingular}RelatedEntity!]!
    }

    type ${tableNameSingular}EntityInsights {
        queryEntities: [${tableNameSingular}QueryEntityInsight!]!
    }

    type ${tableNameSingular}EntityBackfillPayload {
        processed: Int!
        skipped: Int!
    }

    type ${tableNameSingular}EntityPurgePayload {
        removed: Int!
    }

    type ${tableNameSingular}EntityModelInfo {
        effectiveModel: String
        source: String
        databaseModel: String
        codeModel: String
    }

    type ${tableNameSingular}EntityExtractPayload {
        extracted: Int!
    }

    type ${tableNameSingular}EntityDetachPayload {
        detached: Int!
    }

    type ${tableNameSingular}ItemEntity {
        id: ID!
        type: String!
        name: String!
        mentions: Int!
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
    Object.assign(resolvers.Query, createQueries(table, providers, tools, contexts));
    Object.assign(
      resolvers.Mutation,
      createMutations(table, providers, contexts, tools, config),
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
    litellmCatalog: [LiteLLMModel!]!
    `;

  typeDefs += `
    workflowSchedule(workflow: ID!): WorkflowScheduleResult
    `;

  // Routine runs (spec §6) — powers the per-routine Runs section and /runs.
  typeDefs += `
    routineRuns(page: Int, limit: Int, workflow: ID, states: [String!], triggers: [String!], from: Date, to: Date, search: String, needsAttention: Boolean): RoutineRunPage
    routineRunsNeedingAttentionCount: Float!
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

  typeDefs += `
    getUniqueSkillTags: [String!]!
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
    cancelRoutineRun(id: ID!): RoutineRun
    retryRoutineRun(id: ID!): RoutineRun
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
    retryJob(queue: QueueEnum!, id: String!, deleteOriginal: Boolean): JobActionReturnPayload
    `;

  mutationDefs += `
    transcriptionJobStart(input: TranscriptionJobStartInput!): transcription_job
    transcriptionJobFinalize(id: ID!, input: TranscriptionJobFinalizeInput!): TranscriptionJobFinalizeResult
    transcriptionJobCancel(id: ID!): transcription_job
    meetingBotStart(input: MeetingBotStartInput!): transcription_job
    runTranscriptPostProcessing(id: ID!, prompt_id: ID!, agent_id: ID!): transcription_job
    `;

  mutationDefs += `
    upsertWorkflowEmailTrigger(workflow: ID!, enabled: Boolean!, config: JSON!): WorkflowTrigger
    deleteWorkflowTrigger(id: ID!): WorkflowTrigger
    regenerateWorkflowTriggerSecret(id: ID!): WorkflowTrigger
    setWorkflowTriggerSigningSecret(id: ID!, enable: Boolean!): WorkflowTrigger
    `;

  modelDefs += `
    input TranscriptionJobStartInput {
      audio_s3key: String!
      filename: String!
      title: String
      language: String
      num_speakers: Int
      hotwords: [String!]
      project_id: ID
      target_rights_mode: String
      target_rbac_users: [RBACUserInput!]
      target_rbac_roles: [RBACRoleInput!]
    }

    input TranscriptionJobFinalizeInput {
      title: String
      speakers: JSON!
      project_id: ID
      target_rights_mode: String
      target_rbac_users: [RBACUserInput!]
      target_rbac_roles: [RBACRoleInput!]
    }

    type TranscriptionJobFinalizeResult {
      job: transcription_job!
      item_id: ID!
    }

    input MeetingBotStartInput {
      meeting_url: String!
      join_at: String
      language: String
      title: String
      bot_name: String
      notify_chat: Boolean
      project_id: ID
      target_rights_mode: String
      target_rbac_users: [RBACUserInput!]
      target_rbac_roles: [RBACRoleInput!]
      post_processing_prompts: [PostProcessingPromptInput!]
    }

    input PostProcessingPromptInput {
      prompt_id: ID!
      agent_id: ID!
    }

    type MeetingRecordingUsage {
      enabled: Boolean!
      used_seconds: Float!
      limit_seconds: Float
      percent: Float
      exceeded: Boolean!
    }
  `;

  // Email-triggered routines (spec §6). run_as_role is deliberately not
  // exposed; the signing key is write-only (has_signing_secret flag only).
  modelDefs += `
    type WorkflowTrigger {
      id: ID!
      workflow: ID!
      type: String!
      enabled: Boolean!
      webhook_url: String
      has_webhook: Boolean!
      has_signing_secret: Boolean!
      last_fired_at: Date
      config: JSON!
      run_as_user: Float
      createdAt: Date
      updatedAt: Date
      signing_secret_once: String
    }

  `;

  typeDefs += `
   tools(search: String, category: String, limit: Int, page: Int): ToolPaginationResult
   toolCategories: [String!]!
    `;

  typeDefs += `
   jobs(queue: QueueEnum!, statusses: [JobStateEnum!], page: Int, limit: Int): JobPaginationResult
    `;

  typeDefs += `
   meetingRecordingUsage: MeetingRecordingUsage
    `;

  typeDefs += `
   workflowTriggers(workflow: ID!): [WorkflowTrigger!]!
    `;

  modelDefs += `
type RoutineRun {
  id: ID!
  job_id: String
  state: String!
  trigger: String
  trigger_metadata: JSON
  session: String
  workflow: String!
  workflowName: String
  agent: String
  error: JSON
  tries: Float
  createdAt: Date
  updatedAt: Date
}

type RoutineRunPage {
  items: [RoutineRun!]!
  total: Float!
}
`;

  modelDefs += `
type LiteLLMModel {
  model_name: String!
  upstream_model: String
  active: Boolean
  tags: [String!]
  type: String
  brand: String
  region: String
  max_tokens: Int
  max_input_tokens: Int
  max_output_tokens: Int
  supports_vision: Boolean
  supports_function_calling: Boolean
  supports_pdf_input: Boolean
  supports_audio_input: Boolean
  input_cost_per_million_tokens: Float
  output_cost_per_million_tokens: Float
}
`;

  resolvers.Query["providers"] = async (_, args, context, info) => {
    const requestedFields = getRequestedFields(info);
    return {
      items: providers.map((provider) => {
        const object = {};
        requestedFields.forEach((field) => {
          object[field] = provider[field];
        });
        return object;
      }),
    };
  };

  // litellmCatalog: returns the list of models LiteLLM is currently configured
  // to expose. Empty array when LiteLLM is off / misconfigured so callers can
  // invoke this unconditionally. Cache lives in the shared catalog module so
  // addProviderFields can use the same data without re-fetching.
  resolvers.Query["litellmCatalog"] = async () => {
    const { fetchLiteLLMCatalog } = await import(
      "@SRC/exulu/litellm/catalog"
    );
    return fetchLiteLLMCatalog();
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
    const agent = await exuluApp.get().agent(workflowTemplate.agent);
    if (!agent) {
      throw new Error("Agent instance not found for workflow template.");
    }

    const provider = await resolveAgentProvider(agent, providers);

    if (!provider) {
      throw new Error(
        "ExuluProvider not registered for the model configured on agent instance " +
        agent.id +
        ".",
      );
    }

    let queue: ExuluQueueConfig | undefined;

    if (provider?.workflows?.queue) {
      queue = await provider.workflows.queue;
      const scheduler = await queue!.queue?.getJobScheduler(args.workflow + "-workflow-schedule");
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
    const agent = await exuluApp.get().agent(workflowTemplate.agent);
    if (!agent) {
      throw new Error("Agent instance not found for workflow template.");
    }

    const provider = await resolveAgentProvider(agent, providers);

    if (!provider) {
      throw new Error(
        "ExuluProvider not registered for the model configured on agent instance " +
        agent.id +
        ".",
      );
    }

    let queue: ExuluQueueConfig | undefined;

    if (provider?.workflows?.queue) {
      queue = await provider.workflows.queue;
      await queue!.queue?.removeJobScheduler(args.workflow + "-workflow-schedule");
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
    const agent = await exuluApp.get().agent(workflowTemplate.agent);
    if (!agent) {
      throw new Error("Agent instance not found for workflow template.");
    }

    const provider = await resolveAgentProvider(agent, providers);

    if (!provider) {
      throw new Error(
        "ExuluProvider not registered for the model configured on agent instance " +
        agent.id +
        ".",
      );
    }

    let queue: ExuluQueueConfig | undefined;

    if (provider?.workflows?.queue) {
      queue = await provider.workflows.queue;
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
      // Runs-view provenance (spec §3.3): fixes the bug where scheduled runs
      // were displayed as "api".
      triggerSource: "schedule",
      triggerMetadata: { cron: args.schedule },
    };

    if (!queue) {
      throw new Error(
        "Queue not found for provider: " +
        provider?.id +
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

  // --- Email-triggered routines: trigger CRUD + platform inbound config ---
  // workflow_triggers has RBAC:false — access derives from the parent
  // routine (workflow_templates RBAC incl. teams), so load the routine with
  // its rbac rows attached before checkRecordAccess (spec §3.1).
  const loadWorkflowTemplateWithRBAC = async (db: any, workflowId: string) => {
    const workflowTemplate = await db
      .from("workflow_templates")
      .where({ id: workflowId })
      .first();
    if (!workflowTemplate) {
      throw new Error("Workflow template not found in database.");
    }
    workflowTemplate.RBAC = await RBACResolver(
      db,
      "workflow_template",
      workflowTemplate.id,
      workflowTemplate.rights_mode,
    );
    return workflowTemplate;
  };

  const requireWorkflowsWriteRole = (user: any) => {
    if (!user.super_admin && (!user.role || user.role.workflows !== "write")) {
      throw new Error(
        "You don't have permission to manage routine triggers. Required: super_admin or workflows write access.",
      );
    }
  };

  resolvers.Query["workflowTriggers"] = async (_, args, context) => {
    if (!args.workflow) {
      throw new Error("Workflow template ID is required");
    }
    const user = context.user;
    const { db } = await postgresClient();
    const workflowTemplate = await loadWorkflowTemplateWithRBAC(db, args.workflow);
    const hasAccess = await checkRecordAccess(workflowTemplate, "read", user);
    if (!hasAccess) {
      throw new Error("You don't have access to this workflow template.");
    }
    const canWrite = await checkRecordAccess(workflowTemplate, "write", user);
    const rows = await db
      .from("workflow_triggers")
      .where({ workflow: args.workflow })
      .orderBy("createdAt", "asc");
    return rows.map((r: WorkflowTriggerRow) => toWorkflowTriggerPayload(r, { canWrite }));
  };

  resolvers.Mutation["upsertWorkflowEmailTrigger"] = async (_, args, context) => {
    if (!args.workflow) {
      throw new Error("Workflow template ID is required");
    }
    const user = context.user;
    requireWorkflowsWriteRole(user);
    const license = checkLicense();
    if (!license["queues"]) {
      throw new Error("Email triggers require the queues entitlement.");
    }

    const { db } = await postgresClient();
    const workflowTemplate = await loadWorkflowTemplateWithRBAC(db, args.workflow);
    const hasAccess = await checkRecordAccess(workflowTemplate, "write", user);
    if (!hasAccess) {
      throw new Error("You don't have access to this workflow template.");
    }

    const validatedConfig = validateEmailTriggerConfig(args.config);

    const existing = await db
      .from("workflow_triggers")
      .where({ workflow: args.workflow, type: "email" })
      .first();
    if (existing) {
      const [updated] = await db
        .from("workflow_triggers")
        .where({ id: existing.id })
        .update({
          enabled: args.enabled,
          config: JSON.stringify(validatedConfig),
          // Re-capture the run identity from the saving admin (spec §3.1).
          run_as_user: user.id,
          run_as_role: user.role?.id ?? null,
          updatedAt: new Date(),
        })
        .returning("*");
      return toWorkflowTriggerPayload(updated, { canWrite: true });
    }

    // Server-generated secret, unique with regenerate-on-collision
    // (max 5 attempts, INSERT is inside the loop — race-safe, spec §3.1).
    const created = await insertTriggerWithSecretRetry(
      async (row) => {
        const [inserted] = await db
          .from("workflow_triggers")
          .insert(row)
          .returning("*");
        return inserted;
      },
      {
        workflow: args.workflow,
        type: "email",
        enabled: args.enabled,
        config: JSON.stringify(validatedConfig),
        run_as_user: user.id,
        run_as_role: user.role?.id ?? null,
        created_by: user.id,
      },
    );
    return toWorkflowTriggerPayload(created, { canWrite: true });
  };

  resolvers.Mutation["deleteWorkflowTrigger"] = async (_, args, context) => {
    if (!args.id) {
      throw new Error("Trigger ID is required");
    }
    const user = context.user;
    requireWorkflowsWriteRole(user);
    const { db } = await postgresClient();
    const trigger = await db.from("workflow_triggers").where({ id: args.id }).first();
    if (!trigger) {
      throw new Error("Workflow trigger not found in database.");
    }
    const workflowTemplate = await loadWorkflowTemplateWithRBAC(db, trigger.workflow);
    const hasAccess = await checkRecordAccess(workflowTemplate, "write", user);
    if (!hasAccess) {
      throw new Error("You don't have access to this workflow template.");
    }
    await db.from("workflow_triggers").where({ id: args.id }).del();
    return toWorkflowTriggerPayload(trigger, { canWrite: true });
  };

  resolvers.Mutation["regenerateWorkflowTriggerSecret"] = async (_, args, context) => {
    const user = context.user;
    requireWorkflowsWriteRole(user);
    const { db } = await postgresClient();
    const trigger = await db.from("workflow_triggers").where({ id: args.id }).first();
    if (!trigger) throw new Error("Trigger not found.");
    const workflowTemplate = await loadWorkflowTemplateWithRBAC(db, trigger.workflow);
    if (!(await checkRecordAccess(workflowTemplate, "write", user))) throw new Error("Access denied.");

    let updated: any;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const rows = await db.from("workflow_triggers").where({ id: args.id })
          .update({ secret: generateTriggerSecret(), updatedAt: new Date().toISOString() }).returning("*");
        updated = rows[0];
        break;
      } catch (err: any) {
        if (err?.code === "23505") continue;
        throw err;
      }
    }
    if (!updated) throw new Error("Could not generate a unique trigger secret.");
    return toWorkflowTriggerPayload(updated, { canWrite: true });
  };

  resolvers.Mutation["setWorkflowTriggerSigningSecret"] = async (_, args, context) => {
    const user = context.user;
    requireWorkflowsWriteRole(user);
    const { db } = await postgresClient();
    const trigger = await db.from("workflow_triggers").where({ id: args.id }).first();
    if (!trigger) throw new Error("Trigger not found.");
    const workflowTemplate = await loadWorkflowTemplateWithRBAC(db, trigger.workflow);
    if (!(await checkRecordAccess(workflowTemplate, "write", user))) throw new Error("Access denied.");

    let once: string | null = null;
    let signingSecret: string | null = null;
    if (args.enable) {
      once = generateSigningSecret();
      signingSecret = encrypt(once);
    }
    const rows = await db.from("workflow_triggers").where({ id: args.id })
      .update({ signing_secret: signingSecret, updatedAt: new Date().toISOString() }).returning("*");
    return toWorkflowTriggerPayload(rows[0], { canWrite: true, signingSecretOnce: once });
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
    const agent = await exuluApp.get().agent(workflowTemplate.agent);
    if (!agent) {
      throw new Error("Agent instance not found for workflow template.");
    }

    const provider = await resolveAgentProvider(agent, providers);

    if (!provider) {
      throw new Error(
        "ExuluProvider not registered for the model configured on agent instance " +
        agent.id +
        ".",
      );
    }

    let queue: ExuluQueueConfig | undefined;
    if (provider?.workflows?.queue) {
      queue = await provider.workflows.queue;
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
      // Runs-view provenance (spec §3.3): UI-initiated runs are "manual",
      // API-key callers are "api".
      triggerSource: user.type === "api" ? "api" : "manual",
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
          type: "workflow",
          workflow: workflow_template_id,
          trigger: jobData.triggerSource ?? null,
        })
        .returning("id");

      const jobResultId = jobResult[0].id;

      try {
        const {
          agent,
          provider,
          user,
          workflow,
          messages: inputMessages,
        } = await validateWorkflowPayload(jobData, providers);

        // Session-backed (spec §3.4) — but keep the legacy blanket approval:
        // without a queue there is no worker to resume a paused run.
        const sessionId = await createRunSession({
          db,
          workflow: {
            id: workflow.id,
            name: workflow.name,
            agent: workflow.agent,
            rights_mode: workflow.rights_mode,
          },
          userId: user.id,
          title: `${workflow.name} — ${new Date().toISOString()}`,
          trigger: jobData.triggerSource ?? "manual",
          jobResultId,
        });
        await db.from("job_results").where({ id: jobResultId }).update({ session: sessionId });

        const retries = 3;
        let attempts = 0;

        // todo allow setting queue on agent provider and then create a job with type "agent"
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
                providers,
                agent,
                provider,
                inputMessages,
                contexts,
                user,
                tools,
                config,
                variables: args.variables,
                // Tag LLM spend to this routine (direct one-shot path mirrors the queued path).
                routine: { id: workflow.id, name: workflow.name },
                sessionId,
              });
              resolve(messages);
              break;
            } catch (error: unknown) {
              console.error(
                `[EXULU] error processing UI messages flow for agent ${agent.name} (${agent.id}).`,
                jobData.label,
                {
                  error: error instanceof Error ? error.message : String(error),
                },
              );
              attempts++;
              if (attempts >= retries) {
                reject(error instanceof Error ? error : new Error(String(error)));
              }
              await new Promise((resolve) => setTimeout(() => resolve(true), 2000));
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
  // ---- Routine runs API (spec §6) -------------------------------------
  // job_results has no RBAC — access derives from the parent routine:
  // applyAccessControl on workflow_templates also enforces the `workflows`
  // role, then a single indexed query fetches the rows (no per-row N+1).
  const readableRoutines = async (
    db: any,
    user: any,
  ): Promise<Map<string, { id: string; name: string; agent: string }>> => {
    try {
      const rows: { id: string; name: string; agent: string }[] = await applyAccessControl(
        workflowTemplatesSchema,
        db("workflow_templates").select("id", "name", "agent"),
        user,
      );
      return new Map(rows.map((row) => [row.id, row]));
    } catch (err) {
      // Role-less users see zero runs (nav badge polls this).
      if (err instanceof Error && err.message.startsWith("Access control error")) {
        return new Map();
      }
      throw err;
    }
  };

  const loadRoutineRunForWrite = async (db: any, user: any, id: string) => {
    const row = await db.from("job_results").where({ id }).first();
    if (!row || row.type !== "workflow" || !row.workflow) {
      throw new Error("Routine run not found.");
    }
    const routine = await db.from("workflow_templates").where({ id: row.workflow }).first();
    if (!routine) {
      throw new Error("Routine not found for this run.");
    }
    const hasAccess = await checkRecordAccess(routine, "write", user);
    if (!hasAccess) {
      throw new Error("You don't have access to this routine.");
    }
    return { row, routine };
  };

  resolvers.Query["routineRuns"] = async (_, args, context) => {
    const user = context.user;
    const { db } = await postgresClient();

    const routineById = await readableRoutines(db, user);
    let allowedIds = [...routineById.keys()];
    if (args.workflow) {
      allowedIds = allowedIds.filter((id) => id === args.workflow);
    }
    if (allowedIds.length === 0) {
      return { items: [], total: 0 };
    }

    const page = Math.max(1, args.page ?? 1);
    const limit = Math.min(100, Math.max(1, args.limit ?? 20));

    const countRows = await applyRoutineRunFilters(db("job_results"), args, allowedIds).count(
      "* as count",
    );
    const total = Number(countRows[0]?.count ?? 0);

    const rows = await applyRoutineRunFilters(db("job_results"), args, allowedIds)
      .select("job_results.*")
      .orderBy("job_results.createdAt", "desc")
      .offset((page - 1) * limit)
      .limit(limit);

    return {
      items: rows.map((row: any) => mapRoutineRunRow(row, routineById)),
      total,
    };
  };

  resolvers.Query["routineRunsNeedingAttentionCount"] = async (_, args, context) => {
    const user = context.user;
    const { db } = await postgresClient();
    const routineById = await readableRoutines(db, user);
    if (routineById.size === 0) {
      return 0;
    }
    const rows = await db("job_results")
      .where({ type: "workflow", state: JOB_STATUS_ENUM.waiting_approval })
      .whereIn("workflow", [...routineById.keys()])
      .count("* as count");
    return Number(rows[0]?.count ?? 0);
  };

  resolvers.Mutation["cancelRoutineRun"] = async (_, args, context) => {
    const user = context.user;
    const { db } = await postgresClient();
    const { row, routine } = await loadRoutineRunForWrite(db, user, args.id);

    const cancellable: string[] = [
      JOB_STATUS_ENUM.waiting,
      JOB_STATUS_ENUM.active,
      JOB_STATUS_ENUM.waiting_approval,
    ];
    if (!cancellable.includes(row.state)) {
      throw new Error(`Run is in state '${row.state}' and cannot be cancelled.`);
    }

    // Shared cancel path (spec §5.6): CAS to cancelled + best-effort BullMQ
    // job removal + stream-active cleanup — the SAME helper session deletion
    // (postprocessDeletion) uses. A lost CAS race after the check above is a
    // silent no-op (the run reached a terminal state concurrently).
    await cancelRoutineRunRow(db, row, ExuluQueues);

    const updated = await db.from("job_results").where({ id: row.id }).first();
    return mapRoutineRunRow(updated, new Map([[routine.id, routine]]));
  };

  resolvers.Mutation["retryRoutineRun"] = async (_, args, context) => {
    const user = context.user;
    const { db } = await postgresClient();
    const { row, routine } = await loadRoutineRunForWrite(db, user, args.id);

    if (row.state !== JOB_STATUS_ENUM.failed && row.state !== JOB_STATUS_ENUM.cancelled) {
      throw new Error(`Only failed or cancelled runs can be retried (state: '${row.state}').`);
    }

    const runMetadata = parseRunMetadata(row.metadata);
    const queueName =
      typeof runMetadata.queue_name === "string" ? runMetadata.queue_name : undefined;
    const entry = queueName ? ExuluQueues.list.get(queueName) : undefined;
    if (!entry) {
      // Pre-migration rows have no bookkeeping — an honest error beats a guess.
      throw new Error("No queue recorded for this run; it cannot be retried.");
    }
    const queueConfig = await entry.use();

    const moved = await casJobResultState(
      db,
      row.id,
      [JOB_STATUS_ENUM.failed, JOB_STATUS_ENUM.cancelled],
      JOB_STATUS_ENUM.waiting,
    );
    if (!moved) {
      throw new Error("Run state changed concurrently; retry aborted.");
    }
    await db.from("job_results").where({ id: row.id }).update({ error: null });

    const runAs = (runMetadata.run_as ?? {}) as { user?: number; role?: string };
    const jobData: BullMqJobData = {
      label: `Workflow Run ${row.workflow}`,
      trigger: "api",
      timeoutInSeconds: queueConfig.timeoutInSeconds || 180,
      type: "workflow",
      workflow: row.workflow,
      inputs: (runMetadata.inputs as Record<string, unknown>) ?? {},
      user: runAs.user ?? user.id,
      role: runAs.role ?? user.role?.id,
      session: row.session ?? undefined,
      jobResultId: row.id,
      // Resume from the failed step (spec §6) — 0 for runs that never started.
      resumeFromIndex:
        typeof runMetadata.current_step_index === "number" ? runMetadata.current_step_index : 0,
      triggerSource: (row.trigger as BullMqJobData["triggerSource"]) ?? undefined,
      triggerMetadata: row.trigger_metadata ? parseRunMetadata(row.trigger_metadata) : undefined,
    };
    await queueConfig.queue.add("workflow_run", jobData, {
      jobId: uuidv4(),
      attempts: queueConfig.retries || 3,
      removeOnComplete: 5000,
      removeOnFail: 10000,
      backoff: queueConfig.backoff || { type: "exponential", delay: 2000 },
    });

    const updated = await db.from("job_results").where({ id: row.id }).first();
    return mapRoutineRunRow(updated, new Map([[routine.id, routine]]));
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
    const agent = await exuluApp.get().agent(evalRun.agent_id);
    if (!agent) {
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

  // KB-5: generic job retry. Re-enqueues a FRESH job with the same name +
  // data (rather than BullMQ's job.retry(), which only works for failed jobs)
  // so it's robust across states and leaves a clean audit trail. Optionally
  // removes the original. Frontend gates this behind write permission.
  resolvers.Mutation["retryJob"] = async (_, args) => {
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
    const job = await config.queue.getJob(args.id);
    if (!job) {
      throw new Error("Job not found");
    }
    await config.queue.add(job.name, job.data);
    if (args.deleteOriginal) {
      await config.queue.remove(args.id);
    }
    return { success: true };
  };

  // Authorize the calling user against a transcription_jobs row. Mirrors the
  // checks the auto-CRUD does in createMutations.validateWriteAccess for RBAC
  // tables — required because the three custom transcription mutations bypass
  // the generated CRUD path.
  const assertOwnsTranscriptionJob = async (id: string, context: any) => {
    const { db, user } = context;
    if (!user) throw new Error("Authentication required");
    if (user.super_admin === true) return;
    const row = await db
      .from("transcription_jobs")
      .select(["created_by", "rights_mode"])
      .where({ id })
      .first();
    if (!row) throw new Error(`transcription_job ${id} not found`);
    if (row.rights_mode === "public") return;
    // `created_by` is a text column while `user.id` is an integer SERIAL, so
    // compare as strings — a raw `===` fails for the legitimate creator
    // ("1" === 1 → false). Matches utils/check-record-access.ts and the
    // auto-CRUD validateWriteAccess check.
    if (row.created_by != null && String(row.created_by) === String(user.id)) return;
    throw new Error("Not authorized to act on this transcription job");
  };

  resolvers.Mutation["transcriptionJobStart"] = async (_, args, context) => {
    const { user } = context;
    if (!user) throw new Error("Authentication required");
    if (!transcriptionClient.isConfigured()) {
      throw new Error(
        "TRANSCRIPTION_DISABLED: TRANSCRIPTION_SERVER not set on this server. " +
          "Ask the operator to start a whisper server with `npx @exulu/backend exulu-start-whisper`.",
      );
    }
    return transcriptionService.startJob({
      userId: user.id,
      s3Key: args.input.audio_s3key,
      filename: args.input.filename,
      title: args.input.title,
      language: args.input.language ?? undefined,
      num_speakers: args.input.num_speakers ?? undefined,
      hotwords: args.input.hotwords ?? undefined,
      project_id: args.input.project_id ?? null,
      target_rights_mode: args.input.target_rights_mode ?? null,
      target_rbac_users: args.input.target_rbac_users ?? undefined,
      target_rbac_roles: args.input.target_rbac_roles ?? undefined,
    });
  };

  resolvers.Mutation["transcriptionJobFinalize"] = async (_, args, context) => {
    await assertOwnsTranscriptionJob(args.id, context);
    const { item, row } = await transcriptionService.finalize(args.id, {
      title: args.input.title,
      speakers: args.input.speakers,
      project_id: args.input.project_id ?? null,
      target_rights_mode: args.input.target_rights_mode ?? null,
      target_rbac_users: args.input.target_rbac_users ?? undefined,
      target_rbac_roles: args.input.target_rbac_roles ?? undefined,
    });
    return { job: row, item_id: item.id };
  };

  resolvers.Mutation["transcriptionJobCancel"] = async (_, args, context) => {
    await assertOwnsTranscriptionJob(args.id, context);
    return transcriptionService.cancelJob(args.id);
  };

  resolvers.Mutation["meetingBotStart"] = async (_, args, context) => {
    const { user } = context;
    if (!user) throw new Error("Authentication required");
    if (!recallEnabled()) {
      throw new Error(`RECALL_DISABLED: ${RECALL_NOT_CONFIGURED_MESSAGE}`);
    }
    return recallService.createMeetingBot({
      userId: user.id,
      meeting_url: args.input.meeting_url,
      join_at: args.input.join_at ?? null,
      language: args.input.language ?? null,
      title: args.input.title ?? null,
      bot_name: args.input.bot_name ?? null,
      notify_chat: args.input.notify_chat ?? false,
      project_id: args.input.project_id ?? null,
      target_rights_mode: args.input.target_rights_mode ?? null,
      target_rbac_users: args.input.target_rbac_users ?? undefined,
      target_rbac_roles: args.input.target_rbac_roles ?? undefined,
      post_processing_prompts: args.input.post_processing_prompts ?? undefined,
    });
  };

  resolvers.Mutation["runTranscriptPostProcessing"] = async (_, args, context) => {
    await assertOwnsTranscriptionJob(args.id, context);
    await recallService.runOnePostProcessing(args.id, args.prompt_id, args.agent_id);
    const { db } = context;
    return db.from("transcription_jobs").where({ id: args.id }).first();
  };

  resolvers.Query["meetingRecordingUsage"] = async (_, __, context) => {
    if (!context.user) throw new Error("Authentication required");
    return recallService.getUsage();
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
    const models = parseRerankerModels(resolveLiteLLMConfigPath());
    return {
      items: models.map((m) => {
        const full: Record<string, any> = {
          id: m.model_name,
          name: m.model_name,
          description: m.description ?? "",
        };
        const object: Record<string, any> = {};
        requestedFields.forEach((field) => {
          object[field] = full[field];
        });
        return object;
      }),
    };
  };

  // ── Knowledge V2 (KB-3/KB-4): per-context health aggregates ──────────────
  // Computed only when a context query selects one of the aggregate fields,
  // so plain context reads pay nothing. All counts are over NON-archived
  // items; mirrors the frontend's pipeline-health probes exactly.
  const AGGREGATE_FIELDS = ["item_count", "chunk_total", "stuck_count", "stale_count"];
  const STALE_DAYS = 30;
  const computeContextAggregates = async (
    contextId: string,
  ): Promise<{
    item_count: number;
    chunk_total: number;
    stuck_count: number;
    stale_count: number;
  }> => {
    const empty = { item_count: 0, chunk_total: 0, stuck_count: 0, stale_count: 0 };
    try {
      const { db } = await postgresClient();
      const tableName = getTableName(contextId);
      if (!(await db.schema.hasTable(tableName))) return empty;

      const nonArchived = () => db(tableName).whereNot("archived", true);
      const staleCutoff = new Date(Date.now() - STALE_DAYS * 86_400_000).toISOString();

      const [itemRow, chunkRow, stuckRow, staleRow] = await Promise.all([
        nonArchived().count("* as c").first(),
        nonArchived().sum("chunks_count as s").first(),
        nonArchived()
          .andWhere((b) => b.whereNull("chunks_count").orWhere("chunks_count", "<=", 0))
          .count("* as c")
          .first(),
        nonArchived().where("embeddings_updated_at", "<=", staleCutoff).count("* as c").first(),
      ]);

      const num = (v: unknown) => (v == null ? 0 : Number(v));
      return {
        item_count: num((itemRow as { c?: unknown })?.c),
        chunk_total: num((chunkRow as { s?: unknown })?.s),
        stuck_count: num((stuckRow as { c?: unknown })?.c),
        stale_count: num((staleRow as { c?: unknown })?.c),
      };
    } catch (err) {
      console.error("[EXULU] computeContextAggregates failed for", contextId, err);
      return empty;
    }
  };

  resolvers.Query["contexts"] = async (_, args, context, info) => {
    const requestedTop = getRequestedFields(info);
    const wantsAggregates = AGGREGATE_FIELDS.some((f) => requestedTop.includes(f));
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
            const config = context.processor?.config;
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

        const aggregates = wantsAggregates
          ? await computeContextAggregates(context.id)
          : {};

        return {
          id: context.id,
          ...aggregates,
          name: context.name,
          description: context.description,
          embedder: context.embedder
            ? {
              model: context.embedder.model,
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
        const config = data.processor?.config;
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

    // KB-3/KB-4: compute health aggregates only when selected.
    const wantsAggregates = AGGREGATE_FIELDS.some((f) =>
      getRequestedFields(info).includes(f),
    );
    const aggregates = wantsAggregates ? await computeContextAggregates(data.id) : {};

    const clean = {
      id: data.id,
      ...aggregates,
      name: data.name,
      description: data.description,
      embedder: data.embedder
        ? {
          model: data.embedder.model,
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
    const instances = await exuluApp.get().agents();
    let agentTools = await Promise.all(
      instances.map(async (agent: ExuluAgent) => {
        const provider = await resolveAgentProvider(agent, providers);
        if (!provider) {
          return null;
        }
        return await provider.tool(agent.id, providers, contexts);
      }),
    );

    let agenticRetrievalTool: ExuluTool | undefined = undefined;

    const filtered: ExuluTool[] = agentTools.filter((tool) => tool !== null) as ExuluTool[];
    let allTools = [...filtered, ...tools];

    if (contexts?.length) {
      agenticRetrievalTool = createAgenticRetrievalTool({
        contexts: contexts,
        user: context.user,
        role: context.user?.role?.id,
        model: undefined, // irrelevant at this point as we only retrieve the tool information here, not execute it
      });
      if (agenticRetrievalTool) {
        allTools.push(agenticRetrievalTool);
      }
      // Picker entry for per-agent knowledge-base write access. Display-only:
      // getEnabledTools skips this id and the runtime expands the stored entry
      // into per-context create/update tools.
      allTools.push(createKbEditorPickerTool());
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
          } catch {
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

  resolvers.Query["getUniqueSkillTags"] = async (_, args, context, info) => {
    const { db } = context;
    const user = context.user;

    // Find the skills table definition to apply access control
    const skillTable = tables.find((t) => t.name.plural === "skills");
    if (!skillTable) {
      throw new Error("Skills table not found");
    }

    // Build query with access control
    let query = db.from("skills").select("tags");
    query = applyAccessControl(skillTable, query, user);

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
          } catch {
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
    chunk_metadata: JSON!
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
  authenticationInformation: String
  maxContextLength: Int
  capabilities: JSON
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
    """
    Health aggregates over non-archived items (knowledge V2 KB-3/KB-4).
    Computed lazily — only when one of these fields is selected — so plain
    context queries pay nothing. item_count: total; chunk_total: SUM of
    chunks_count; stuck_count: items with 0/NULL chunks; stale_count: items
    whose embeddings are older than 30 days.
    """
    item_count: Int
    chunk_total: Int
    stuck_count: Int
    stale_count: Int
}
type Reranker {
    id: ID!
    name: String!
    description: String
}
type Embedder {
    model: String!
    queue: String
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
  ${JOB_STATUS_ENUM.waiting_approval}
  ${JOB_STATUS_ENUM.filtered}
  ${JOB_STATUS_ENUM.cancelled}
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
