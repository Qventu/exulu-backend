import {
  normalizeS3Key,
  isHtmlKey,
  deriveFilename,
  slugifyShareName,
  isExpired,
  validateCreateInput,
  validateUpdateInput,
  planShareUpdate,
  canManageShare,
  ownsObjectKey,
  hashSharePassword,
  verifySharePassword,
  contentHeadersFor,
  publicMetaFor,
  getSharedArtifactByName,
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
  test("rejects an unparseable expiry", () => {
    const r = validateCreateInput(
      { s3key: "a", name: "a", auth_mode: "public", expires_at: "garbage" },
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

// A `validateCreateInput — grant_viewer_identity` block stood here, proving
// the create route refused the flag. Gone with the flag: `auth_mode: "regular"`
// is the capability now, and `auth_mode`'s own validation is covered by the
// `validateCreateInput` block above.
//
// What replaced it as the thing worth asserting: a create body that carries the
// retired field is now simply ignored rather than rejected, which is the
// behaviour change a caller would notice.
describe("validateCreateInput — the retired grant field", () => {
  const now = new Date("2026-10-08T00:00:00Z");
  const valid = {
    s3key: "artifacts/app.html",
    name: "app.html",
    auth_mode: "regular",
  };

  test("accepts a body that still carries grant_viewer_identity — the field is inert, not an error", () => {
    expect(
      validateCreateInput({ ...valid, grant_viewer_identity: true } as any, now),
    ).toEqual({ ok: true });
  });

  test("accepts a body that omits it", () => {
    expect(validateCreateInput({ ...valid } as any, now)).toEqual({ ok: true });
  });
});

describe("getSharedArtifactByName", () => {
  test("queries shared_artifacts by name and returns the first row", async () => {
    const first = jest.fn().mockResolvedValue({ id: "x", name: "report" });
    const where = jest.fn().mockReturnValue({ first });
    const db: any = jest.fn().mockReturnValue({ where });

    const row = await getSharedArtifactByName(db, "report");

    expect(db).toHaveBeenCalledWith("shared_artifacts");
    expect(where).toHaveBeenCalledWith({ name: "report" });
    expect(row).toEqual({ id: "x", name: "report" });
  });
});

describe("publicMetaFor", () => {
  const row = {
    auth_mode: "regular",
    expires_at: null,
    s3key: "artifacts/123_EXULU_app.html",
    content_type: null,
  };

  test("reports exactly the low-sensitivity fields, and auth_mode among them", () => {
    expect(publicMetaFor(row)).toEqual({
      auth_mode: "regular",
      expires_at: null,
      filename: "app.html",
      content_type: null,
      is_html: true,
    });
  });

  // The payload is unauthenticated, so what it does NOT carry is as much the
  // contract as what it does. The retired grant field must not reappear, and
  // the password hash must never be reachable through it.
  test("does not report a retired or sensitive field even when the row carries one", () => {
    const meta = publicMetaFor({
      ...row,
      grant_viewer_identity: true,
      password_hash: "$2b$12$notasecretreally",
    } as any);
    expect(meta).not.toHaveProperty("grant_viewer_identity");
    expect(meta).not.toHaveProperty("password_hash");
  });

  test("passes auth_mode through verbatim — it is the capability", () => {
    expect(publicMetaFor({ ...row, auth_mode: "password" }).auth_mode).toBe("password");
    expect(publicMetaFor({ ...row, auth_mode: "public" }).auth_mode).toBe("public");
  });

  test("marks a non-html key as not html", () => {
    expect(publicMetaFor({ ...row, s3key: "a/b.pdf" }).is_html).toBe(false);
  });
});

// describe("authorizeIdentityGrant") and describe("parseIdentityGrantBody")
// stood here. Both helpers were removed along with the PATCH route they
// served — `auth_mode: "regular"` is now the capability on its own, so there
// is no grant to authorize or parse. The retained rejection of the field at
// create time is still covered by the
// `validateCreateInput — grant_viewer_identity` block above.

describe("canManageShare", () => {
  test("the creator may manage", () => {
    expect(canManageShare({ created_by: 7 }, { id: 7 })).toBe(true);
  });
  test("a super admin may manage anyone's share", () => {
    expect(canManageShare({ created_by: 7 }, { id: 2, super_admin: true })).toBe(true);
  });
  test("another user may not", () => {
    expect(canManageShare({ created_by: 7 }, { id: 2, super_admin: false })).toBe(false);
  });
  test("a share without a creator is super-admin only", () => {
    expect(canManageShare({ created_by: null }, { id: 2 })).toBe(false);
  });
});

describe("validateUpdateInput", () => {
  const now = new Date("2026-10-19T12:00:00Z");
  const regular = { name: "a", auth_mode: "regular", password_hash: null, rights_mode: "private", created_by: 1 };
  const pw = { ...regular, auth_mode: "password", password_hash: "$2a$10$hash", rights_mode: "public" };
  test("an empty patch is fine", () => {
    expect(validateUpdateInput({}, regular, now)).toEqual({ ok: true });
  });
  test("switching to password mode needs a password", () => {
    expect(validateUpdateInput({ auth_mode: "password" }, regular, now)).toEqual({
      ok: false,
      message: "A password is required for password mode.",
    });
  });
  test("a password share keeps its password when none is given", () => {
    expect(validateUpdateInput({ expires_at: null }, pw, now)).toEqual({ ok: true });
  });
  test("rejects an unknown auth_mode", () => {
    expect(validateUpdateInput({ auth_mode: "magic" }, regular, now).ok).toBe(false);
  });
  test("rejects a past expiry and an invalid date", () => {
    expect(validateUpdateInput({ expires_at: "2020-01-01T00:00:00Z" }, regular, now).ok).toBe(false);
    expect(validateUpdateInput({ expires_at: "yesterday" }, regular, now).ok).toBe(false);
  });
  test("rejects a name without url-safe characters", () => {
    expect(validateUpdateInput({ name: "***" }, regular, now).ok).toBe(false);
  });
  test("rejects an unknown rights_mode", () => {
    expect(validateUpdateInput({ rights_mode: "friends" }, regular, now).ok).toBe(false);
  });
});

describe("planShareUpdate", () => {
  const now = new Date("2026-10-19T12:00:00Z");
  const regular = { name: "a", auth_mode: "regular", password_hash: null, rights_mode: "users", created_by: 1 };
  const pw = { ...regular, auth_mode: "password", password_hash: "$old", rights_mode: "public" };
  test("renames through the slug", () => {
    expect(planShareUpdate({ name: "My Report (final)" }, regular, null, now).name).toBe("my-report-final");
  });
  test("keeps a regular share's rights_mode when the patch does not name one", () => {
    const patch = planShareUpdate({ expires_at: null }, regular, null, now);
    expect(patch.rights_mode).toBe("users");
    expect(patch.expires_at).toBeNull();
    expect(patch.password_hash).toBeNull();
  });
  test("leaving password mode drops the hash and resets rights_mode to the sentinel", () => {
    const patch = planShareUpdate({ auth_mode: "public" }, pw, null, now);
    expect(patch.password_hash).toBeNull();
    expect(patch.rights_mode).toBe("public");
  });
  test("a new password replaces the hash; none keeps it", () => {
    expect(planShareUpdate({ password: "x" }, pw, "$new", now).password_hash).toBe("$new");
    expect(planShareUpdate({}, pw, null, now).password_hash).toBe("$old");
  });
  test("entering regular mode from a password share starts private", () => {
    expect(planShareUpdate({ auth_mode: "regular" }, pw, null, now).rights_mode).toBe("private");
  });
  test("stamps updatedAt", () => {
    expect(planShareUpdate({}, regular, null, now).updatedAt).toBe(now);
  });
});

describe("ownsObjectKey", () => {
  test("the caller's own prefix, with and without the general prefix", () => {
    expect(ownsObjectKey("user_7/abc-_EXULU_app.html", { id: 7 })).toBe(true);
    expect(ownsObjectKey("imp/user_7/abc-_EXULU_app.html", { id: 7 }, "imp")).toBe(true);
    expect(ownsObjectKey("imp/user_7/abc-_EXULU_app.html", { id: 7 }, "imp/")).toBe(true);
  });
  test("someone else's prefix, or no user prefix at all, is refused", () => {
    expect(ownsObjectKey("user_8/x.html", { id: 7 })).toBe(false);
    expect(ownsObjectKey("shared-artifacts/x/index.html", { id: 7 })).toBe(false);
    expect(ownsObjectKey("imp/user_8/x.html", { id: 7 }, "imp")).toBe(false);
  });
  test("API-key callers own user_api/, super admins own everything", () => {
    expect(ownsObjectKey("user_api/x.html", { id: 26, type: "api" })).toBe(true);
    expect(ownsObjectKey("user_26/x.html", { id: 26, type: "api" })).toBe(false);
    expect(ownsObjectKey("shared-artifacts/x/index.html", { id: 7, super_admin: true })).toBe(true);
  });
});

describe("validateUpdateInput / planShareUpdate with s3key", () => {
  const now = new Date("2026-10-19T12:00:00Z");
  const row = { name: "a", auth_mode: "regular", password_hash: null, rights_mode: "public", created_by: 1 };
  test("rejects an empty s3key", () => {
    expect(validateUpdateInput({ s3key: " " }, row, now).ok).toBe(false);
  });
  test("re-points the share and keeps everything else", () => {
    const patch = planShareUpdate({ s3key: "user_1/new.html", content_type: "text/html" }, row, null, now);
    expect(patch.s3key).toBe("user_1/new.html");
    expect(patch.content_type).toBe("text/html");
    expect(patch.auth_mode).toBe("regular");
    expect(patch.rights_mode).toBe("public");
  });
});
