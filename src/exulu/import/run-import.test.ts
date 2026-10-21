import { Readable } from "stream";
import { runImport } from "./run-import";
import type { ExistingRow, RunImportDeps } from "./run-import";
import type { ImportField } from "./mapping";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const fields: ImportField[] = [
  { name: "name", type: "shortText", required: true, core: true },
  { name: "external_id", type: "text", core: true },
  { name: "qty", type: "number" },
];

/** Builds RunImportDeps from a CSV string with recording fakes, overridable per test. */
function deps(csv: string, overrides: Partial<RunImportDeps> = {}): RunImportDeps {
  return {
    stream: Readable.from([csv]),
    fields,
    access: { rights_mode: "public" },
    options: {},
    user: { id: 7 },
    lookupExisting: jest.fn(async () => []),
    canWrite: jest.fn(() => true),
    createItem: jest.fn(async () => {}),
    updateItem: jest.fn(async () => {}),
    writeProgress: jest.fn(async () => {}),
    isCancelRequested: jest.fn(async () => false),
    uploadErrorReport: jest.fn(async () => "errors-key"),
    ...overrides,
  };
}

describe("runImport", () => {
  it("looks up the chunk's keys and creates the miss while updating the hit", async () => {
    const csv = "name,external_id,qty\nShoe X1,X1,5\nShoe X2,,7\n";
    const existing: ExistingRow = {
      id: "id-X1",
      external_id: "X1",
      rights_mode: "public",
      created_by: null,
    };
    const lookupExisting = jest.fn(async (_ids: string[], externalIds: string[]) =>
      externalIds.includes("X1") ? [existing] : [],
    );
    const d = deps(csv, { lookupExisting });

    const result = await runImport(d);

    expect(result.created).toBe(1);
    expect(result.updated).toBe(1);
    expect(lookupExisting).toHaveBeenCalledWith([], ["X1"]);
    expect(d.updateItem).toHaveBeenCalledWith("id-X1", { name: "Shoe X1", external_id: "X1", qty: 5 });
    expect(d.createItem).toHaveBeenCalledWith({
      name: "Shoe X2",
      external_id: "",
      qty: 7,
      rights_mode: "public",
    });
  });

  it("Review Focus 3: fails a row the user may not write, without calling updateItem", async () => {
    const csv = "name,external_id,qty\nItem,X9,3\n";
    const existing: ExistingRow = {
      id: "id-X9",
      external_id: "X9",
      rights_mode: "private",
      created_by: "9",
    };
    const d = deps(csv, {
      user: { id: 7 },
      lookupExisting: jest.fn(async () => [existing]),
      canWrite: jest.fn(
        (row: ExistingRow) => row.rights_mode === "public" || String(row.created_by) === "7",
      ),
    });

    const result = await runImport(d);

    expect(result.failed).toBe(1);
    expect(d.updateItem).not.toHaveBeenCalled();
    expect(d.uploadErrorReport).toHaveBeenCalledWith(expect.stringContaining("no write access"));
  });

  it("Review Focus 2: rejects with ImportAbort NO_MAPPABLE_COLUMNS when no column maps to a usable field", async () => {
    const csv = "foo,bar\n1,2\n";
    await expect(runImport(deps(csv))).rejects.toMatchObject({
      name: "ImportAbort",
      code: "NO_MAPPABLE_COLUMNS",
    });
  });

  it("Review Focus 2: rejects with ImportAbort EMPTY_FILE for an empty input", async () => {
    await expect(runImport(deps(""))).rejects.toMatchObject({
      name: "ImportAbort",
      code: "EMPTY_FILE",
    });
  });

  it("marks an invalid row invalid without writing it", async () => {
    const csv = "name,external_id,qty\nItem,X1,abc\n";
    const d = deps(csv);

    const result = await runImport(d);

    expect(result.invalid).toBe(1);
    expect(result.created).toBe(0);
    expect(result.updated).toBe(0);
    expect(d.createItem).not.toHaveBeenCalled();
    expect(d.updateItem).not.toHaveBeenCalled();
    expect(d.uploadErrorReport).toHaveBeenCalledWith(expect.stringContaining("qty:number"));
  });

  it("two rows sharing an external_id: the first is written, the second is invalid as a duplicate key", async () => {
    const csv = "name,external_id,qty\nA,X1,1\nB,X1,2\n";
    const d = deps(csv);

    const result = await runImport(d);

    expect(result.created).toBe(1);
    expect(result.invalid).toBe(1);
    expect(d.createItem).toHaveBeenCalledTimes(1);
    expect(d.uploadErrorReport).toHaveBeenCalledWith(expect.stringContaining("duplicateKey:external_id"));
  });

  it("Review Focus 4: stops before reading further rows once cancellation is observed", async () => {
    const csv = "name,external_id,qty\nA,,1\nB,,2\nC,,3\nD,,4\nE,,5\n";
    const d = deps(csv, { chunkRows: 2, isCancelRequested: jest.fn(async () => true) });

    const result = await runImport(d);

    expect(result.processed).toBe(2);
    expect(result.cancelled).toBe(true);
    expect(d.createItem).toHaveBeenCalledTimes(2);
  });

  it("ticks progress after every chunk and once more for the trailing partial chunk", async () => {
    const csv = "name,external_id,qty\nA,,1\nB,,2\nC,,3\nD,,4\nE,,5\n";
    const d = deps(csv, { chunkRows: 2 });

    const result = await runImport(d);

    expect(result.cancelled).toBe(false);
    const writeProgress = d.writeProgress as jest.Mock;
    expect(writeProgress).toHaveBeenCalledTimes(3);
    expect(writeProgress.mock.calls.map((call) => call[0].processed)).toEqual([2, 4, 5]);
  });

  it("pool: never runs more than `concurrency` writes in flight", async () => {
    const rows = ["A", "B", "C", "D", "E", "F"].map((n) => `${n},,1`).join("\n");
    const csv = `name,external_id,qty\n${rows}\n`;
    let inFlight = 0;
    let maxInFlight = 0;
    const createItem = jest.fn(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await delay(5);
      inFlight--;
    });
    const d = deps(csv, { chunkRows: 10, concurrency: 2, createItem });

    const result = await runImport(d);

    expect(result.created).toBe(6);
    expect(maxInFlight).toBe(2);
  });

  it("builds the error report CSV with a BOM, the original header, and RFC 4180 quoting, uploading only when rows are flagged", async () => {
    const csv = 'name,external_id,qty\nGood,G1,1\n,B1,2\n"Bad, Two",B2,abc\n';
    const d = deps(csv);

    const result = await runImport(d);

    expect(result.invalid).toBe(2);
    expect(result.created).toBe(1);
    expect(d.uploadErrorReport).toHaveBeenCalledWith(
      '﻿name,external_id,qty,import_error\n,B1,2,required:name\n"Bad, Two",B2,abc,qty:number',
    );
    expect(result.errorReportKey).toBe("errors-key");
  });

  it("does not upload an error report and leaves errorReportKey null when every row is clean", async () => {
    const csv = "name,external_id,qty\nGood,G1,1\n";
    const d = deps(csv);

    const result = await runImport(d);

    expect(d.uploadErrorReport).not.toHaveBeenCalled();
    expect(result.errorReportKey).toBeNull();
  });

  it("fix 1: a throwing canWrite fails only that row; the run completes with the message in the error report", async () => {
    const csv = "name,external_id,qty\nGood,G1,1\nThrows,T1,2\n";
    const existing = (id: string, externalId: string): ExistingRow => ({
      id,
      external_id: externalId,
      rights_mode: "public",
      created_by: null,
    });
    const d = deps(csv, {
      lookupExisting: jest.fn(async () => [existing("id-G1", "G1"), existing("id-T1", "T1")]),
      canWrite: jest.fn((row: ExistingRow) => {
        if (row.id === "id-T1") throw new Error("canWrite boom");
        return true;
      }),
    });

    const result = await runImport(d);

    expect(result.failed).toBe(1);
    expect(result.updated).toBe(1);
    expect(d.updateItem).toHaveBeenCalledTimes(1);
    expect(d.uploadErrorReport).toHaveBeenCalledWith(expect.stringContaining("canWrite boom"));
  });

  it("fix 1: a throwing lookupExisting fails every row of that chunk; the next chunk still runs", async () => {
    const csv = "name,external_id,qty\nA,X1,1\nB,X2,2\nC,X3,3\nD,X4,4\n";
    let calls = 0;
    const lookupExisting = jest.fn(async () => {
      calls++;
      if (calls === 1) throw new Error("db down");
      return [];
    });
    const d = deps(csv, { chunkRows: 2, lookupExisting });

    const result = await runImport(d);

    expect(result.failed).toBe(2);
    expect(result.created).toBe(2);
    expect(d.createItem).toHaveBeenCalledTimes(2);
    expect(d.uploadErrorReport).toHaveBeenCalledWith(expect.stringContaining("db down"));
  });

  it("fix 2: caps retained error lines at maxErrorLines, adding a truncation marker and flag", async () => {
    const csv = "name,external_id,qty\nR1,E1,abc\nR2,E2,abc\nR3,E3,abc\nR4,E4,abc\n";
    const d = deps(csv, { maxErrorLines: 2 });

    const result = await runImport(d);

    expect(result.invalid).toBe(4);
    expect(result.errorReportTruncated).toBe(true);
    expect(d.uploadErrorReport).toHaveBeenCalledWith(
      "﻿name,external_id,qty,import_error\nR1,E1,abc,qty:number\nR2,E2,abc,qty:number\n…,,,truncated: 2 more rows not listed",
    );
  });

  it("fix 3: does not consult isCancelRequested after the trailing partial chunk", async () => {
    const csv = "name,external_id,qty\nA,,1\nB,,2\nC,,3\nD,,4\nE,,5\n";
    let calls = 0;
    const isCancelRequested = jest.fn(async () => {
      calls++;
      return calls >= 3;
    });
    const d = deps(csv, { chunkRows: 2, isCancelRequested });

    const result = await runImport(d);

    expect(result.processed).toBe(5);
    expect(result.cancelled).toBe(false);
    expect(isCancelRequested).toHaveBeenCalledTimes(2);
  });
});
