/**
 * GET /transcription-items/:itemId/export — the reading view's Export menu.
 *
 * Deliberately not the generic markdown-field route
 * (routes.ts /contexts/:contextId/items/:itemId/export): the three Include
 * options mean the document is built per request, so there is no stored
 * field to point at, and csv/srt fall out of the same builders.
 *
 * Built from injected deps so the HTTP contract is unit-testable
 * (export-route.test.ts); routes.ts wires the real ones.
 *
 * Design doc: docs/superpowers/specs/2026-09-29-transcripts-redesign-design.md §3.2
 */
import type { Express, Request, Response } from "express";

import { exportContentType, exportFilename, type ExportFormat } from "../markdown-export";
import {
  buildTranscriptCsv,
  buildTranscriptMarkdown,
  buildTranscriptSrt,
  type TranscriptExportItem,
  type TranscriptExportOptions,
} from "./transcript-export";

export const TRANSCRIPT_EXPORT_ROUTE_PATH = "/transcription-items/:itemId/export";

/**
 * A job that has been reviewed but not published has no item yet — this is
 * how its transcript gets exported anyway. See TranscriptExportRouteDeps.getJob.
 */
export const TRANSCRIPT_JOB_EXPORT_ROUTE_PATH = "/transcription-jobs/:jobId/export";

const FORMATS: ExportFormat[] = ["md", "docx", "pdf", "csv", "srt"];

export type TranscriptExportRouteDeps = {
  authenticate: (
    req: Request,
  ) => Promise<{ user?: { id: number | string; role?: { id?: string } } | null; code?: number; message?: string }>;
  /** Reads through the context's own getItems({ user }), so RBAC applies. */
  getItem: (
    itemId: string,
    user: { id: number | string; role?: { id?: string } },
  ) => Promise<TranscriptExportItem | undefined>;
  /**
   * The job behind an unpublished transcript, or undefined when it is missing
   * or not the caller's. There is no item to hang RBAC on at this point, so
   * the implementation applies the job's own ownership check.
   */
  getJob?: (
    jobId: string,
    user: { id: number | string; role?: { id?: string } },
  ) => Promise<(TranscriptExportItem & { reviewed_at?: string | Date | null }) | undefined>;
  /** markdown-export.exportMarkdown — docx/pdf only. */
  convert: (markdown: string, format: "docx" | "pdf") => Promise<Buffer>;
};

/** A query flag is on unless it is explicitly "0" or "false". */
const flag = (value: unknown): boolean => value !== "0" && value !== "false";

export function registerTranscriptExportRoute(
  app: Express,
  deps: TranscriptExportRouteDeps,
): void {
  app.get(TRANSCRIPT_EXPORT_ROUTE_PATH, async (req: Request, res: Response) => {
    const auth = await deps.authenticate(req);
    if (!auth.user?.id) {
      res.status(auth.code ?? 401).json({ detail: auth.message ?? "Authentication required." });
      return;
    }

    const format = req.query.format as ExportFormat;
    if (!FORMATS.includes(format)) {
      res.status(400).json({ detail: `Query param 'format' must be one of ${FORMATS.join(", ")}.` });
      return;
    }

    const item = await deps.getItem(req.params.itemId as string, auth.user);
    if (!item) {
      // Same 404 for "missing" and "not allowed" — a 403 would confirm the
      // transcript exists to someone who may not know that.
      res.status(404).json({ detail: "Transcript not found, or you do not have access to it." });
      return;
    }

    const options: TranscriptExportOptions = {
      summary: flag(req.query.summary),
      timestamps: flag(req.query.timestamps),
      speakers: flag(req.query.speakers),
    };

    try {
      let body: string | Buffer;
      if (format === "csv") {
        body = buildTranscriptCsv(item, options);
      } else if (format === "srt") {
        body = buildTranscriptSrt(item, options);
      } else {
        const markdown = buildTranscriptMarkdown(item, options);
        body = format === "md" ? markdown : await deps.convert(markdown, format);
      }

      const filename = exportFilename(item.name ?? "transcript", "transcript", format);
      res.setHeader("Content-Type", exportContentType(format));
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${encodeURIComponent(filename)}"`,
      );
      res.send(body);
    } catch (err) {
      console.error("[EXULU] transcript export failed", err);
      res.status(500).json({ detail: "Export failed." });
    }
  });

  // Same shape as the item route above, for a job that has been reviewed but
  // deliberately not published yet. Two differences: the lookup (job, not
  // item) and the reviewed gate — a job with no reviewed_at is whatever the
  // recogniser produced, and serving that as a document would hand someone
  // an unchecked transcript that looks signed off.
  app.get(TRANSCRIPT_JOB_EXPORT_ROUTE_PATH, async (req: Request, res: Response) => {
    if (!deps.getJob) {
      res.status(404).json({ detail: "Transcript not found." });
      return;
    }
    const auth = await deps.authenticate(req);
    if (!auth.user?.id) {
      res.status(auth.code ?? 401).json({ detail: auth.message ?? "Authentication required." });
      return;
    }

    const format = req.query.format as ExportFormat;
    if (!FORMATS.includes(format)) {
      res.status(400).json({ detail: `Query param 'format' must be one of ${FORMATS.join(", ")}.` });
      return;
    }

    const job = await deps.getJob(req.params.jobId as string, auth.user);
    if (!job) {
      // Same 404 for "missing" and "not allowed" as the item route above.
      res.status(404).json({ detail: "Transcript not found, or you do not have access to it." });
      return;
    }
    if (!job.reviewed_at) {
      res.status(409).json({ detail: "This transcript has not been reviewed yet." });
      return;
    }

    const options: TranscriptExportOptions = {
      summary: flag(req.query.summary),
      timestamps: flag(req.query.timestamps),
      speakers: flag(req.query.speakers),
    };

    try {
      let body: string | Buffer;
      if (format === "csv") {
        body = buildTranscriptCsv(job, options);
      } else if (format === "srt") {
        body = buildTranscriptSrt(job, options);
      } else {
        const markdown = buildTranscriptMarkdown(job, options);
        body = format === "md" ? markdown : await deps.convert(markdown, format);
      }

      const filename = exportFilename(job.name ?? "transcript", "transcript", format);
      res.setHeader("Content-Type", exportContentType(format));
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${encodeURIComponent(filename)}"`,
      );
      res.send(body);
    } catch (err) {
      console.error("[EXULU] transcript job export failed", err);
      res.status(500).json({ detail: "Export failed." });
    }
  });
}
