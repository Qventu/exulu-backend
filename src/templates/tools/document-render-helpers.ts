import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const execFileAsync = promisify(execFile);
const MAX_STDOUT_BYTES = 64 * 1024 * 1024;

/**
 * officeparser only reads the modern XML-based Office/OpenDocument formats
 * (docx/pptx/xlsx/odt/odp/ods/pdf) — its own dispatch has no case for the
 * pre-2007 binary CFB formats or RTF, and falls through to an
 * "extensionUnsupported" error for all of them. parse-document-tool's own
 * OFFICE_EXTENSIONS set claims to support .doc/.xls/.ppt/.rtf, but every one
 * of those would hit that error unconverted. LibreOffice (already a system
 * dependency for the docx-manipulation skill and PDF previews) can convert
 * each to its modern equivalent first.
 */
const LEGACY_OFFICE_CONVERSION_TARGETS: Record<string, string> = {
  ".doc": "docx",
  ".xls": "xlsx",
  ".ppt": "pptx",
  ".rtf": "docx",
};

export function isLegacyOfficeFormat(ext: string): boolean {
  return ext in LEGACY_OFFICE_CONVERSION_TARGETS;
}

/**
 * Convert a legacy Office document (.doc/.xls/.ppt/.rtf) to its modern XML
 * equivalent via headless LibreOffice, so it can be handed to officeparser.
 */
export async function convertLegacyOfficeToModern(bytes: Buffer, ext: string): Promise<Buffer> {
  const target = LEGACY_OFFICE_CONVERSION_TARGETS[ext];
  if (!target) {
    throw new Error(`No modern-format conversion target registered for "${ext}"`);
  }
  const dir = await mkdtemp(join(tmpdir(), "exulu-officeconv-"));
  try {
    const inputPath = join(dir, `input${ext}`);
    await writeFile(inputPath, bytes);
    try {
      await execFileAsync(
        "soffice",
        ["--headless", "--convert-to", target, inputPath, "--outdir", dir],
        { timeout: 60_000, maxBuffer: MAX_STDOUT_BYTES },
      );
    } catch (err: unknown) {
      throw new Error(
        `LibreOffice could not convert the legacy "${ext}" file to ${target}: ` +
          (err instanceof Error ? err.message : String(err)),
      );
    }
    const outputPath = join(dir, `input.${target}`);
    if (!existsSync(outputPath)) {
      throw new Error(`LibreOffice produced no output converting "${ext}" to ${target}`);
    }
    return await readFile(outputPath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Extract the text layer of a PDF via poppler's pdftotext.
 * Returns raw stdout: pages separated by form-feed (\f) characters,
 * -layout preserves column/table alignment.
 */
export async function pdfToText(pdf: Buffer): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "exulu-parse-"));
  try {
    const inputPath = join(dir, "input.pdf");
    await writeFile(inputPath, pdf);
    // "-" writes to stdout — no output temp file needed.
    const { stdout } = await execFileAsync("pdftotext", ["-layout", inputPath, "-"], {
      timeout: 60_000,
      maxBuffer: MAX_STDOUT_BYTES,
    });
    return stdout;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Render one PDF page to PNG via poppler's pdftoppm.
 * -scale-to bounds the long edge, so no separate image library is needed.
 * Returns null when the requested page is beyond the document's last page
 * (pdftoppm exits with code 99 for out-of-range pages; a missing output file
 * is kept as a secondary safety net for poppler builds that exit 0 without output).
 */
export async function renderPdfPageToPng(
  pdf: Buffer,
  page: number,
  scaleTo: number,
): Promise<Buffer | null> {
  const dir = await mkdtemp(join(tmpdir(), "exulu-render-"));
  try {
    const inputPath = join(dir, "input.pdf");
    await writeFile(inputPath, pdf);
    try {
      await execFileAsync(
        "pdftoppm",
        ["-png", "-f", String(page), "-l", String(page), "-scale-to", String(scaleTo), inputPath, join(dir, "page")],
        { timeout: 60_000, maxBuffer: MAX_STDOUT_BYTES },
      );
    } catch (err: unknown) {
      // pdftoppm exits 99 when the requested page is beyond the last page —
      // that is the only failure that means "page not found".
      if ((err as { code?: unknown })?.code === 99) return null;
      throw err;
    }
    // pdftoppm names output page-<N>.png with zero-padding that depends on
    // the document's total page count — glob instead of guessing.
    const produced = (await readdir(dir)).find((f) => f.startsWith("page") && f.endsWith(".png"));
    // Safety net for poppler builds that exit 0 without producing output
    if (!produced) return null;
    return await readFile(join(dir, produced));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
