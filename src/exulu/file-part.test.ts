import { classifyFilePart } from "./file-part";

describe("classifyFilePart — deciding whether a UIMessage file part is an image or a document", () => {
  it("classifies a persisted email image part that has no filename by its mediaType and names it from the URL", () => {
    const part = {
      type: "file" as const,
      mediaType: "image/png",
      url: "https://minio.example/algi/user_11/sessions/abc/image008.png?X-Amz-Signature=xyz",
    };
    expect(classifyFilePart(part)).toEqual({ kind: "image", mediaType: "image/png", filename: "image008.png" });
  });

  it("normalises the non-standard image/jpg media type to image/jpeg", () => {
    const part = { type: "file" as const, mediaType: "image/jpg", url: "https://minio.example/b/sessions/abc/image001.jpg" };
    expect(classifyFilePart(part).mediaType).toBe("image/jpeg");
  });

  it("derives the image media type from the filename extension when the declared type is not an image", () => {
    const part = { type: "file" as const, filename: "Typenschild.JPG", mediaType: "application/octet-stream" };
    expect(classifyFilePart(part)).toEqual({ kind: "image", mediaType: "image/jpeg", filename: "Typenschild.JPG" });
  });

  it("treats a named non-image as a document", () => {
    const part = {
      type: "file" as const,
      filename: "Angebot.docx",
      mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    };
    expect(classifyFilePart(part)).toEqual({ kind: "document", filename: "Angebot.docx" });
  });

  it("does not mistake a document whose name merely contains an image extension for an image", () => {
    const part = { type: "file" as const, filename: "scan.png.pdf", mediaType: "application/pdf" };
    expect(classifyFilePart(part).kind).toBe("document");
  });

  it("falls back to a generic name when nothing identifies the file", () => {
    expect(classifyFilePart({ type: "file" as const, mediaType: "application/pdf" })).toEqual({
      kind: "document",
      filename: "attachment",
    });
  });
});

describe("classifyFilePart — BMP images (email logos and camera exports from Windows)", () => {
  it("treats a .bmp filename as an image even when the declared type is generic", () => {
    const part = { type: "file" as const, filename: "Typenschild.bmp", mediaType: "application/octet-stream" };
    expect(classifyFilePart(part)).toEqual({ kind: "image", mediaType: "image/bmp", filename: "Typenschild.bmp" });
  });

  it("normalises the legacy x-ms-bmp / x-bmp media types to image/bmp", () => {
    expect(classifyFilePart({ type: "file" as const, mediaType: "image/x-ms-bmp", url: "https://x/oehf_logo.bmp" }).mediaType).toBe("image/bmp");
    expect(classifyFilePart({ type: "file" as const, mediaType: "image/x-bmp", url: "https://x/oehf_logo.bmp" }).mediaType).toBe("image/bmp");
  });
});
