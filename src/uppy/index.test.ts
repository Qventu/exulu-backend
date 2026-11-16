import { S3Client } from "@aws-sdk/client-s3";
import {
  buildStsPolicy,
  copyS3Object,
  encodeS3KeyForCopySource,
  getS3ObjectMetadata,
  mayUseGenericS3Route,
} from "./index";

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

describe("mayUseGenericS3Route", () => {
  const user = { type: "user", super_admin: false };
  test("denies a normal user on project keys, with and without general prefix", () => {
    expect(mayUseGenericS3Route("projects/x/files/a", user)).toBe(false);
    expect(mayUseGenericS3Route("pre/projects/x/files/a", user, "pre")).toBe(false);
    expect(mayUseGenericS3Route("pre/projects/x/files/a", user, "pre/")).toBe(false);
  });
  test("allows api users and super admins", () => {
    expect(mayUseGenericS3Route("projects/x/files/a", { type: "api" })).toBe(true);
    expect(mayUseGenericS3Route("projects/x/files/a", { super_admin: true })).toBe(true);
  });
  test("allows ordinary keys", () => {
    expect(mayUseGenericS3Route("user_1/a.pdf", user)).toBe(true);
    expect(mayUseGenericS3Route("pre/user_1/a.pdf", user, "pre")).toBe(true);
  });
});

describe("buildStsPolicy", () => {
  test("only the caller's own prefix", () => {
    const p = buildStsPolicy("bkt", 7, null);
    expect(p.Statement[0].Resource).toEqual(["arn:aws:s3:::bkt/user_7/*"]);
    expect(JSON.stringify(p)).not.toContain("global");
  });
  test("general prefix and api users", () => {
    expect(buildStsPolicy("bkt", "api", "pre/").Statement[0].Resource).toEqual([
      "arn:aws:s3:::bkt/pre/user_api/*",
    ]);
  });
});

describe("copyS3Object", () => {
  test("keeps metadata on copy", async () => {
    const send = jest.spyOn(S3Client.prototype, "send").mockResolvedValue({} as never);
    await copyS3Object("a/b", "c/d", {
      fileUploads: { s3Bucket: "bkt", s3region: "r", s3key: "k", s3secret: "s" },
    } as never);
    const cmd = send.mock.calls[0][0] as { input: Record<string, unknown> };
    expect(cmd.input.MetadataDirective).toBe("COPY");
    send.mockRestore();
  });
});

describe("getS3ObjectMetadata", () => {
  test("returns metadata, undefined on failure", async () => {
    const cfg = {
      fileUploads: { s3Bucket: "bkt", s3region: "r", s3key: "k", s3secret: "s" },
    } as never;
    const send = jest
      .spyOn(S3Client.prototype, "send")
      .mockResolvedValueOnce({ Metadata: { "exulu-origin": "agent" } } as never)
      .mockRejectedValueOnce(new Error("404"));
    expect(await getS3ObjectMetadata("k", cfg)).toEqual({ "exulu-origin": "agent" });
    expect(await getS3ObjectMetadata("k", cfg)).toBeUndefined();
    send.mockRestore();
  });
});
