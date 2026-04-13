export type QueryType = "aggregate" | "list" | "targeted" | "exploratory";

export interface ClassificationResult {
  queryType: QueryType;
  language: string;
  /** IDs of contexts most likely relevant. Empty means search all. */
  suggestedContextIds: string[];
}

export interface ContextSample {
  contextId: string;
  contextName: string;
  /** All field names available on items (standard + custom) */
  fields: string[];
  /** Up to 2 example item records */
  exampleItems: Array<Record<string, any>>;
  sampledAt: number;
}

export interface ChunkResult {
  item_name: string;
  item_id: string;
  context: string;
  chunk_id?: string;
  chunk_index?: number;
  chunk_content?: string;
  metadata?: Record<string, any>;
}

export interface RetrievalStep {
  stepNumber: number;
  /** Text the model output during this step (reasoning) */
  text: string;
  toolCalls: Array<{ name: string; id: string; input: any }>;
  chunks: ChunkResult[];
  dynamicToolsCreated: string[];
  tokens: number;
}

interface Reasoning {
  text: string;
  tools: {
    name: string;
    id: string;
    input: any;
    output: any;
  }[]
}

export interface AgenticRetrievalOutput {
  steps: RetrievalStep[];
  reasoning: Reasoning[];
  /** All chunks collected across all steps */
  chunks: ChunkResult[];
  usage: any[];
  totalTokens: number;
  /** Path to the trajectory JSON file written to disk, if any */
  trajectoryFile?: string;
}
