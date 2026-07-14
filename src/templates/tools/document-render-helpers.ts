import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const execFileAsync = promisify(execFile);
const MAX_STDOUT_BYTES = 64 * 1024 * 1024;

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
