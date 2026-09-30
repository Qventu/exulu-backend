/**
 * Export a markdown context-field's content as .docx / .pdf — the generic
 * "download this as Word/PDF" button for any ExuluContext field with
 * `type: "markdown"` (e.g. training guides). Pandoc and LibreOffice are
 * already required system dependencies for the docx skill (see
 * system-dependencies.ts), so this needs no new binaries or npm packages.
 *
 * Pandoc converts markdown (including embedded `data:image/...;base64,...`
 * URIs, verified against a real generated guide with embedded screenshots)
 * straight to .docx. There is no PDF path here: pandoc's default PDF export
 * needs a LaTeX engine, which is not one of the installed dependencies —
 * instead .docx -> .pdf goes through LibreOffice, exactly like the docx
 * skill's own PDF preview step.
 */
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * docx and pdf go through pandoc/LibreOffice (exportMarkdown below). md, csv
 * and srt are built as text by the transcript export builders and never
 * reach a converter.
 */
export type ExportFormat = "docx" | "pdf" | "md" | "csv" | "srt";

const MAX_FILENAME_LENGTH = 160;

const CONTENT_TYPES: Record<ExportFormat, string> = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pdf: "application/pdf",
  md: "text/markdown; charset=utf-8",
  csv: "text/csv; charset=utf-8",
  srt: "application/x-subrip; charset=utf-8",
};

export function exportContentType(format: ExportFormat): string {
  return CONTENT_TYPES[format];
}

/** Filesystem- and header-safe filename: "<item name> - <field label>.<ext>". */
export function exportFilename(
  itemName: string,
  fieldLabel: string,
  format: ExportFormat,
): string {
  const raw = `${itemName} - ${fieldLabel}`.trim();
  const safe = raw
    .replace(/[\\/:*?"<>|]+/g, "")
    .replace(/\s+/g, "_")
    .replace(/^[_-]+|[_-]+$/g, "");
  const base = /[a-zA-Z0-9]/.test(safe) ? safe : "export";
  const ext = `.${format}`;
  return base.slice(0, MAX_FILENAME_LENGTH - ext.length) + ext;
}

async function convertMarkdownToDocx(markdown: string, workDir: string): Promise<Buffer> {
  const mdPath = join(workDir, "input.md");
  const docxPath = join(workDir, "output.docx");
  await writeFile(mdPath, markdown, "utf-8");
  await execFileAsync("pandoc", [mdPath, "-o", docxPath], { timeout: 120_000 });
  return readFile(docxPath);
}

async function convertDocxToPdf(docxBytes: Buffer, workDir: string): Promise<Buffer> {
  const docxPath = join(workDir, "output.docx");
  await writeFile(docxPath, docxBytes);
  await execFileAsync(
    "soffice",
    ["--headless", "--convert-to", "pdf", "--outdir", workDir, docxPath],
    { timeout: 120_000 },
  );
  return readFile(join(workDir, "output.pdf"));
}

/** Converts markdown content to the requested format. Cleans up its own temp files. */
export async function exportMarkdown(markdown: string, format: ExportFormat): Promise<Buffer> {
  if (format !== "docx" && format !== "pdf") {
    throw new Error(`exportMarkdown only converts docx and pdf, got '${format}'`);
  }
  const workDir = await mkdtemp(join(tmpdir(), "exulu-md-export-"));
  try {
    const docx = await convertMarkdownToDocx(markdown, workDir);
    if (format === "docx") return docx;
    return await convertDocxToPdf(docx, workDir);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}
