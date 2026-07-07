import { randomUUID } from "node:crypto";
import { uploadFile } from "@SRC/uppy";
import type { ExuluConfig } from "./app";
import type { User } from "@EXULU_TYPES/models/user";
import { deriveContextBudget, estimateTokens } from "./context-budget";

export type ToolOutputGuardContext = {
  toolName: string;
  contextWindow?: number;
  sessionID?: string;
  user?: User;
  exuluConfig?: ExuluConfig;
};

export type TruncatedToolOutput = {
  truncated: true;
  notice: string;
  sessionFile?: string;
  preview: string;
};

/** ~1K tokens of head preview kept inline. */
const PREVIEW_CHARS = 4_000;

/**
 * Store the full serialized output in the session's S3 file folder (the same
 * layout GET /sessions/:id/files lists and the sandbox mirrors), so the model
 * can page through it with read_session_file and the user sees it in the
 * Session-files side panel. Best-effort: any failure degrades to undefined.
 */
const storeAsSessionFile = async (
  serialized: string,
  ctx: ToolOutputGuardContext,
): Promise<string | undefined> => {
  if (!ctx.sessionID || !ctx.exuluConfig?.fileUploads) return undefined;
  const safeTool = ctx.toolName.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 40);
  const name = `tool-output-${safeTool}-${randomUUID().slice(0, 8)}.txt`;
  try {
    await uploadFile(
      Buffer.from(serialized, "utf-8"),
      `sessions/${ctx.sessionID}/${name}`,
      ctx.exuluConfig,
      { contentType: "text/plain" },
      ctx.user?.id,
    );
    return name;
  } catch (err) {
    console.error("[EXULU] Failed to offload oversized tool output to session files.", err);
    return undefined;
  }
};

const buildNotice = (tokens: number, capTokens: number, sessionFile?: string): string =>
  sessionFile
    ? `Tool output truncated: ~${tokens.toLocaleString("en-US")} tokens (limit ${capTokens.toLocaleString("en-US")}). ` +
      `The FULL output is saved as session file "${sessionFile}" — call read_session_file with ` +
      `{ filename: "${sessionFile}", offset, limit } to read specific line ranges.`
    : `Tool output truncated: ~${tokens.toLocaleString("en-US")} tokens (limit ${capTokens.toLocaleString("en-US")}). ` +
      `The remainder was discarded — re-run the tool with narrower arguments.`;

/**
 * Universal cap+offload guard for tool outputs (spec §2). Under the cap the
 * value passes through UNCHANGED (same reference — callers rely on identity
 * to detect truncation). Over the cap the full output is offloaded and the
 * model receives a small object whose `notice` leads with the recovery path.
 */
export const guardToolOutput = async (
  value: unknown,
  ctx: ToolOutputGuardContext,
): Promise<unknown> => {
  if (value == null) return value;
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  if (typeof serialized !== "string") return value; // unserializable — leave alone
  const budget = deriveContextBudget(ctx.contextWindow);
  const tokens = estimateTokens(serialized);
  if (tokens <= budget.toolOutputCapTokens) return value;
  const sessionFile = await storeAsSessionFile(serialized, ctx);
  const result: TruncatedToolOutput = {
    truncated: true,
    notice: buildNotice(tokens, budget.toolOutputCapTokens, sessionFile),
    ...(sessionFile ? { sessionFile } : {}),
    preview: serialized.slice(0, PREVIEW_CHARS),
  };
  return result;
};

/**
 * Same guard for document text extracted from uploaded files
 * (provider.ts processFilePartsInMessages). Returns a string because the
 * extracted text is embedded in a `<file ...>` text part.
 */
export const guardExtractedFileText = async (
  filename: string,
  text: string,
  ctx: Omit<ToolOutputGuardContext, "toolName">,
): Promise<string> => {
  const budget = deriveContextBudget(ctx.contextWindow);
  const tokens = estimateTokens(text);
  if (tokens <= budget.toolOutputCapTokens) return text;
  const sessionFile = await storeAsSessionFile(text, { ...ctx, toolName: `upload-${filename}` });
  const notice = sessionFile
    ? `[Document "${filename}" truncated: ~${tokens.toLocaleString("en-US")} tokens. The full extracted text is saved as ` +
      `session file "${sessionFile}" — read specific parts with read_session_file (offset/limit).]`
    : `[Document "${filename}" truncated: ~${tokens.toLocaleString("en-US")} tokens — the remainder is unavailable.]`;
  return `${text.slice(0, PREVIEW_CHARS)}\n\n${notice}`;
};
