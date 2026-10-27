/**
 * Both chunkers call `tokenizer.free()` at the end of every `chunk()`
 * (sentence.ts, recursive.ts). That used to free the WASM encoder while
 * leaving `this.encoder` pointing at it, so the SECOND chunk() on an instance
 * dereferenced freed memory and threw "null pointer passed to rust".
 *
 * It made the batch form — advertised in both chunkers' own JSDoc examples —
 * unusable, because chunkBatch calls chunk() once per text on one instance.
 *
 * Spec: docs/superpowers/specs/2026-10-27-chunking-library-defects-design.md
 */
import { RecursiveChunker } from "./recursive";
import { SentenceChunker } from "./sentence";

// The ranks download is process-wide cached now, but it is still one real
// fetch for this file.
jest.setTimeout(60_000);

const FIRST = "First document. It has a couple of sentences in it.";
const SECOND = "Second document. It also has a couple of sentences.";

describe.each([
  ["SentenceChunker", () => SentenceChunker.create({ chunkSize: 128 })],
  ["RecursiveChunker", () => RecursiveChunker.create({ chunkSize: 128 })],
])("%s instance reuse", (_name, make) => {
  it("chunks a second text on the same instance", async () => {
    const chunker = await make();

    const first = await chunker(FIRST);
    expect(first.length).toBeGreaterThan(0);

    const second = await chunker(SECOND);
    expect(second.length).toBeGreaterThan(0);
    expect(second.map((c: { text: string }) => c.text).join(" ")).toContain("Second document");
  });

  it("chunks a batch, which runs chunk() once per text on one instance", async () => {
    const chunker = await make();

    const batches = await chunker([FIRST, SECOND]);

    expect(batches).toHaveLength(2);
    expect(batches[0]!.length).toBeGreaterThan(0);
    expect(batches[1]!.length).toBeGreaterThan(0);
    expect(batches[0]!.map((c: { text: string }) => c.text).join(" ")).toContain("First document");
    expect(batches[1]!.map((c: { text: string }) => c.text).join(" ")).toContain("Second document");
  });

  it("stays usable across several sequential calls", async () => {
    const chunker = await make();

    for (let i = 0; i < 4; i++) {
      const chunks = await chunker(`Document number ${i}. It has sentences worth counting.`);
      expect(chunks.length).toBeGreaterThan(0);
    }
  });
});
