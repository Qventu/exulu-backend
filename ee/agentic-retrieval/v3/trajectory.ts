import * as fs from "fs/promises";
import * as path from "path";
import type { AgenticRetrievalOutput, ClassificationResult, ChunkResult } from "./types";

export const trajectoryRegistry = {
  lastFile: undefined as string | undefined,
};

export interface TrajectoryStepData {
  stepNumber: number;
  systemPrompt: string;
  text: string;
  toolCalls: Array<{
    name: string;
    id: string;
    input: any;
    output?: any;
  }>;
  chunks: ChunkResult[];
  dynamicToolsCreated: string[];
  tokens: number;
}

interface TrajectoryData {
  timestamp: string;
  query: string;
  classification: ClassificationResult;
  preselectedItemIds?: string[];
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
  private richSteps: TrajectoryStepData[] = [];
  private startTime = Date.now();
  private logDir: string;

  constructor(
    query: string,
    classification: ClassificationResult,
    logDir = path.join(process.cwd(), "ee/agentic-retrieval/logs"),
    preselectedItemIds?: string[],
  ) {
    this.logDir = logDir;
    this.data = {
      timestamp: new Date().toISOString(),
      query,
      classification,
      preselectedItemIds: preselectedItemIds?.length ? preselectedItemIds : undefined,
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

  recordRichStep(data: TrajectoryStepData): void {
    this.richSteps.push(data);
  }

  private toMarkdown(durationMs: number, success: boolean, error?: Error): string {
    const totalTokens = this.richSteps.reduce((sum, s) => sum + s.tokens, 0);
    const totalChunks = this.richSteps.reduce((sum, s) => sum + s.chunks.length, 0);
    const status = success ? "✓ Success" : `✗ Failed${error ? `: ${error.message}` : ""}`;
    const lines: string[] = [];

    // ── Header ──────────────────────────────────────────────────────────────
    lines.push(`# Agentic Retrieval — ${this.data.timestamp}`);
    lines.push("");
    lines.push(`**Query:** ${this.data.query}  `);
    lines.push(
      `**Duration:** ${(durationMs / 1000).toFixed(1)}s | **Tokens:** ${totalTokens} | **Status:** ${status}`,
    );
    lines.push("");

    // ── Classification ───────────────────────────────────────────────────────
    lines.push("## Classification");
    lines.push("");
    lines.push(`- **Type:** \`${this.data.classification.queryType}\``);
    lines.push(`- **Language:** \`${this.data.classification.language}\``);
    const suggested = this.data.classification.suggestedContextIds;
    lines.push(
      `- **Suggested contexts:** ${suggested.length > 0 ? suggested.map((id) => `\`${id}\``).join(", ") : "*(all)*"}`,
    );
    if (this.data.preselectedItemIds?.length) {
      lines.push(
        `- **Preselected item IDs:** ${this.data.preselectedItemIds.map((id) => `\`${id}\``).join(", ")}`,
      );
    }
    lines.push("");
    lines.push("---");
    lines.push("");

    // ── System prompt (from step 1, collapsed) ───────────────────────────────
    const firstStep = this.richSteps[0];
    if (firstStep) {
      lines.push("## System Prompt");
      lines.push("");
      lines.push("<details>");
      lines.push("<summary>View system prompt</summary>");
      lines.push("");
      lines.push("```");
      lines.push(firstStep.systemPrompt);
      lines.push("```");
      lines.push("");
      lines.push("</details>");
      lines.push("");
      lines.push("---");
      lines.push("");
    }

    // ── Steps ────────────────────────────────────────────────────────────────
    for (const step of this.richSteps) {
      const toolLabel =
        step.toolCalls.map((tc) => `\`${tc.name}\``).join(", ") || "*(no tool calls)*";
      lines.push(`## Step ${step.stepNumber} — ${toolLabel}`);
      lines.push("");
      const dynLabel =
        step.dynamicToolsCreated.length > 0
          ? step.dynamicToolsCreated.map((t) => `\`${t}\``).join(", ")
          : "none";
      lines.push(
        `**Tokens:** ${step.tokens} | **Chunks retrieved:** ${step.chunks.length} | **Dynamic tools created:** ${dynLabel}`,
      );
      lines.push("");

      // Reasoning
      if (step.text) {
        lines.push("### Reasoning");
        lines.push("");
        lines.push(step.text);
        lines.push("");
      }

      // Tool calls
      if (step.toolCalls.length > 0) {
        lines.push("### Tool Calls");
        lines.push("");
        for (const [i, tc] of step.toolCalls.entries()) {
          lines.push(`#### ${i + 1}. \`${tc.name}\``);
          lines.push("");
          lines.push("**Input:**");
          lines.push("```json");
          lines.push(JSON.stringify(tc.input, null, 2));
          lines.push("```");
          lines.push("");

          if (tc.output !== undefined) {
            let parsedOutput: any;
            try {
              parsedOutput =
                typeof tc.output === "string" ? JSON.parse(tc.output) : tc.output;
            } catch {
              parsedOutput = tc.output;
            }
            const outputStr = JSON.stringify(parsedOutput, null, 2);
            const truncated = outputStr.length > 2000;
            lines.push("**Output:**");
            lines.push("```json");
            lines.push(truncated ? `${outputStr.slice(0, 2000)}\n… (truncated)` : outputStr);
            lines.push("```");
            lines.push("");
          }
        }
      }

      // Chunks table
      if (step.chunks.length > 0) {
        lines.push("### Chunks Retrieved");
        lines.push("");
        lines.push("| # | Item | Context | Chunk | Score |");
        lines.push("|---|------|---------|-------|-------|");
        for (const [i, c] of step.chunks.entries()) {
          const score =
            c.metadata?.hybrid_score ??
            c.metadata?.cosine_distance ??
            c.metadata?.fts_rank ??
            "—";
          const scoreStr = typeof score === "number" ? score.toFixed(4) : String(score);
          lines.push(
            `| ${i + 1} | ${c.item_name ?? "—"} | \`${c.context}\` | ${c.chunk_index ?? "—"} | ${scoreStr} |`,
          );
        }
        lines.push("");

        const withContent = step.chunks.filter((c) => c.chunk_content);
        if (withContent.length > 0) {
          lines.push("<details>");
          lines.push("<summary>View chunk content</summary>");
          lines.push("");
          for (const c of withContent) {
            lines.push(`**${c.item_name} (chunk ${c.chunk_index}):**`);
            lines.push("");
            const content = (c.chunk_content ?? "").trim();
            lines.push(`> ${content.split("\n").join("\n> ")}`);
            lines.push("");
          }
          lines.push("</details>");
          lines.push("");
        }
      }

      // Per-step system prompt addendum (only when it differs from step 1)
      if (firstStep && step.stepNumber > 1 && step.systemPrompt !== firstStep.systemPrompt) {
        const addendum = step.systemPrompt.slice(firstStep.systemPrompt.length).trim();
        if (addendum) {
          lines.push("<details>");
          lines.push("<summary>System prompt addendum (this step only)</summary>");
          lines.push("");
          lines.push("```");
          lines.push(addendum);
          lines.push("```");
          lines.push("");
          lines.push("</details>");
          lines.push("");
        }
      }

      lines.push("---");
      lines.push("");
    }

    // ── Summary ──────────────────────────────────────────────────────────────
    lines.push("## Summary");
    lines.push("");
    lines.push("| Metric | Value |");
    lines.push("|--------|-------|");
    lines.push(`| Steps | ${this.richSteps.length} |`);
    lines.push(`| Total chunks | ${totalChunks} |`);
    lines.push(`| Total tokens | ${totalTokens} |`);
    lines.push(`| Duration | ${(durationMs / 1000).toFixed(1)}s |`);
    lines.push(`| Status | ${status} |`);
    if (error) {
      lines.push(`| Error | ${error.message} |`);
    }
    lines.push("");

    return lines.join("\n");
  }

  async finalize(
    output: AgenticRetrievalOutput,
    success: boolean,
    error?: Error,
    writeFiles = false,
  ): Promise<string | undefined> {
    const durationMs = Date.now() - this.startTime;

    this.data.final = {
      total_chunks: output.chunks.length,
      total_steps: output.steps.length,
      total_tokens: output.totalTokens,
      duration_ms: durationMs,
      success,
      error: error?.message,
    };

    if (!writeFiles) return undefined;

    try {
      await fs.mkdir(this.logDir, { recursive: true });
      const ts = Date.now();
      const jsonPath = path.join(this.logDir, `trajectory_${ts}.json`);
      const mdPath = path.join(this.logDir, `trajectory_${ts}.md`);

      await Promise.all([
        fs.writeFile(jsonPath, JSON.stringify(this.data, null, 2), "utf-8"),
        fs.writeFile(mdPath, this.toMarkdown(durationMs, success, error), "utf-8"),
      ]);

      console.log(`[EXULU] v3 trajectory saved: trajectory_${ts}.json + trajectory_${ts}.md`);
      trajectoryRegistry.lastFile = jsonPath;
      return jsonPath;
    } catch (e) {
      console.error("[EXULU] v3 failed to write trajectory:", e);
      return undefined;
    }
  }
}
