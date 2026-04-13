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
  text: string;
  toolCalls: Array<{ name: string; id: string; input: any }>;
  chunks: ChunkResult[];
  tokens: number;
}

export interface AgenticRetrievalOutput {
  steps: RetrievalStep[];
  reasoning: Array<{
    text: string;
    tools: { name: string; id: string; input: any; output: any }[];
  }>;
  chunks: ChunkResult[];
  usage: any[];
  totalTokens: number;
  trajectoryFile?: string;
}
