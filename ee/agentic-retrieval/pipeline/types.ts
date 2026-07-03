import type { VectorSearchChunkResult } from "@SRC/graphql/resolvers/vector-search";

export type Chunk = VectorSearchChunkResult;
export type ChunkWithScore = Chunk & { rerank_score?: number; context?: { id: string; name: string } };

export type PhaseStep = {
  text: string;
  chunks?: ChunkWithScore[];
  toolCalls?: Array<{ name: string; id: string; input: unknown }>;
};

export type RoutingPhaseResult = {
  mainContexts: string[];
  fallbackContexts: string[];
  userPinnedItemIdsByContext: Map<string, Set<string>>;
  userRequestedPage: number | null;
  hasExplicitDocAndPage: boolean;
  steps: PhaseStep[];
};

export type MemoryPhaseResult = {
  memoryChunksForAnswer: ChunkWithScore[];
  memoryOverride: { active: boolean; chunks: ChunkWithScore[]; reason: string };
  memoryPinnedItemIds: Set<string>;
  updatedQuestion: string;
  updatedKeywords: string[];
  updatedImportantKeyword: string;
  steps: PhaseStep[];
};

export type SearchContextsResult = { chunks: Chunk[] };

export type RerankState = {
  pinnedItemIds: Set<string>;
  userPinnedItemIds: Set<string>;
  userRequestedPage: number | null;
  keywords: string[];
  importantKeyword: string;
};
export type RerankResult = {
  limited_results: ChunkWithScore[];
  sorted_reranked_results: ChunkWithScore[];
  rerank_score_max_genuine: number;
};

export type RetrievalStep = {
  stepNumber: number;
  text: string;
  toolCalls: Array<{ name: string; id: string; input: unknown }>;
  chunks: ChunkWithScore[];
  tokens: number;
};
export type AgenticRetrievalOutput = {
  steps: RetrievalStep[];
  reasoning: { text: string; tools: unknown[] }[];
  chunks: ChunkWithScore[];
  usage: unknown[];
  totalTokens: number;
};
