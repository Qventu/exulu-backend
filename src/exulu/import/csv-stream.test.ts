import { Readable } from "stream";
import { streamCsvRows } from "./csv-stream";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const CSV = "﻿a,b\n1,\"x\ny\"\r\n2,\"he said \"\"hi\"\"\"\n,,\n";

function chunksOf(text: string, size: number): string[] {
  const parts: string[] = [];
  for (let i = 0; i < text.length; i += size) {
    parts.push(text.slice(i, i + size));
  }
  return parts;
}

describe("streamCsvRows", () => {
  it("parses headers and data rows, skips blank rows, and awaits onRow in order", async () => {
    const headerCalls: string[][] = [];
    const rowCalls: Array<{ cells: string[]; index: number }> = [];
    const completionOrder: number[] = [];

    const result = await streamCsvRows(Readable.from([CSV]), {
      onHeader: (headers) => {
        headerCalls.push(headers);
      },
      onRow: async (cells, index) => {
        if (index === 0 || index === 1) {
          await delay(1);
        }
        rowCalls.push({ cells, index });
        completionOrder.push(index);
      },
    });

    expect(headerCalls).toEqual([["a", "b"]]);
    expect(rowCalls.map((r) => r.cells)).toEqual([
      ["1", "x\ny"],
      ["2", 'he said "hi"'],
    ]);
    expect(rowCalls.map((r) => r.index)).toEqual([0, 1]);
    expect(completionOrder).toEqual([0, 1]);
    expect(result).toEqual({ rows: 2 });
  });

  it("yields identical rows whether the input arrives as one chunk or many small chunks", async () => {
    async function collect(input: NodeJS.ReadableStream): Promise<{
      headers: string[][];
      rows: Array<{ cells: string[]; index: number }>;
      result: { rows: number };
    }> {
      const headers: string[][] = [];
      const rows: Array<{ cells: string[]; index: number }> = [];
      const result = await streamCsvRows(input, {
        onHeader: (h) => {
          headers.push(h);
        },
        onRow: (cells, index) => {
          rows.push({ cells, index });
        },
      });
      return { headers, rows, result };
    }

    const whole = await collect(Readable.from([CSV]));
    const chunked = await collect(Readable.from(chunksOf(CSV, 7)));

    expect(chunked.headers).toEqual(whole.headers);
    expect(chunked.rows).toEqual(whole.rows);
    expect(chunked.result).toEqual(whole.result);
    expect(whole.result).toEqual({ rows: 2 });
  });
});

describe("delimiter handling", () => {
  async function collect(csv: string, opts?: { delimiter?: string }) {
    const headers: string[][] = [];
    const rows: string[][] = [];
    await streamCsvRows(
      Readable.from([csv]),
      {
        onHeader: (h) => {
          headers.push(h);
        },
        onRow: (cells) => {
          rows.push(cells);
        },
      },
      opts,
    );
    return { headers, rows };
  }

  it("still parses a comma-delimited file when no delimiter is supplied", async () => {
    const { headers, rows } = await collect("a,b\n1,2\n");
    expect(headers).toEqual([["a", "b"]]);
    expect(rows).toEqual([["1", "2"]]);
  });

  it("sniffs a semicolon-delimited file (the German/Swiss Excel default) from its header line", async () => {
    const { headers, rows } = await collect("name;qty;note\nShoe;5;ok\n");
    expect(headers).toEqual([["name", "qty", "note"]]);
    expect(rows).toEqual([["Shoe", "5", "ok"]]);
  });

  it("sniffs a tab-delimited file", async () => {
    const { headers, rows } = await collect("name\tqty\nShoe\t5\n");
    expect(headers).toEqual([["name", "qty"]]);
    expect(rows).toEqual([["Shoe", "5"]]);
  });

  it("sniffs a pipe-delimited file", async () => {
    const { headers, rows } = await collect("name|qty\nShoe|5\n");
    expect(headers).toEqual([["name", "qty"]]);
    expect(rows).toEqual([["Shoe", "5"]]);
  });

  it("ignores delimiter characters inside a quoted header cell", async () => {
    const { headers, rows } = await collect('"name, long";qty\nShoe;5\n');
    expect(headers).toEqual([["name, long", "qty"]]);
    expect(rows).toEqual([["Shoe", "5"]]);
  });

  it("sniffs across a BOM and a CRLF header line, and over small stream chunks", async () => {
    const csv = "﻿name;qty\r\nShoe;5\r\n";
    const headers: string[][] = [];
    const rows: string[][] = [];
    await streamCsvRows(Readable.from(chunksOf(csv, 3)), {
      onHeader: (h) => {
        headers.push(h);
      },
      onRow: (cells) => {
        rows.push(cells);
      },
    });
    expect(headers).toEqual([["name", "qty"]]);
    expect(rows).toEqual([["Shoe", "5"]]);
  });

  it("defaults to a comma for a single-column file with no delimiter at all", async () => {
    const { headers, rows } = await collect("name\nShoe\n");
    expect(headers).toEqual([["name"]]);
    expect(rows).toEqual([["Shoe"]]);
  });

  it("an explicitly supplied delimiter wins over sniffing", async () => {
    // The header line has more semicolons than commas, so sniffing would pick
    // ";" -- the explicit "," must be honoured instead.
    const { headers } = await collect("a,b;c;d\n1,2;3;4\n", { delimiter: "," });
    expect(headers).toEqual([["a", "b;c;d"]]);
  });
});

describe("source errors", () => {
  function failingStream(after: string | null): Readable {
    let emitted = false;
    return new Readable({
      read() {
        if (after !== null && !emitted) {
          emitted = true;
          this.push(after);
          return;
        }
        this.destroy(new Error("s3 download broke"));
      },
    });
  }

  it("rejects when the source fails before the header line is complete", async () => {
    await expect(
      streamCsvRows(failingStream(null), { onHeader: () => {}, onRow: () => {} }),
    ).rejects.toThrow("s3 download broke");
  });

  it("rejects when the source fails after the header line was parsed", async () => {
    await expect(
      streamCsvRows(failingStream("a,b\n1,2\n"), { onHeader: () => {}, onRow: () => {} }),
    ).rejects.toThrow("s3 download broke");
  });
});
