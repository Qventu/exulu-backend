import * as fs from "fs/promises";
import * as path from "path";
import { exec } from "child_process";
import { promisify } from "util";
import { z } from "zod";
import { tool } from "ai";
import { postgresClient } from "@SRC/postgres/client";
import type { ExuluContext } from "@SRC/exulu/context";
import type { User } from "@EXULU_TYPES/models/user";
import { preprocessEmbedCalls } from "./embed-preprocessor";
import type { ChunkResult } from "./types";

const execAsync = promisify(exec);

const MAX_INLINE_CHARS = 20_000;
const MAX_GREP_OUTPUT_CHARS = 5_000;

// ──────────────────────────────────────────────────────────────────────────────
// SQL safety: only allow read-only statements
// ──────────────────────────────────────────────────────────────────────────────

const WRITE_PATTERN =
  /^\s*(INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|TRUNCATE|GRANT|REVOKE|VACUUM|ANALYZE|EXPLAIN\s+ANALYZE)\b/i;

function assertReadOnly(sql: string): void {
  if (WRITE_PATTERN.test(sql)) {
    throw new Error(
      "Only SELECT queries are allowed. Write operations (INSERT, UPDATE, DELETE, DROP, etc.) are not permitted.",
    );
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Chunk harvesting: extract ChunkResult objects from raw SQL result rows
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Tries to interpret a raw DB row as a ChunkResult.
 * The system prompt instructs the agent to use standard aliases, so we look for
 * those first and fall back to common alternative column names.
 */
export function rowToChunkResult(row: Record<string, any>): ChunkResult | null {
  const chunkId = row.chunk_id ?? row.id;
  const chunkContent = row.chunk_content ?? row.content;
  const itemId = row.item_id ?? row.source;
  const context = row.context ?? row.context_id;
  const itemName = row.item_name ?? row.name;

  // Require at minimum a chunk identifier and either content or an item reference
  if (!chunkId || (!chunkContent && !itemId)) return null;

  return {
    item_name: itemName ?? "",
    item_id: itemId ?? "",
    context: context ?? "",
    chunk_id: chunkId,
    chunk_index: row.chunk_index ?? undefined,
    chunk_content: chunkContent ?? undefined,
    metadata: row.metadata ?? row.chunk_metadata ?? undefined,
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Tool factory
// ──────────────────────────────────────────────────────────────────────────────

export type ToolFactoryParams = {
  contexts: ExuluContext[];
  user?: User;
  role?: string;
  sessionDir: string;
};

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export function createTools(params: ToolFactoryParams) {
  const { contexts, user, role, sessionDir } = params;
  let queryCount = 0;

  // ── execute_query ────────────────────────────────────────────────────────────

  const execute_query = tool({
    description: `Execute a read-only PostgreSQL SELECT query against the knowledge base.

Use this to search, filter, aggregate, and explore content. The database contains items
and chunks tables for each knowledge base (see schema in the system prompt).

Use embed('your text') anywhere in the query to generate a semantic search vector:
  embedding <=> embed('machine learning') AS distance

If the result exceeds ${(MAX_INLINE_CHARS / 1000).toFixed(0)}k characters it is saved to a file.
Use the grep tool to iteratively search the file for relevant information.`,
    inputSchema: z.object({
      sql: z.string().describe("A read-only SELECT (or WITH ... SELECT) PostgreSQL query"),
    }),
    execute: async ({ sql }) => {
      assertReadOnly(sql);

      let processedSql: string;
      try {
        processedSql = await preprocessEmbedCalls(sql, contexts, user, role);
      } catch (err: any) {
        return JSON.stringify({ error: `embed() preprocessing failed: ${err.message}` });
      }

      let rows: any[];
      try {
        const { db } = await postgresClient();
        const result = await db.raw(processedSql);
        rows = result.rows ?? [];
      } catch (err: any) {
        return JSON.stringify({ error: `Query failed: ${err.message}` });
      }

      const json = JSON.stringify(rows, null, 2);

      if (json.length <= MAX_INLINE_CHARS) {
        return json;
      }

      // Results are large — store to session dir and tell the agent to grep
      await fs.mkdir(sessionDir, { recursive: true });
      const filename = `query_${++queryCount}.json`;
      const filePath = path.join(sessionDir, filename);
      await fs.writeFile(filePath, json, "utf-8");

      return JSON.stringify({
        stored: true,
        file: filePath,
        row_count: rows.length,
        message: `Results too large to display (${rows.length} rows, ${(json.length / 1000).toFixed(1)}k chars). Stored at ${filePath}. Use the grep tool to search for relevant information.`,
        grep_hint: `grep -i "keyword" ${filePath}`,
      });
    },
  });

  // ── grep ─────────────────────────────────────────────────────────────────────

  const grep = tool({
    description: `Search a stored query result file using grep.

Use this after execute_query returns a file path because results were too large.
Iteratively narrow down the results with multiple grep calls.`,
    inputSchema: z.object({
      pattern: z.string().describe("Regular expression or literal string to search for"),
      file: z.string().describe("Absolute path to the file returned by execute_query"),
      context_lines: z
        .number()
        .int()
        .min(0)
        .max(10)
        .default(2)
        .describe("Number of lines of context to show around each match (default 2)"),
      case_insensitive: z
        .boolean()
        .default(true)
        .describe("Case-insensitive matching (default true)"),
    }),
    execute: async ({ pattern, file, context_lines, case_insensitive }) => {
      // Security: only allow reading from our session directory
      const resolvedFile = path.resolve(file);
      const resolvedSession = path.resolve(sessionDir);
      if (!resolvedFile.startsWith(resolvedSession)) {
        return JSON.stringify({
          error: `Access denied. Only files within the session directory (${sessionDir}) can be searched.`,
        });
      }

      // Verify file exists
      try {
        await fs.access(resolvedFile);
      } catch {
        return JSON.stringify({ error: `File not found: ${file}` });
      }

      const flags = [
        "-n",
        context_lines > 0 ? `-C${context_lines}` : "",
        case_insensitive ? "-i" : "",
      ]
        .filter(Boolean)
        .join(" ");

      // Escape pattern for shell to prevent injection
      const escapedPattern = pattern.replace(/'/g, `'\\''`);
      const cmd = `grep ${flags} '${escapedPattern}' '${resolvedFile}'`;

      let output: string;
      try {
        const { stdout } = await execAsync(cmd, { maxBuffer: 10 * 1024 * 1024 });
        output = stdout;
      } catch (err: any) {
        // grep exits with code 1 when no matches — that's not an error
        if (err.code === 1) {
          return JSON.stringify({ matches: 0, output: "No matches found." });
        }
        return JSON.stringify({ error: `grep failed: ${err.message}` });
      }

      if (output.length > MAX_GREP_OUTPUT_CHARS) {
        output =
          output.slice(0, MAX_GREP_OUTPUT_CHARS) +
          `\n... (output truncated at ${MAX_GREP_OUTPUT_CHARS} chars — refine your pattern to narrow results)`;
      }

      const lineCount = output.split("\n").filter(Boolean).length;
      return JSON.stringify({ matches: lineCount, output });
    },
  });

  return { execute_query, grep };
}

/**
 * Harvests ChunkResult objects from all tool results in a step.
 * Called after each agent step to collect any chunk-shaped rows the agent retrieved.
 */
export function harvestChunks(toolResults: any[]): ChunkResult[] {
  const chunks: ChunkResult[] = [];

  for (const result of toolResults ?? []) {
    const rawOutput = result.output ?? result.result;
    let parsed: any;
    try {
      parsed = typeof rawOutput === "string" ? JSON.parse(rawOutput) : rawOutput;
    } catch {
      continue;
    }

    // Array of rows (direct SELECT result)
    if (Array.isArray(parsed)) {
      for (const row of parsed) {
        if (row && typeof row === "object") {
          const chunk = rowToChunkResult(row);
          if (chunk) chunks.push(chunk);
        }
      }
    }
  }

  return chunks;
}
