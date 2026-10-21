import { Transform } from "node:stream";
import { parse } from "csv-parse";

export type CsvStreamHandlers = {
  onHeader: (headers: string[]) => void | Promise<void>;
  onRow: (cells: string[], index: number) => void | Promise<void>;
};

/**
 * Delimiters worth guessing between, in preference order -- a tie (or a
 * header line with none of them, i.e. a single column) resolves to the first,
 * `,`. Anything else must be passed explicitly.
 */
const CANDIDATE_DELIMITERS = [",", ";", "\t", "|"];

/** How much of the stream may be read looking for the end of the header line. */
const MAX_HEADER_BYTES = 64 * 1024;

/**
 * Guess a file's delimiter from its header line: the most frequent candidate
 * character *outside* quotes wins (so a quoted header cell containing a comma
 * -- `"name, long";qty` -- does not out-vote the real `;`).
 *
 * The browser preview (papaparse) auto-detects, so a user who mapped the
 * columns in the wizard expects the server to parse the same file the same
 * way; a `;`-delimited export (the German/Swiss Excel default) otherwise
 * parses as one column and aborts the run with NO_MAPPABLE_COLUMNS after the
 * whole file was already uploaded.
 */
export function sniffDelimiter(headerLine: string): string {
  const counts = new Map<string, number>(CANDIDATE_DELIMITERS.map((d) => [d, 0]));
  let inQuotes = false;
  for (const char of headerLine) {
    if (char === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (inQuotes) continue;
    const seen = counts.get(char);
    if (seen !== undefined) counts.set(char, seen + 1);
  }
  let best = CANDIDATE_DELIMITERS[0]!;
  let bestCount = 0;
  for (const candidate of CANDIDATE_DELIMITERS) {
    const count = counts.get(candidate) ?? 0;
    if (count > bestCount) {
      best = candidate;
      bestCount = count;
    }
  }
  return best;
}

/**
 * Forwards every byte through untouched while handing the first line to
 * `onFirstLine` as soon as it is complete (or at end-of-stream, for a file
 * with no line break at all). Used to learn the delimiter *before* the
 * csv-parse parser -- which needs it up front -- is created.
 *
 * The readable side is given a generous high-water mark: nothing consumes it
 * until the delimiter is known, so it must be able to buffer more than
 * MAX_HEADER_BYTES without back-pressuring its own writable side shut (which
 * would deadlock the sniff).
 */
function createSniffer(onFirstLine: (line: string) => void): Transform {
  const head: Buffer[] = [];
  let headBytes = 0;
  let resolved = false;
  const resolve = (line: string) => {
    if (resolved) return;
    resolved = true;
    onFirstLine(line);
  };

  return new Transform({
    readableHighWaterMark: 4 * MAX_HEADER_BYTES,
    transform(chunk, _encoding, callback) {
      if (!resolved) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
        head.push(buffer);
        headBytes += buffer.length;
        const text = Buffer.concat(head).toString("utf-8");
        const eol = /\r|\n/.exec(text);
        if (eol) {
          resolve(text.slice(0, eol.index));
        } else if (headBytes >= MAX_HEADER_BYTES) {
          resolve(text);
        }
      }
      callback(null, chunk);
    },
    flush(callback) {
      resolve(Buffer.concat(head).toString("utf-8"));
      callback();
    },
  });
}

/**
 * Stream-parse a CSV source, handing the header and each data row to
 * `handlers` one at a time. `onRow` (and `onHeader`) are awaited before the
 * next record is pulled from the parser, so a slow consumer back-pressures
 * the source instead of letting rows pile up in memory.
 *
 * The first record is the header (cells trimmed); `index` is 0-based over
 * data rows. A blank row (every cell empty after trim) is skipped and does
 * not consume an index.
 *
 * `opts.delimiter`, when given, is used verbatim; otherwise it is sniffed
 * from the header line (see `sniffDelimiter`).
 */
export async function streamCsvRows(
  input: NodeJS.ReadableStream,
  handlers: CsvStreamHandlers,
  opts?: { delimiter?: string },
): Promise<{ rows: number }> {
  let resolveFirstLine: (line: string) => void = () => {};
  const firstLine = new Promise<string>((resolve) => {
    resolveFirstLine = resolve;
  });
  const sniffer = createSniffer((line) => resolveFirstLine(line));

  // .pipe() does not forward 'error' from the source to the destination, so
  // an upstream failure (e.g. a broken S3 download) would otherwise surface
  // as an unhandled 'error' event instead of rejecting this promise.
  let parser: ReturnType<typeof parse> | undefined;
  let earlyError: Error | undefined;
  input.on("error", (err) => sniffer.destroy(err));
  sniffer.on("error", (err: Error) => {
    // Before the parser exists there is nothing to reject through, so unblock
    // the sniff and rethrow below; afterwards the parser owns the failure.
    if (parser) parser.destroy(err);
    else {
      earlyError = err;
      resolveFirstLine("");
    }
  });
  input.pipe(sniffer);

  const headerLine = await firstLine;
  if (earlyError) throw earlyError;
  // A BOM is stripped by the parser (`bom: true`) but would still be counted
  // as an ordinary character here -- it is not a candidate delimiter, so it
  // cannot change the outcome.
  const delimiter = opts?.delimiter ?? sniffDelimiter(headerLine);

  parser = parse({
    bom: true,
    relax_quotes: true,
    relax_column_count: true,
    skip_empty_lines: true,
    columns: false,
    delimiter,
    // csv-parse's auto record-delimiter discovery locks onto the first
    // line ending it sees (outside quotes) and never reconsiders -- a file
    // whose header ends in "\n" but has later rows ending in "\r\n" (or
    // vice versa) would then have the "\r" leak into field content instead
    // of being recognized as part of the delimiter. Listing all three EOL
    // styles up front avoids that trap for real-world, possibly
    // inconsistently-terminated uploads.
    record_delimiter: ["\r\n", "\n", "\r"],
  });
  sniffer.pipe(parser);

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
