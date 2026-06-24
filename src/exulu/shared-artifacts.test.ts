import {
  normalizeS3Key,
  isHtmlKey,
  deriveFilename,
  slugifyShareName,
  isExpired,
  validateCreateInput,
  hashSharePassword,
  verifySharePassword,
  contentHeadersFor,
} from "./shared-artifacts";

describe("normalizeS3Key", () => {
  test("strips a leading bucket segment", () => {
    expect(normalizeS3Key("my-bucket/sessions/a/report.html", "my-bucket")).toBe(
      "sessions/a/report.html",
    );
  });
  test("leaves a bare key untouched", () => {
    expect(normalizeS3Key("sessions/a/report.html", "my-bucket")).toBe(
      "sessions/a/report.html",
    );
  });
  test("url-decodes segments", () => {
    expect(normalizeS3Key("sessions/a%20b/r.html", "my-bucket")).toBe(
      "sessions/a b/r.html",
    );
  });
});

describe("isHtmlKey", () => {
  test.each([
    ["a/b.html", true],
    ["a/b.htm", true],
    ["a/B.HTML", true],
    ["a/b.pdf", false],
    ["a/b.docx", false],
  ])("%s -> %s", (key, expected) => {
    expect(isHtmlKey(key)).toBe(expected);
  });
});

describe("deriveFilename", () => {
  test("returns the basename", () => {
    expect(deriveFilename("sessions/a/report.pdf")).toBe("report.pdf");
  });
  test("drops the _EXULU_ upload prefix", () => {
    expect(deriveFilename("uploads/9f3a_EXULU_quarterly.xlsx")).toBe("quarterly.xlsx");
  });
});

describe("slugifyShareName", () => {
  test("produces a url-safe slug from a key", () => {
    expect(slugifyShareName("uploads/9f3a_EXULU_Quarterly Report.pdf")).toBe(
      "quarterly-report.pdf",
    );
  });
});

describe("isExpired", () => {
  const now = new Date("2026-06-24T00:00:00Z");
  test("null never expires", () => {
    expect(isExpired(null, now)).toBe(false);
  });
  test("past date is expired", () => {
    expect(isExpired("2026-06-23T00:00:00Z", now)).toBe(true);
  });
  test("future date is not expired", () => {
    expect(isExpired("2026-06-25T00:00:00Z", now)).toBe(false);
  });
});

describe("validateCreateInput", () => {
  const now = new Date("2026-06-24T00:00:00Z");
  test("accepts a valid public input", () => {
    expect(
      validateCreateInput({ s3key: "a.html", name: "a", auth_mode: "public" }, now),
    ).toEqual({ ok: true });
  });
  test("rejects missing s3key", () => {
    const r = validateCreateInput({ name: "a", auth_mode: "public" }, now);
    expect(r.ok).toBe(false);
  });
  test("rejects bad auth_mode", () => {
    const r = validateCreateInput({ s3key: "a", name: "a", auth_mode: "nope" }, now);
    expect(r.ok).toBe(false);
  });
  test("password mode requires a password", () => {
    const r = validateCreateInput({ s3key: "a", name: "a", auth_mode: "password" }, now);
    expect(r.ok).toBe(false);
  });
  test("rejects a past expiry", () => {
    const r = validateCreateInput(
      { s3key: "a", name: "a", auth_mode: "public", expires_at: "2026-06-23T00:00:00Z" },
      now,
    );
    expect(r.ok).toBe(false);
  });
});

describe("password hashing", () => {
  test("hash then verify round-trips", async () => {
    const hash = await hashSharePassword("hunter2");
    expect(await verifySharePassword("hunter2", hash)).toBe(true);
    expect(await verifySharePassword("wrong", hash)).toBe(false);
  });
});

describe("contentHeadersFor", () => {
  test("html serves inline as text/html", () => {
    expect(contentHeadersFor("a/b.html", null, "b.html")).toEqual({
      contentType: "text/html; charset=utf-8",
    });
  });
  test("non-html serves as an attachment with the filename", () => {
    expect(contentHeadersFor("a/b.pdf", "application/pdf", "b.pdf")).toEqual({
      contentType: "application/pdf",
      disposition: 'attachment; filename="b.pdf"',
    });
  });
  test("falls back to octet-stream when content type unknown", () => {
    expect(contentHeadersFor("a/b.bin", null, "b.bin")).toEqual({
      contentType: "application/octet-stream",
      disposition: 'attachment; filename="b.bin"',
    });
  });
});
