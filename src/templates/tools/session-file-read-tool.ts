import { z } from "zod";
import { ExuluTool } from "@SRC/exulu/tool";
import { getPresignedUrl } from "@SRC/uppy";
import type { ExuluConfig } from "@SRC/exulu/app";
import type { User } from "@EXULU_TYPES/models/user";

const DEFAULT_LIMIT = 250;
/** Hard slice cap so a single read can never blow the context again. */
const MAX_CONTENT_CHARS = 16_000;

/**
 * Escape hatch for offloaded tool outputs and uploaded documents (spec §2):
 * page through any file in the session's S3 file folder by line range.
 * Registered for every session with file uploads configured — sandbox or not.
 */
export const createSessionFileReadTool = ({
  sessionID,
  user,
  exuluConfig,
}: {
  sessionID?: string;
  user?: User;
  exuluConfig?: ExuluConfig;
}): ExuluTool | undefined => {
  if (!sessionID || !exuluConfig?.fileUploads?.s3Bucket) return undefined;

  const readSessionFileExecute = async ({ filename, offset, limit }: { filename: string; offset?: number; limit?: number }) => {
    const safeName = String(filename ?? "").trim();
    if (!safeName || safeName.includes("..") || safeName.includes("/") || safeName.includes("\\")) {
      return {
        error: "Invalid filename — pass the bare file name exactly as listed in the session files (no paths).",
      };
    }
    const uploads = exuluConfig.fileUploads!;
    const generalPrefix = uploads.s3prefix ? `${uploads.s3prefix.replace(/\/$/, "")}/` : "";
    const key = `${generalPrefix}user_${user?.id ?? "api"}/sessions/${sessionID}/${safeName}`;
    try {
      const url = await getPresignedUrl(uploads.s3Bucket!, key, exuluConfig);
      const res = await fetch(url);
      if (!res.ok) {
        return { error: `Could not read session file "${safeName}" (status ${res.status}). Check the exact file name.` };
      }
      const textBody = await res.text();
      const lines = textBody.split("\n");
      const start = (offset ?? 1) - 1;
      const requested = limit ?? DEFAULT_LIMIT;
      const sliced = lines.slice(start, start + requested);
      let content = sliced.join("\n");
      let linesReturned = sliced.length;
      if (content.length > MAX_CONTENT_CHARS) {
        content = content.slice(0, MAX_CONTENT_CHARS);
        // Count only COMPLETE lines actually delivered so paging with
        // offset + linesReturned never skips content.
        linesReturned = Math.max(1, content.split("\n").length - 1);
        content = content + "\n[slice truncated — request fewer lines]";
      }
      return {
        content,
        totalLines: lines.length,
        offset: start + 1,
        linesReturned,
      };
    } catch (err) {
      return { error: `Failed to read session file "${safeName}": ${err instanceof Error ? err.message : "unknown error"}` };
    }
  };

  return ExuluTool.internal({
    id: "read_session_file",
    name: "read_session_file",
    description:
      "Read a line range from a file stored in this session's files — including offloaded tool outputs " +
      "(tool-output-*.txt) and uploaded documents. Use offset (1-based line number) and limit to page " +
      "through large files instead of reading everything at once.",
    inputSchema: z.object({
      filename: z
        .string()
        .describe('Exact session file name as referenced in a truncation notice, e.g. "tool-output-web_search-a1b2c3d4.txt"'),
      offset: z.number().int().min(1).optional().describe("1-based first line to read (default 1)"),
      limit: z.number().int().min(1).max(1000).optional().describe(`Number of lines to read (default ${DEFAULT_LIMIT})`),
    }),
    type: "function",
    category: "session",
    config: [],
    // ExuluTool's execute type is modeled on retrieval tools ({result/job/items});
    // internal utility tools return richer shapes (memory-tool has the same
    // mismatch). The AI SDK passes the object through verbatim, so cast.
    execute: readSessionFileExecute as never,
  });
};
