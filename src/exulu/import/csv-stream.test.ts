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
