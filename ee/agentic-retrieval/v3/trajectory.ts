import * as fs from "fs/promises";
import * as path from "path";
import type { AgenticRetrievalOutput, ClassificationResult } from "./types";

/**
 * Module-level registry so external callers (e.g. test scripts) can read
 * the path of the most recently saved trajectory file.
 * Works because both the trajectory logger and the test run in the same process.
 */
export const trajectoryRegistry = {
  lastFile: undefined as string | undefined,
};

interface TrajectoryData {
  timestamp: string;
  query: string;
  classification: ClassificationResult;
  steps: {
    step_number: number;
    text: string;
    tool_calls: { name: string; id: string; input: any }[];
    chunks_retrieved: number;
    dynamic_tools_created: string[];
    tokens: number;
  }[];
  final: {
    total_chunks: number;
    total_steps: number;
    total_tokens: number;
    duration_ms: number;
    success: boolean;
    error?: string;
  };
}

export class TrajectoryLogger {
  private data: TrajectoryData;
  private startTime = Date.now();
  private logDir: string;

  constructor(
    query: string,
    classification: ClassificationResult,
    logDir = path.join(process.cwd(), "ee/agentic-retrieval/logs"),
  ) {
    this.logDir = logDir;
    this.data = {
      timestamp: new Date().toISOString(),
      query,
      classification,
      steps: [],
      final: {
        total_chunks: 0,
        total_steps: 0,
        total_tokens: 0,
        duration_ms: 0,
        success: false,
      },
    };
  }

  recordStep(step: AgenticRetrievalOutput["steps"][0]): void {
    this.data.steps.push({
      step_number: step.stepNumber,
      text: step.text,
      tool_calls: step.toolCalls,
      chunks_retrieved: step.chunks.length,
      dynamic_tools_created: step.dynamicToolsCreated,
      tokens: step.tokens,
    });
  }

  async finalize(output: AgenticRetrievalOutput, success: boolean, error?: Error): Promise<string | undefined> {
    this.data.final = {
      total_chunks: output.chunks.length,
      total_steps: output.steps.length,
      total_tokens: output.totalTokens,
      duration_ms: Date.now() - this.startTime,
      success,
      error: error?.message,
    };

    try {
      await fs.mkdir(this.logDir, { recursive: true });
      const filename = `trajectory_${Date.now()}.json`;
      const fullPath = path.join(this.logDir, filename);
      await fs.writeFile(fullPath, JSON.stringify(this.data, null, 2), "utf-8");
      console.log(`[EXULU] v3 trajectory saved: ${filename}`);
      trajectoryRegistry.lastFile = fullPath;
      return fullPath;
    } catch (e) {
      console.error("[EXULU] v3 failed to write trajectory:", e);
      return undefined;
    }
  }
}
