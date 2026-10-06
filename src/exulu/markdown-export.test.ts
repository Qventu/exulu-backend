import { exportContentType, exportFilename } from "./markdown-export";

describe("exportContentType", () => {
  it("returns the Word content type for docx", () => {
    expect(exportContentType("docx")).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
  });

  it("returns the PDF content type for pdf", () => {
    expect(exportContentType("pdf")).toBe("application/pdf");
  });
});

describe("exportFilename", () => {
  it("combines the item name and field label with the format extension", () => {
    expect(exportFilename("Einplanung S-Line 2", "Guide", "docx")).toBe(
      "Einplanung_S-Line_2_-_Guide.docx",
    );
  });

  it("uses the pdf extension for pdf format", () => {
    expect(exportFilename("Einplanung S-Line 2", "Guide", "pdf")).toBe(
      "Einplanung_S-Line_2_-_Guide.pdf",
    );
  });

  it("strips characters that are unsafe in filenames", () => {
    const name = exportFilename('Report: "Q3" / <Final>', "Guide", "docx");
    expect(name).not.toMatch(/["/<>:]/);
    expect(name.endsWith(".docx")).toBe(true);
  });

  it("collapses whitespace into underscores", () => {
    expect(exportFilename("Two   Spaces", "Guide", "docx")).toBe("Two_Spaces_-_Guide.docx");
  });

  it("falls back to a generic name when everything is stripped away", () => {
    expect(exportFilename('///', "///", "docx")).toBe("export.docx");
  });

  it("truncates very long names so the filename stays reasonable", () => {
    const longName = "a".repeat(300);
    const name = exportFilename(longName, "Guide", "docx");
    expect(name.length).toBeLessThanOrEqual(160);
    expect(name.endsWith(".docx")).toBe(true);
  });
});

describe("exportContentType — transcript formats", () => {
  it("maps the three new transcript formats", () => {
    expect(exportContentType("md")).toBe("text/markdown; charset=utf-8");
    expect(exportContentType("csv")).toBe("text/csv; charset=utf-8");
    expect(exportContentType("srt")).toBe("application/x-subrip; charset=utf-8");
  });

  it("still maps the two office formats", () => {
    expect(exportContentType("docx")).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    expect(exportContentType("pdf")).toBe("application/pdf");
  });
});

describe("exportFilename — transcript formats", () => {
  it("uses the new extensions", () => {
    expect(exportFilename("Kick-off Comfort-Line", "transcript", "srt")).toBe(
      "Kick-off_Comfort-Line_-_transcript.srt",
    );
  });
});
