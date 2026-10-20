import { parse } from "csv-parse";

export type CsvStreamHandlers = {
  onHeader: (headers: string[]) => void | Promise<void>;
  onRow: (cells: string[], index: number) => void | Promise<void>;
};

/**
 * Stream-parse a CSV source, handing the header and each data row to
 * `handlers` one at a time. `onRow` (and `onHeader`) are awaited before the
 * next record is pulled from the parser, so a slow consumer back-pressures
 * the source instead of letting rows pile up in memory.
 *
 * The first record is the header (cells trimmed); `index` is 0-based over
 * data rows. A blank row (every cell empty after trim) is skipped and does
 * not consume an index.
 */
export async function streamCsvRows(
  input: NodeJS.ReadableStream,
  handlers: CsvStreamHandlers,
  opts?: { delimiter?: string },
): Promise<{ rows: number }> {
  const parser = parse({
    bom: true,
    relax_quotes: true,
    relax_column_count: true,
    skip_empty_lines: true,
    columns: false,
    delimiter: opts?.delimiter,
    // csv-parse's auto record-delimiter discovery locks onto the first
    // line ending it sees (outside quotes) and never reconsiders -- a file
    // whose header ends in "\n" but has later rows ending in "\r\n" (or
    // vice versa) would then have the "\r" leak into field content instead
    // of being recognized as part of the delimiter. Listing all three EOL
    // styles up front avoids that trap for real-world, possibly
    // inconsistently-terminated uploads.
    record_delimiter: ["\r\n", "\n", "\r"],
  });

  // .pipe() does not forward 'error' from the source to the destination, so
  // an upstream failure (e.g. a broken S3 download) would otherwise surface
  // as an unhandled 'error' event instead of rejecting this promise.
  input.on("error", (err) => parser.destroy(err));
  input.pipe(parser);

  let sawHeader = false;
  let index = 0;

  for await (const record of parser as AsyncIterable<string[]>) {
    if (!sawHeader) {
      sawHeader = true;
      await handlers.onHeader(record.map((cell) => cell.trim()));
      continue;
    }
    if (record.every((cell) => cell.trim() === "")) continue;
    await handlers.onRow(record, index);
    index++;
  }

  return { rows: index };
}
