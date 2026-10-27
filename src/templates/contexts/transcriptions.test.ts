import { transcriptChunker } from "@SRC/exulu/transcription/transcript-chunker";
import { transcriptionsContext } from "./transcriptions";

describe("transcriptionsContext", () => {
  /**
   * The regression this guards: the context shipped with no `chunker`, so
   * `context.chunker ?? defaultChunker` fell through to a chunker that reads
   * content/description/name — fields a transcript does not have — and every
   * saved transcript embedded a single title-only chunk.
   */
  it("supplies the transcript chunker, so the body is what gets embedded", () => {
    expect(transcriptionsContext.chunker).toBe(transcriptChunker);
  });

  it("keeps the transcript body in a field the transcript chunker reads", () => {
    const fieldNames = transcriptionsContext.fields.map((field) => field.name);
    expect(fieldNames).toContain("transcript_text");
    expect(fieldNames).toContain("raw_segments");
    expect(fieldNames).toContain("corrected_segments");
    expect(fieldNames).toContain("speakers");
  });
});
