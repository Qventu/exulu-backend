import { encodeS3KeyForCopySource } from "./index";

describe("encodeS3KeyForCopySource", () => {
  // The two pre-existing callers (skills version-snapshot, skills rename)
  // copy keys built from uuids, fixed segments ("v1"), and typically
  // ASCII-safe filenames. Verifying — not assuming — that this shape is
  // unchanged by the new encoding step, per the review finding that
  // introduced it.
  test("leaves ASCII-safe segments (uuid/version/filename) byte-identical", () => {
    const key = "skills/8f14e45f-ceea-4ab9-8e14-4c0d3e2b1a9f/v1/notes.md";
    expect(encodeS3KeyForCopySource(key)).toBe(key);
  });

  test("never escapes the '/' path separators themselves", () => {
    const key = "a/b/c/d";
    expect(encodeS3KeyForCopySource(key).split("/")).toHaveLength(4);
    expect(encodeS3KeyForCopySource(key)).not.toContain("%2F");
    expect(encodeS3KeyForCopySource(key)).not.toContain("%2f");
  });

  // This is the actual bug: a user-named filename (adopt's new call site)
  // routinely has spaces and non-ASCII characters, and CopySource is a
  // header value the SDK does not encode for us.
  test("percent-encodes spaces and unicode within a segment", () => {
    const key = "user_42/sessions/s1/abc-_EXULU_Grußkarte Entwurf.pdf";
    const encoded = encodeS3KeyForCopySource(key);
    expect(encoded).not.toContain(" ");
    expect(encoded.split("/")).toHaveLength(key.split("/").length);
  });

  test("round-trips per segment back to the original filename", () => {
    const key = "user_42/sessions/s1/abc-_EXULU_Grußkarte Entwurf.pdf";
    const encoded = encodeS3KeyForCopySource(key);
    const decoded = encoded.split("/").map((s) => decodeURIComponent(s)).join("/");
    expect(decoded).toBe(key);
  });

  // A literal "%" in a filename (e.g. "50% off.pdf") is correctly escaped
  // to "%25" so it round-trips rather than being misread as a partial
  // escape sequence by S3 on the receiving end.
  test("escapes a literal percent sign so it round-trips", () => {
    const key = "user_42/sessions/s1/abc-_EXULU_50% off.pdf";
    const encoded = encodeS3KeyForCopySource(key);
    const decoded = encoded.split("/").map((s) => decodeURIComponent(s)).join("/");
    expect(decoded).toBe(key);
  });
});
