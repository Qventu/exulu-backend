# Shareable Artifact Links Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user turn an S3 artifact into a shareable link (`<FRONTEND>/artifacts/<name>`) with a public/password/regular access mode and an expiry; HTML renders inline, everything else downloads.

**Architecture:** A new `shared_artifacts` table (backend, Knex) records the S3 key, auth mode, expiry, optional bcrypt password hash, and RBAC scoping. The backend exposes create/meta/content endpoints; the user-facing route lives in the **frontend** and authenticates per-share — `public`/`password` are gated by the frontend using a shared `INTERNAL_SECRET` (`internal-key` header), `regular` forwards the viewer's bearer token so the backend enforces RBAC. A shared `ShareArtifactDialog` is wired into three places: the session-files row, the message-renderer file tiles, and inline next to S3 URLs detected in message text.

**Tech Stack:** Backend — Node 22, Express 5, Knex/Postgres, jest, bcryptjs. Frontend — Next.js 16 (app router), next-auth 4, vitest, react-markdown (`Response`), Tailwind/shadcn UI.

**Two repos:** `backend` = `/Users/daniel.claessen/Desktop/Projects/exulu/backend`, `frontend` = `/Users/daniel.claessen/Desktop/Projects/exulu/frontend`. Every task header names its repo. The spec lives at `backend/docs/superpowers/specs/2026-06-22-artifacts-html-rendering-design.md`.

## Global Constraints

- **Backend tests:** `jest` (run from `backend/`). Convention: unit-test pure helpers, not Express routes via supertest. New backend logic goes in a testable service module; routes are thin wrappers.
- **Frontend tests:** `vitest run` (run from `frontend/`).
- **Backend imports** use explicit `.ts` extensions and path aliases `@SRC`, `@EE`, `@EXULU_TYPES`.
- **Password hashing:** `bcryptjs` (already a backend dep), cost factor `10`.
- **S3 key storage:** always store the **bare** object key (bucket prefix stripped). The default bucket is `config.fileUploads.s3Bucket`.
- **Internal auth:** backend trusts the `internal-key` request header when it equals `process.env.INTERNAL_SECRET` (`authentication({ internalkey, db })` returns a synthetic user with `role.id === "internal"`). New routes must read `req.headers["internal-key"]` directly — the generic validator does not pass it.
- **`auth_mode` values:** `"public" | "password" | "regular"`, default `"regular"`.
- **Type dispatch:** HTML = key ending `.html`/`.htm` → render inline in a **sandboxed** iframe; everything else → download via `Content-Disposition: attachment`.
- **Frontend env (new):** `INTERNAL_SECRET` (server-only, must equal backend's) and `COMPANION_S3_ENDPOINT` (the S3 base URL, exposed to the client via `/api/config` as `s3_endpoint`).

---

## File Structure

**Backend (create):**
- `src/exulu/shared-artifacts.ts` — pure helpers + thin DB accessor (the testable core).
- `src/exulu/shared-artifacts.test.ts` — jest unit tests.

**Backend (modify):**
- `src/postgres/core-schema.ts` — add `sharedArtifactsSchema` + register in `coreSchemas.get()`.
- `src/postgres/core-schema.test.ts` — (create) assert the new schema shape.
- `src/postgres/init-exulu-db.ts` — destructure + add to the `up()` schema list.
- `src/exulu/routes.ts` — register `POST /shared-artifacts`, `GET /shared-artifacts/:name/meta`, `GET /shared-artifacts/:name/content`.

**Frontend (create):**
- `lib/artifacts/detect-s3-url.ts` + `.test.ts` — pure URL detection / key extraction.
- `lib/artifacts/share-name.ts` + `.test.ts` — pure share-name slug.
- `lib/api/shared-artifacts.ts` — REST client (`create`).
- `components/artifacts/share-artifact-dialog.tsx` — the shared dialog.
- `components/artifacts/share-link-anchor.tsx` — inline S3-link + share CTA (used by `Response`).
- `app/artifacts/[artifact_name]/page.tsx` — the route (server component).
- `app/artifacts/[artifact_name]/content/route.ts` — byte-serving route handler.
- `app/artifacts/[artifact_name]/password-gate.tsx` — password form (client).
- `app/artifacts/[artifact_name]/actions.ts` — server action to set the password cookie.
- `app/artifacts/[artifact_name]/ui.tsx` — small `Centered` / `AutoDownload` helpers.

**Frontend (modify):**
- `app/api/config/route.ts` — expose `s3_endpoint`.
- `app/api/config/route.test.ts` — (create) assert `s3_endpoint` present.
- `app/(application)/chat/components/session-files/file-row.tsx` — add Share button.
- `components/primitives/file-picker.tsx` — add Share button to `FileItem` action row.
- `components/ai-elements/response.tsx` — delegate the `a` renderer to `ShareLinkAnchor`.

---

## Task 1 (backend): `shared_artifacts` table

**Files:**
- Modify: `src/postgres/core-schema.ts` (add schema near `oauthTokensSchema` ~line 682; register in `coreSchemas.get()` ~line 782)
- Create: `src/postgres/core-schema.test.ts`
- Modify: `src/postgres/init-exulu-db.ts:11-38` (destructure) and `:72-98` (schema list)

**Interfaces:**
- Produces: `coreSchemas.get().sharedArtifactsSchema(): ExuluTableDefinition` with table `shared_artifacts` and fields `name, s3key, auth_mode, password_hash, expires_at, content_type` plus RBAC-added `rights_mode, created_by`.

- [ ] **Step 1: Write the failing test**

Create `src/postgres/core-schema.test.ts`:

```ts
import { coreSchemas } from "./core-schema";

describe("shared_artifacts schema", () => {
  test("is registered with the expected shape", () => {
    const schema = coreSchemas.get().sharedArtifactsSchema();
    expect(schema.name.plural).toBe("shared_artifacts");
    expect(schema.name.singular).toBe("shared_artifact");
    const fieldNames = schema.fields.map((f) => f.name);
    expect(fieldNames).toEqual(
      expect.arrayContaining([
        "name",
        "s3key",
        "auth_mode",
        "password_hash",
        "expires_at",
        "content_type",
        "rights_mode", // added by addCoreFields because RBAC: true
        "created_by",
      ]),
    );
    const nameField = schema.fields.find((f) => f.name === "name");
    expect(nameField?.unique).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/daniel.claessen/Desktop/Projects/exulu/backend && npx jest src/postgres/core-schema.test.ts`
Expected: FAIL — `sharedArtifactsSchema is not a function` (not yet registered).

- [ ] **Step 3: Add the schema definition**

In `src/postgres/core-schema.ts`, after `oauthTokensSchema` (around line 682) add:

```ts
const sharedArtifactsSchema: ExuluTableDefinition = {
  type: "shared_artifacts",
  name: {
    plural: "shared_artifacts",
    singular: "shared_artifact",
  },
  // RBAC drives the "regular" auth_mode: rights_mode + the rbac table scope
  // who may view. public/password modes ignore rights_mode.
  RBAC: true,
  fields: [
    { name: "name", type: "text", index: true, unique: true },
    { name: "s3key", type: "text", required: true },
    { name: "auth_mode", type: "text", default: "regular" },
    { name: "password_hash", type: "text", required: false }, // bcrypt; password mode only
    { name: "expires_at", type: "date", required: false }, // null = no expiry
    { name: "content_type", type: "text", required: false },
  ],
};
```

- [ ] **Step 4: Register in `coreSchemas.get()`**

In `src/postgres/core-schema.ts`, in the `schemas` object (after the `imageGenerationsSchema` line ~782) add:

```ts
      sharedArtifactsSchema: (): ExuluTableDefinition => addCoreFields(sharedArtifactsSchema),
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd /Users/daniel.claessen/Desktop/Projects/exulu/backend && npx jest src/postgres/core-schema.test.ts`
Expected: PASS.

- [ ] **Step 6: Wire into `init-exulu-db.ts`**

In `src/postgres/init-exulu-db.ts`, add `sharedArtifactsSchema` to the destructure (after `oauthTokensSchema,` at line ~37):

```ts
  oauthTokensSchema,
  sharedArtifactsSchema,
} = coreSchemas.get();
```

And add it to the `schemas` array inside `up()` (after `oauthTokensSchema(),` at line ~91):

```ts
    oauthTokensSchema(),
    sharedArtifactsSchema(),
```

- [ ] **Step 7: Commit**

```bash
cd /Users/daniel.claessen/Desktop/Projects/exulu/backend
git add src/postgres/core-schema.ts src/postgres/core-schema.test.ts src/postgres/init-exulu-db.ts
git commit -m "feat(shared-artifacts): add shared_artifacts table"
```

---

## Task 2 (backend): shared-artifacts service — pure helpers

**Files:**
- Create: `src/exulu/shared-artifacts.ts`
- Create: `src/exulu/shared-artifacts.test.ts`

**Interfaces:**
- Produces:
  - `normalizeS3Key(key: string, bucket: string): string`
  - `isHtmlKey(key: string): boolean`
  - `deriveFilename(key: string): string`
  - `slugifyShareName(input: string): string`
  - `isExpired(expiresAt: string | Date | null | undefined, now: Date): boolean`
  - `validateCreateInput(input: CreateShareInput, now: Date): { ok: true } | { ok: false; message: string }`
  - `hashSharePassword(password: string): Promise<string>`
  - `verifySharePassword(password: string, hash: string): Promise<boolean>`
  - `contentHeadersFor(key, contentType, filename): { contentType: string; disposition?: string }`
  - types `ShareAuthMode`, `CreateShareInput`

- [ ] **Step 1: Write the failing test**

Create `src/exulu/shared-artifacts.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/daniel.claessen/Desktop/Projects/exulu/backend && npx jest src/exulu/shared-artifacts.test.ts`
Expected: FAIL — module `./shared-artifacts` not found.

- [ ] **Step 3: Write the implementation**

Create `src/exulu/shared-artifacts.ts`:

```ts
import bcrypt from "bcryptjs";

export type ShareAuthMode = "public" | "password" | "regular";

export type CreateShareInput = {
  s3key?: string;
  name?: string;
  auth_mode?: string;
  password?: string;
  expires_at?: string | null;
  content_type?: string | null;
};

/** Strip a leading bucket segment so we always store/serve the bare object key. */
export const normalizeS3Key = (key: string, bucket: string): string => {
  const segments = key
    .split("/")
    .filter((s, i) => !(i === 0 && s === "")) // tolerate a leading slash
    .map((s) => decodeURIComponent(s));
  if (segments[0] === bucket) segments.shift();
  return segments.join("/");
};

export const isHtmlKey = (key: string): boolean => /\.html?$/i.test(key);

/** Basename, minus the `<id>_EXULU_` upload prefix used by the file picker. */
export const deriveFilename = (key: string): string => {
  const base = key.split("/").pop() ?? key;
  return base.split("_EXULU_").pop() ?? base;
};

export const slugifyShareName = (input: string): string =>
  deriveFilename(input)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");

export const isExpired = (
  expiresAt: string | Date | null | undefined,
  now: Date,
): boolean => {
  if (!expiresAt) return false;
  return new Date(expiresAt).getTime() <= now.getTime();
};

export const validateCreateInput = (
  input: CreateShareInput,
  now: Date,
): { ok: true } | { ok: false; message: string } => {
  if (!input.s3key) return { ok: false, message: "s3key is required." };
  if (!input.name) return { ok: false, message: "name is required." };
  const mode = input.auth_mode;
  if (mode !== "public" && mode !== "password" && mode !== "regular") {
    return { ok: false, message: "auth_mode must be public, password, or regular." };
  }
  if (mode === "password" && !input.password) {
    return { ok: false, message: "A password is required for password mode." };
  }
  if (input.expires_at && new Date(input.expires_at).getTime() <= now.getTime()) {
    return { ok: false, message: "expires_at must be in the future." };
  }
  return { ok: true };
};

export const hashSharePassword = (password: string): Promise<string> =>
  bcrypt.hash(password, 10);

export const verifySharePassword = (
  password: string,
  hash: string,
): Promise<boolean> => bcrypt.compare(password, hash);

export const contentHeadersFor = (
  key: string,
  contentType: string | null,
  filename: string,
): { contentType: string; disposition?: string } => {
  if (isHtmlKey(key)) return { contentType: "text/html; charset=utf-8" };
  return {
    contentType: contentType || "application/octet-stream",
    disposition: `attachment; filename="${filename.replace(/"/g, "")}"`,
  };
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/daniel.claessen/Desktop/Projects/exulu/backend && npx jest src/exulu/shared-artifacts.test.ts`
Expected: PASS (all suites green).

- [ ] **Step 5: Commit**

```bash
cd /Users/daniel.claessen/Desktop/Projects/exulu/backend
git add src/exulu/shared-artifacts.ts src/exulu/shared-artifacts.test.ts
git commit -m "feat(shared-artifacts): add pure service helpers"
```

---

## Task 3 (backend): shared-artifacts DB accessor + getSharedArtifactByName

**Files:**
- Modify: `src/exulu/shared-artifacts.ts`
- Modify: `src/exulu/shared-artifacts.test.ts`

**Interfaces:**
- Produces: `getSharedArtifactByName(db: Knex, name: string): Promise<any>` — fetches one row by name (used by all three routes).

- [ ] **Step 1: Write the failing test**

Append to `src/exulu/shared-artifacts.test.ts`:

```ts
import { getSharedArtifactByName } from "./shared-artifacts";

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/daniel.claessen/Desktop/Projects/exulu/backend && npx jest src/exulu/shared-artifacts.test.ts -t getSharedArtifactByName`
Expected: FAIL — `getSharedArtifactByName is not exported`.

- [ ] **Step 3: Implement**

Append to `src/exulu/shared-artifacts.ts`:

```ts
import type { Knex } from "knex";

export const getSharedArtifactByName = (db: Knex, name: string) =>
  db("shared_artifacts").where({ name }).first();
```

(Place the `import type { Knex }` line with the other imports at the top.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/daniel.claessen/Desktop/Projects/exulu/backend && npx jest src/exulu/shared-artifacts.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/daniel.claessen/Desktop/Projects/exulu/backend
git add src/exulu/shared-artifacts.ts src/exulu/shared-artifacts.test.ts
git commit -m "feat(shared-artifacts): add getSharedArtifactByName accessor"
```

---

## Task 4 (backend): register the three routes

**Files:**
- Modify: `src/exulu/routes.ts` (imports near top; route registration inside `createExpressRoutes`, alongside the other `app.get`/`app.post` handlers — e.g. after the agents route block around line 720)

**Interfaces:**
- Consumes: `getSharedArtifactByName`, `normalizeS3Key`, `slugifyShareName`, `validateCreateInput`, `hashSharePassword`, `verifySharePassword`, `isExpired`, `deriveFilename`, `isHtmlKey`, `contentHeadersFor` (Task 2/3); `getS3ObjectBytes` (already imported `routes.ts:22`); `checkRecordAccess` (already imported `routes.ts:39`); `requestValidators` (`routes.ts:2`); `handleRBACUpdate` (`@EE/rbac-update.ts`); `authentication` (`@SRC/auth/auth.ts`); `config` (param of `createExpressRoutes`).
- Produces: HTTP routes `POST /shared-artifacts`, `GET /shared-artifacts/:name/meta`, `GET /shared-artifacts/:name/content`.

> No jest test (matches the repo convention — routes aren't supertest-tested; their logic is covered by Tasks 2–3). Verify manually in Step 4.

- [ ] **Step 1: Add imports**

At the top of `src/exulu/routes.ts`, add:

```ts
import { authentication } from "@SRC/auth/auth.ts";
import { handleRBACUpdate } from "@EE/rbac-update.ts";
import {
  getSharedArtifactByName,
  normalizeS3Key,
  slugifyShareName,
  validateCreateInput,
  hashSharePassword,
  verifySharePassword,
  isExpired,
  deriveFilename,
  contentHeadersFor,
} from "./shared-artifacts.ts";
```

- [ ] **Step 2: Register the routes**

Inside `createExpressRoutes`, near the other route handlers, add:

```ts
  // ── Shareable artifacts ──────────────────────────────────────────────
  // Create a share link. Authed as the real user; RBAC scoping for regular mode.
  app.post("/shared-artifacts", async (req: Request, res: Response) => {
    const { db } = await postgresClient();
    const auth = await requestValidators.authenticate(req);
    if (!auth.user?.id) {
      res.status(401).json({ detail: "Authentication required." });
      return;
    }
    const now = new Date();
    const valid = validateCreateInput(req.body, now);
    if (!valid.ok) {
      res.status(400).json({ detail: valid.message });
      return;
    }
    const bucket = config.fileUploads?.s3Bucket ?? "";
    const s3key = normalizeS3Key(req.body.s3key, bucket);
    const name = slugifyShareName(req.body.name);
    if (!name) {
      res.status(400).json({ detail: "name must contain url-safe characters." });
      return;
    }
    const existing = await getSharedArtifactByName(db, name);
    if (existing) {
      res.status(409).json({ detail: "That share name is already taken." });
      return;
    }
    const auth_mode = req.body.auth_mode as "public" | "password" | "regular";
    const password_hash =
      auth_mode === "password" ? await hashSharePassword(req.body.password) : null;
    const rights_mode =
      auth_mode === "regular" ? (req.body.rights_mode ?? "private") : "public";

    const [row] = await db("shared_artifacts")
      .insert({
        name,
        s3key,
        auth_mode,
        password_hash,
        expires_at: req.body.expires_at ?? null,
        content_type: req.body.content_type ?? null,
        rights_mode,
        created_by: auth.user.id,
      })
      .returning("*");

    if (auth_mode === "regular" && req.body.rbac) {
      await handleRBACUpdate(db, "shared_artifact", row.id, req.body.rbac, []);
    }
    res.status(201).json({ name: row.name });
  });

  // Resolve the gate. internal-key only; never returns the hash or bytes.
  app.get("/shared-artifacts/:name/meta", async (req: Request, res: Response) => {
    const { db } = await postgresClient();
    const internalkey = (req.headers["internal-key"] as string) || undefined;
    const a = await authentication({ internalkey, db });
    if (a.error || a.user?.role?.id !== "internal") {
      res.status(401).json({ detail: "Internal key required." });
      return;
    }
    const row = await getSharedArtifactByName(db, req.params.name);
    if (!row) {
      res.status(404).json({ detail: "Not found." });
      return;
    }
    if (isExpired(row.expires_at, new Date())) {
      res.status(410).json({ detail: "This link has expired." });
      return;
    }
    res.json({
      auth_mode: row.auth_mode,
      expires_at: row.expires_at,
      filename: deriveFilename(row.s3key),
      content_type: row.content_type,
      is_html: /\.html?$/i.test(row.s3key),
    });
  });

  // Serve bytes. Auth depends on the row's auth_mode.
  app.get("/shared-artifacts/:name/content", async (req: Request, res: Response) => {
    const { db } = await postgresClient();
    const row = await getSharedArtifactByName(db, req.params.name);
    if (!row) {
      res.status(404).json({ detail: "Not found." });
      return;
    }
    if (isExpired(row.expires_at, new Date())) {
      res.status(410).json({ detail: "This link has expired." });
      return;
    }

    const internalkey = (req.headers["internal-key"] as string) || undefined;
    if (row.auth_mode === "public") {
      const a = await authentication({ internalkey, db });
      if (a.error) {
        res.status(401).json({ detail: "Internal key required." });
        return;
      }
    } else if (row.auth_mode === "password") {
      const a = await authentication({ internalkey, db });
      if (a.error) {
        res.status(401).json({ detail: "Internal key required." });
        return;
      }
      const pw = (req.headers["x-share-password"] as string) || "";
      if (!row.password_hash || !(await verifySharePassword(pw, row.password_hash))) {
        res.status(401).json({ detail: "Incorrect password." });
        return;
      }
    } else {
      // regular: viewer's bearer token; backend enforces RBAC.
      const viewer = await requestValidators.authenticate(req);
      if (!viewer.user?.id) {
        res.status(401).json({ detail: "Authentication required." });
        return;
      }
      const ok = await checkRecordAccess(row, "read", viewer.user);
      if (!ok) {
        res.status(403).json({ detail: "You don't have access to this artifact." });
        return;
      }
    }

    let bytes: Buffer;
    try {
      bytes = await getS3ObjectBytes(row.s3key, config);
    } catch (e: any) {
      if (
        e?.name === "NoSuchKey" ||
        e?.name === "NotFound" ||
        e?.$metadata?.httpStatusCode === 404
      ) {
        res.status(404).json({ detail: "Artifact file not found." });
        return;
      }
      console.error("[EXULU] shared-artifact content read failed", e);
      res.status(500).json({ detail: "Failed to read artifact." });
      return;
    }

    const headers = contentHeadersFor(
      row.s3key,
      row.content_type,
      deriveFilename(row.s3key),
    );
    res.setHeader("Content-Type", headers.contentType);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "private, no-store");
    if (headers.disposition) res.setHeader("Content-Disposition", headers.disposition);
    res.send(bytes);
  });
```

- [ ] **Step 3: Type-check the backend**

Run: `cd /Users/daniel.claessen/Desktop/Projects/exulu/backend && npx tsc --noEmit`
Expected: no errors in `src/exulu/routes.ts` or `src/exulu/shared-artifacts.ts`.

- [ ] **Step 4: Manual smoke test**

With the backend running and a known `.html` S3 key and a real API key/bearer:

```bash
# Create a public share
curl -s -X POST "$BACKEND/shared-artifacts" \
  -H "exulu-api-key: $APIKEY" -H "Content-Type: application/json" \
  -d '{"s3key":"<bucket>/sessions/x/report.html","name":"report.html","auth_mode":"public","expires_at":null}'
# → {"name":"report.html"}

# Meta with the internal key
curl -s "$BACKEND/shared-artifacts/report.html/meta" -H "internal-key: $INTERNAL_SECRET"
# → {"auth_mode":"public","is_html":true,...}

# Content with the internal key
curl -si "$BACKEND/shared-artifacts/report.html/content" -H "internal-key: $INTERNAL_SECRET" | head -20
# → 200, Content-Type: text/html
```

Expected: create returns the name; meta returns `auth_mode/is_html`; content returns `200 text/html`. A meta call without `internal-key` → `401`.

- [ ] **Step 5: Commit**

```bash
cd /Users/daniel.claessen/Desktop/Projects/exulu/backend
git add src/exulu/routes.ts
git commit -m "feat(shared-artifacts): add create/meta/content routes"
```

---

## Task 5 (frontend): expose `s3_endpoint` via /api/config

**Files:**
- Modify: `app/api/config/route.ts`
- Create: `app/api/config/route.test.ts`

**Interfaces:**
- Produces: `/api/config` JSON now includes `s3_endpoint: string | undefined` (from `COMPANION_S3_ENDPOINT`).

- [ ] **Step 1: Write the failing test**

Create `app/api/config/route.test.ts`:

```ts
import { describe, test, expect, beforeEach, vi } from "vitest";
import { GET } from "./route";

describe("/api/config", () => {
  beforeEach(() => {
    vi.stubEnv("BACKEND", "http://backend.test");
    vi.stubEnv("COMPANION_S3_ENDPOINT", "https://s3.test/bucket");
  });

  test("includes s3_endpoint from COMPANION_S3_ENDPOINT", async () => {
    const res = await GET(new Request("http://localhost/api/config"));
    const json = await res.json();
    expect(json.s3_endpoint).toBe("https://s3.test/bucket");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/daniel.claessen/Desktop/Projects/exulu/frontend && npx vitest run app/api/config/route.test.ts`
Expected: FAIL — `json.s3_endpoint` is `undefined`.

- [ ] **Step 3: Implement**

In `app/api/config/route.ts`, add `s3_endpoint` to the `NextResponse.json({ ... })` object (after the `backend:` line):

```ts
        backend: process.env.BACKEND,
        s3_endpoint: process.env.COMPANION_S3_ENDPOINT,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/daniel.claessen/Desktop/Projects/exulu/frontend && npx vitest run app/api/config/route.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/daniel.claessen/Desktop/Projects/exulu/frontend
git add "app/api/config/route.ts" "app/api/config/route.test.ts"
git commit -m "feat(artifacts): expose s3_endpoint via /api/config"
```

---

## Task 6 (frontend): pure detection + slug utils

**Files:**
- Create: `lib/artifacts/detect-s3-url.ts` + `lib/artifacts/detect-s3-url.test.ts`
- Create: `lib/artifacts/share-name.ts` + `lib/artifacts/share-name.test.ts`

**Interfaces:**
- Produces:
  - `isS3ArtifactUrl(href: string, s3Endpoint: string): boolean`
  - `extractS3Key(href: string, s3Endpoint: string): string | null`
  - `slugifyShareName(input: string): string` (frontend mirror of the backend slug; backend re-slugs defensively)

- [ ] **Step 1: Write the failing tests**

Create `lib/artifacts/detect-s3-url.test.ts`:

```ts
import { describe, test, expect } from "vitest";
import { isS3ArtifactUrl, extractS3Key } from "./detect-s3-url";

const ENDPOINT = "https://s3.test/bucket";

describe("isS3ArtifactUrl", () => {
  test("matches a url under the endpoint", () => {
    expect(isS3ArtifactUrl("https://s3.test/bucket/sessions/a/r.html", ENDPOINT)).toBe(true);
  });
  test("rejects a non-s3 url", () => {
    expect(isS3ArtifactUrl("https://example.com/x", ENDPOINT)).toBe(false);
  });
  test("rejects when endpoint is empty", () => {
    expect(isS3ArtifactUrl("https://s3.test/bucket/x", "")).toBe(false);
  });
  test("tolerates a non-url string", () => {
    expect(isS3ArtifactUrl("not a url", ENDPOINT)).toBe(false);
  });
});

describe("extractS3Key", () => {
  test("returns the path after the endpoint base", () => {
    expect(extractS3Key("https://s3.test/bucket/sessions/a/r.html", ENDPOINT)).toBe(
      "sessions/a/r.html",
    );
  });
  test("url-decodes segments", () => {
    expect(extractS3Key("https://s3.test/bucket/a%20b/r.pdf", ENDPOINT)).toBe("a b/r.pdf");
  });
  test("returns null for a non-s3 url", () => {
    expect(extractS3Key("https://example.com/x", ENDPOINT)).toBeNull();
  });
});
```

Create `lib/artifacts/share-name.test.ts`:

```ts
import { describe, test, expect } from "vitest";
import { slugifyShareName } from "./share-name";

describe("slugifyShareName", () => {
  test("slugifies a key basename and drops the _EXULU_ prefix", () => {
    expect(slugifyShareName("uploads/9f3a_EXULU_Quarterly Report.pdf")).toBe(
      "quarterly-report.pdf",
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/daniel.claessen/Desktop/Projects/exulu/frontend && npx vitest run lib/artifacts/`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement the utils**

Create `lib/artifacts/detect-s3-url.ts`:

```ts
const baseHref = (endpoint: string): string =>
  new URL(endpoint).href.replace(/\/$/, "");

export const isS3ArtifactUrl = (href: string, s3Endpoint: string): boolean => {
  if (!s3Endpoint) return false;
  try {
    return new URL(href).href.startsWith(baseHref(s3Endpoint));
  } catch {
    return false;
  }
};

export const extractS3Key = (href: string, s3Endpoint: string): string | null => {
  if (!isS3ArtifactUrl(href, s3Endpoint)) return null;
  try {
    const base = new URL(s3Endpoint);
    const url = new URL(href);
    const basePath = base.pathname.replace(/\/$/, "");
    const rest = url.pathname.slice(basePath.length).replace(/^\/+/, "");
    const key = rest
      .split("/")
      .map((s) => decodeURIComponent(s))
      .join("/");
    return key || null;
  } catch {
    return null;
  }
};
```

Create `lib/artifacts/share-name.ts`:

```ts
export const slugifyShareName = (input: string): string => {
  const base = input.split("/").pop() ?? input;
  const human = base.split("_EXULU_").pop() ?? base;
  return human
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/daniel.claessen/Desktop/Projects/exulu/frontend && npx vitest run lib/artifacts/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/daniel.claessen/Desktop/Projects/exulu/frontend
git add lib/artifacts
git commit -m "feat(artifacts): add S3 URL detection and share-name utils"
```

---

## Task 7 (frontend): shared-artifacts REST client

**Files:**
- Create: `lib/api/shared-artifacts.ts`

**Interfaces:**
- Consumes: `request` from `@/lib/api/client`.
- Produces: `sharedArtifactsApi.create(input: CreateShareInput): Promise<{ name: string }>` and types `ShareAuthMode`, `ShareRbac`, `CreateShareInput`.

> Thin wrapper over the shared `request` helper — no separate unit test (it has no logic of its own; covered by the dialog integration in Task 8).

- [ ] **Step 1: Implement the client**

Create `lib/api/shared-artifacts.ts`:

```ts
import { request } from "@/lib/api/client";

export type ShareAuthMode = "public" | "password" | "regular";

export interface ShareRbac {
  users: { id: number; rights: "read" | "write" }[];
  roles: { id: string; rights: "read" | "write" }[];
  teams: { id: string; rights: "read" | "write" }[];
}

export interface CreateShareInput {
  s3key: string;
  name: string;
  auth_mode: ShareAuthMode;
  expires_at: string | null;
  password?: string;
  content_type?: string | null;
  rights_mode?: string;
  rbac?: ShareRbac;
}

export const sharedArtifactsApi = {
  /** Create a share link. Throws the backend `detail` message on failure (e.g. 409). */
  create: (input: CreateShareInput): Promise<{ name: string }> =>
    request("/shared-artifacts", "POST", input),
};
```

- [ ] **Step 2: Type-check**

Run: `cd /Users/daniel.claessen/Desktop/Projects/exulu/frontend && npx tsc --noEmit`
Expected: no errors for this file.

- [ ] **Step 3: Commit**

```bash
cd /Users/daniel.claessen/Desktop/Projects/exulu/frontend
git add lib/api/shared-artifacts.ts
git commit -m "feat(artifacts): add shared-artifacts REST client"
```

---

## Task 8 (frontend): ShareArtifactDialog

**Files:**
- Create: `components/artifacts/share-artifact-dialog.tsx`

**Interfaces:**
- Consumes: `Dialog`/`DialogContent`/... from `@/components/ui/dialog`; `Button`, `Input`, `Label` from `@/components/ui/*`; `RBACControl` from `@/components/rbac` (signature: `onChange(rights_mode, users[], roles[], teams[])`, optional `allowedModes`); `sharedArtifactsApi` (Task 7); `slugifyShareName` (Task 6); `toast` from `sonner`.
- Produces: `ShareArtifactDialog({ open, onOpenChange, s3Key, contentType? })` — used by Tasks 9–10.

> UI component — verified by manual smoke test (Step 3). The testable logic (slug, detection) lives in Task 6.

- [ ] **Step 1: Implement the dialog**

Create `components/artifacts/share-artifact-dialog.tsx`:

```tsx
"use client";

import { useState } from "react";
import { toast } from "sonner";

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RBACControl } from "@/components/rbac";
import { sharedArtifactsApi, type ShareAuthMode, type ShareRbac } from "@/lib/api/shared-artifacts";
import { slugifyShareName } from "@/lib/artifacts/share-name";

const EXPIRY_PRESETS: { label: string; days: number | null }[] = [
  { label: "1 day", days: 1 },
  { label: "7 days", days: 7 },
  { label: "30 days", days: 30 },
  { label: "No expiry", days: null },
];

const expiryToIso = (days: number | null): string | null =>
  days === null ? null : new Date(Date.now() + days * 86_400_000).toISOString();

export function ShareArtifactDialog({
  open,
  onOpenChange,
  s3Key,
  contentType,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  s3Key: string;
  contentType?: string | null;
}) {
  const [name, setName] = useState(() => slugifyShareName(s3Key));
  const [authMode, setAuthMode] = useState<ShareAuthMode>("regular");
  const [password, setPassword] = useState("");
  const [expiryDays, setExpiryDays] = useState<number | null>(7);
  const [rightsMode, setRightsMode] = useState("private");
  const [rbac, setRbac] = useState<ShareRbac>({ users: [], roles: [], teams: [] });
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    setSubmitting(true);
    try {
      const { name: created } = await sharedArtifactsApi.create({
        s3key: s3Key,
        name,
        auth_mode: authMode,
        expires_at: expiryToIso(expiryDays),
        content_type: contentType ?? null,
        ...(authMode === "password" ? { password } : {}),
        ...(authMode === "regular" ? { rights_mode: rightsMode, rbac } : {}),
      });
      const url = `${window.location.origin}/artifacts/${encodeURIComponent(created)}`;
      await navigator.clipboard.writeText(url);
      toast.success("Share link copied", { description: url });
      onOpenChange(false);
    } catch (err) {
      toast.error("Could not create share link", {
        description: err instanceof Error ? err.message : "Please try again.",
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Create a shareable link</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="share-name">Link name</Label>
            <Input id="share-name" value={name} onChange={(e) => setName(e.target.value)} />
          </div>

          <div className="space-y-1.5">
            <Label>Expires</Label>
            <div className="flex flex-wrap gap-2">
              {EXPIRY_PRESETS.map((p) => (
                <Button
                  key={p.label}
                  type="button"
                  size="sm"
                  variant={expiryDays === p.days ? "default" : "outline"}
                  onClick={() => setExpiryDays(p.days)}
                >
                  {p.label}
                </Button>
              ))}
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>Access</Label>
            <div className="flex flex-wrap gap-2">
              {(["public", "password", "regular"] as ShareAuthMode[]).map((m) => (
                <Button
                  key={m}
                  type="button"
                  size="sm"
                  variant={authMode === m ? "default" : "outline"}
                  onClick={() => setAuthMode(m)}
                >
                  {m === "public" ? "Public" : m === "password" ? "Password" : "Logged-in users"}
                </Button>
              ))}
            </div>
          </div>

          {authMode === "password" && (
            <div className="space-y-1.5">
              <Label htmlFor="share-pw">Password</Label>
              <Input
                id="share-pw"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
          )}

          {authMode === "regular" && (
            <div className="space-y-1.5">
              <Label>Who can access</Label>
              <RBACControl
                allowedModes={["private", "users", "roles", "teams"]}
                onChange={(mode, users, roles, teams) => {
                  setRightsMode(mode);
                  setRbac({ users, roles, teams });
                }}
              />
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button
            onClick={submit}
            disabled={submitting || !name || (authMode === "password" && !password)}
          >
            {submitting ? "Creating…" : "Create link"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

> Before running, confirm the exact prop names of `RBACControl` in `components/rbac.tsx` (around line 50–75: `onChange(rights_mode, users, roles, teams)`, optional `allowedModes`). If it requires a `value`/initial visibility prop, pass `value="private"`. Adjust the `Label`/`Input` import paths if the project uses different primitives (`@/components/ui/input`, `@/components/ui/label`).

- [ ] **Step 2: Type-check**

Run: `cd /Users/daniel.claessen/Desktop/Projects/exulu/frontend && npx tsc --noEmit`
Expected: no errors in this file (fix import paths/props if any surface).

- [ ] **Step 3: Manual smoke test**

Temporarily render `<ShareArtifactDialog open onOpenChange={()=>{}} s3Key="uploads/x_EXULU_test.html" />` on any page; confirm the name prefills to `test.html`, the mode/expiry toggles work, and (with the backend up) "Create link" copies a URL and toasts. Remove the temporary render.

- [ ] **Step 4: Commit**

```bash
cd /Users/daniel.claessen/Desktop/Projects/exulu/frontend
git add components/artifacts/share-artifact-dialog.tsx
git commit -m "feat(artifacts): add ShareArtifactDialog"
```

---

## Task 9 (frontend): wire the dialog into the three entry points

**Files:**
- Modify: `app/(application)/chat/components/session-files/file-row.tsx`
- Modify: `components/primitives/file-picker.tsx` (`FileItem`, ~line 334)
- Create: `components/artifacts/share-link-anchor.tsx`
- Modify: `components/ai-elements/response.tsx` (`a` component, lines 685–694)

**Interfaces:**
- Consumes: `ShareArtifactDialog` (Task 8); `isS3ArtifactUrl`/`extractS3Key` (Task 6).
- Produces: `ShareLinkAnchor` component used by `Response`'s `a` renderer.

### 9a — session-files file-row

- [ ] **Step 1: Add a Share button + dialog state to `FileRow`**

In `app/(application)/chat/components/session-files/file-row.tsx`:

Add imports near the top:

```tsx
import { useState } from "react";
import { Link2 } from "lucide-react";
import { ShareArtifactDialog } from "@/components/artifacts/share-artifact-dialog";
```

Inside `FileRow`, add state (after the `const t = ...` lines):

```tsx
    const [shareOpen, setShareOpen] = useState(false);
```

Add a Share button in the action row, before the Delete `<Tooltip>` (after the download Tooltip closes at line ~120):

```tsx
                    <Tooltip>
                        <TooltipTrigger asChild>
                            <Button
                                variant="ghost"
                                size="icon"
                                className={ACTION_BUTTON_CLASSES}
                                onClick={() => setShareOpen(true)}
                                aria-label={t("files.share")}
                            >
                                <Link2 className="size-4" aria-hidden="true" />
                            </Button>
                        </TooltipTrigger>
                        <TooltipContent>{t("files.share")}</TooltipContent>
                    </Tooltip>
```

And render the dialog just before the closing `</div>` of the row (inside `TooltipProvider`):

```tsx
                <ShareArtifactDialog
                    open={shareOpen}
                    onOpenChange={setShareOpen}
                    s3Key={file.key}
                    contentType={file.contentType}
                />
```

> If `t("files.share")` has no translation yet, add a `files.share` key (value `"Share"`) to the `chat` namespace messages, or use the literal string `"Share"` to avoid a missing-key warning.

### 9b — file-picker FileItem

- [ ] **Step 2: Add a Share button to `FileItem`'s action row**

In `components/primitives/file-picker.tsx`:

Add imports near the top (with the other lucide icons / react imports):

```tsx
import { Link2 } from "lucide-react";
import { ShareArtifactDialog } from "@/components/artifacts/share-artifact-dialog";
```

Inside `FileItem` (around line 334, after the existing hooks/`displayName`), add:

```tsx
  const [shareOpen, setShareOpen] = useState(false);
```

In the action row (`<div className={actionRowClasses}>`, ~line 395), add a share button alongside the existing actions:

```tsx
          <button
            type="button"
            aria-label="Share"
            className="rounded p-1 hover:bg-muted"
            onClick={(e) => {
              e.stopPropagation();
              setShareOpen(true);
            }}
          >
            <Link2 className="size-4" />
          </button>
```

And render the dialog at the end of the component's returned JSX (before the outermost closing tag):

```tsx
      <ShareArtifactDialog open={shareOpen} onOpenChange={setShareOpen} s3Key={s3Key} />
```

> Match the existing action-row button styling in `FileItem` (copy the className from the adjacent download/remove buttons) so the share button looks native. Ensure `useState` is imported.

### 9c — inline S3-link detection in the message renderer

- [ ] **Step 3: Create `ShareLinkAnchor`**

Create `components/artifacts/share-link-anchor.tsx`:

```tsx
"use client";

import { useEffect, useState, type AnchorHTMLAttributes } from "react";
import { Link2 } from "lucide-react";

import { cn } from "@/lib/utils";
import { ShareArtifactDialog } from "@/components/artifacts/share-artifact-dialog";
import { isS3ArtifactUrl, extractS3Key } from "@/lib/artifacts/detect-s3-url";

// Cache the S3 endpoint for the page lifetime (one /api/config fetch).
let s3EndpointPromise: Promise<string> | null = null;
const getS3Endpoint = (): Promise<string> => {
  if (!s3EndpointPromise) {
    s3EndpointPromise = fetch("/api/config")
      .then((r) => r.json())
      .then((c) => c.s3_endpoint ?? "")
      .catch(() => "");
  }
  return s3EndpointPromise;
};

export function ShareLinkAnchor({
  className,
  children,
  ...props
}: AnchorHTMLAttributes<HTMLAnchorElement>) {
  const href = props.href ?? "";
  const [endpoint, setEndpoint] = useState("");
  const [open, setOpen] = useState(false);

  useEffect(() => {
    getS3Endpoint().then(setEndpoint);
  }, []);

  const isArtifact = !!endpoint && isS3ArtifactUrl(href, endpoint);
  const s3Key = isArtifact ? extractS3Key(href, endpoint) : null;

  return (
    <span className="inline-flex items-center gap-1">
      <a
        className={cn("font-medium text-primary underline", className)}
        rel="noreferrer"
        target="_blank"
        {...props}
      >
        {children}
      </a>
      {s3Key && (
        <>
          <button
            type="button"
            aria-label="Create shareable link"
            title="Create shareable link"
            className="inline-flex shrink-0 text-muted-foreground/70 hover:text-foreground"
            onClick={(e) => {
              e.preventDefault();
              setOpen(true);
            }}
          >
            <Link2 className="size-3.5" />
          </button>
          <ShareArtifactDialog open={open} onOpenChange={setOpen} s3Key={s3Key} />
        </>
      )}
    </span>
  );
}
```

- [ ] **Step 4: Delegate the `a` renderer to `ShareLinkAnchor`**

In `components/ai-elements/response.tsx`, add the import near the top:

```tsx
import { ShareLinkAnchor } from '@/components/artifacts/share-link-anchor';
```

Replace the `a` entry in the `components` object (lines 685–694) with:

```tsx
  a: ({ node, ...props }) => <ShareLinkAnchor {...props} />,
```

- [ ] **Step 5: Type-check and verify**

Run: `cd /Users/daniel.claessen/Desktop/Projects/exulu/frontend && npx tsc --noEmit`
Expected: no new errors.

Manual: in a chat message, paste a markdown link whose href starts with `COMPANION_S3_ENDPOINT` → a small share icon appears next to it and opens the dialog; a normal external link shows no icon.

- [ ] **Step 6: Commit**

```bash
cd /Users/daniel.claessen/Desktop/Projects/exulu/frontend
git add "app/(application)/chat/components/session-files/file-row.tsx" \
        components/primitives/file-picker.tsx \
        components/artifacts/share-link-anchor.tsx \
        components/ai-elements/response.tsx
git commit -m "feat(artifacts): wire share dialog into file-row, file tiles, and inline links"
```

---

## Task 10 (frontend): the `/artifacts/[artifact_name]` route

**Files:**
- Create: `app/artifacts/[artifact_name]/ui.tsx`
- Create: `app/artifacts/[artifact_name]/actions.ts`
- Create: `app/artifacts/[artifact_name]/password-gate.tsx`
- Create: `app/artifacts/[artifact_name]/content/route.ts`
- Create: `app/artifacts/[artifact_name]/page.tsx`

**Interfaces:**
- Consumes: `serverSideAuthCheck` from `@/lib/server-side-auth-check`; `getServerSession` + `getAuthOptions` (`@/app/api/auth/[...nextauth]/options`); `process.env.BACKEND`, `process.env.INTERNAL_SECRET`.

> This route is **top-level** (NOT under `(application)`), so unauthenticated visitors are not force-redirected — each share enforces its own mode.

- [ ] **Step 1: Small UI helpers**

Create `app/artifacts/[artifact_name]/ui.tsx`:

```tsx
"use client";

import { useEffect } from "react";

export function Centered({
  title,
  subtitle,
  actionHref,
  actionLabel,
}: {
  title: string;
  subtitle?: string;
  actionHref?: string;
  actionLabel?: string;
}) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-2 p-8 text-center">
      <h1 className="text-lg font-semibold">{title}</h1>
      {subtitle && <p className="text-sm text-muted-foreground">{subtitle}</p>}
      {actionHref && (
        <a href={actionHref} className="text-sm text-primary underline">
          {actionLabel ?? "Download"}
        </a>
      )}
    </div>
  );
}

export function AutoDownload({ url, filename }: { url: string; filename: string }) {
  useEffect(() => {
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }, [url, filename]);

  return (
    <Centered
      title="Your download should begin…"
      subtitle={filename}
      actionHref={url}
      actionLabel="Download manually"
    />
  );
}
```

- [ ] **Step 2: Password cookie server action**

Create `app/artifacts/[artifact_name]/actions.ts`:

```ts
"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";

export async function setSharePassword(name: string, password: string) {
  (await cookies()).set(`share_pw_${name}`, password, {
    httpOnly: true,
    sameSite: "lax",
    path: `/artifacts/${name}`,
  });
  redirect(`/artifacts/${encodeURIComponent(name)}`);
}
```

- [ ] **Step 3: Password gate (client)**

Create `app/artifacts/[artifact_name]/password-gate.tsx`:

```tsx
"use client";

import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { setSharePassword } from "./actions";

export function PasswordGate({ name, error }: { name: string; error?: boolean }) {
  const [pw, setPw] = useState("");
  const [pending, startTransition] = useTransition();

  return (
    <div className="flex min-h-screen items-center justify-center p-8">
      <form
        className="w-full max-w-sm space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          startTransition(() => setSharePassword(name, pw));
        }}
      >
        <h1 className="text-lg font-semibold">This artifact is password protected</h1>
        {error && <p className="text-sm text-destructive">Incorrect password. Try again.</p>}
        <Input
          type="password"
          value={pw}
          onChange={(e) => setPw(e.target.value)}
          placeholder="Password"
          autoFocus
        />
        <Button type="submit" disabled={pending || !pw} className="w-full">
          {pending ? "Checking…" : "View artifact"}
        </Button>
      </form>
    </div>
  );
}
```

- [ ] **Step 4: Content route handler (serves bytes)**

Create `app/artifacts/[artifact_name]/content/route.ts`:

```ts
import { NextResponse, type NextRequest } from "next/server";
import { cookies } from "next/headers";
import { getServerSession } from "next-auth";

import { getAuthOptions } from "@/app/api/auth/[...nextauth]/options";

export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ artifact_name: string }> },
) {
  const { artifact_name } = await params;
  const backend = process.env.BACKEND;
  const internal = process.env.INTERNAL_SECRET;
  if (!backend || !internal) {
    return NextResponse.json({ detail: "Server misconfigured." }, { status: 500 });
  }

  const metaRes = await fetch(
    `${backend}/shared-artifacts/${encodeURIComponent(artifact_name)}/meta`,
    { headers: { "internal-key": internal }, cache: "no-store" },
  );
  if (!metaRes.ok) return new NextResponse(null, { status: metaRes.status });
  const meta = await metaRes.json();

  const headers: Record<string, string> = {};
  if (meta.auth_mode === "regular") {
    const session: any = await getServerSession(await getAuthOptions());
    if (!session?.user?.jwt) return new NextResponse(null, { status: 401 });
    headers["Authorization"] = `Bearer ${session.user.jwt}`;
  } else {
    headers["internal-key"] = internal;
    if (meta.auth_mode === "password") {
      const pw = (await cookies()).get(`share_pw_${artifact_name}`)?.value ?? "";
      headers["x-share-password"] = pw;
    }
  }

  const contentRes = await fetch(
    `${backend}/shared-artifacts/${encodeURIComponent(artifact_name)}/content`,
    { headers, cache: "no-store" },
  );
  if (!contentRes.ok) return new NextResponse(null, { status: contentRes.status });

  const buf = Buffer.from(await contentRes.arrayBuffer());
  const respHeaders = new Headers();
  respHeaders.set(
    "Content-Type",
    contentRes.headers.get("content-type") ?? "application/octet-stream",
  );
  const cd = contentRes.headers.get("content-disposition");
  if (cd) respHeaders.set("Content-Disposition", cd);
  respHeaders.set("Cache-Control", "private, no-store");
  return new NextResponse(buf, { status: 200, headers: respHeaders });
}
```

- [ ] **Step 5: The page (server component)**

Create `app/artifacts/[artifact_name]/page.tsx`:

```tsx
import { redirect } from "next/navigation";
import { cookies } from "next/headers";

import { serverSideAuthCheck } from "@/lib/server-side-auth-check";
import { Centered, AutoDownload } from "./ui";
import { PasswordGate } from "./password-gate";

export const dynamic = "force-dynamic";

export default async function ArtifactPage({
  params,
}: {
  params: Promise<{ artifact_name: string }>;
}) {
  const { artifact_name } = await params;
  const backend = process.env.BACKEND;
  const internal = process.env.INTERNAL_SECRET;
  if (!backend || !internal) return <Centered title="Server misconfigured" />;

  const metaRes = await fetch(
    `${backend}/shared-artifacts/${encodeURIComponent(artifact_name)}/meta`,
    { headers: { "internal-key": internal }, cache: "no-store" },
  );
  if (metaRes.status === 404) return <Centered title="Artifact not found" />;
  if (metaRes.status === 410) return <Centered title="This link has expired" />;
  if (!metaRes.ok) return <Centered title="Something went wrong" />;

  const meta = (await metaRes.json()) as {
    auth_mode: "public" | "password" | "regular";
    filename: string;
    is_html: boolean;
  };
  const contentUrl = `/artifacts/${encodeURIComponent(artifact_name)}/content`;

  if (meta.auth_mode === "regular") {
    const user = await serverSideAuthCheck();
    if (!user) {
      redirect(`/login?destination=/artifacts/${encodeURIComponent(artifact_name)}`);
    }
  }

  if (meta.auth_mode === "password") {
    const pw = (await cookies()).get(`share_pw_${artifact_name}`)?.value;
    if (!pw) return <PasswordGate name={artifact_name} />;
    // Validate before rendering so a wrong password re-prompts cleanly rather
    // than showing a broken iframe / failed download. (One extra fetch in the
    // password path — acceptable; artifacts are modest in size.)
    const check = await fetch(
      `${backend}/shared-artifacts/${encodeURIComponent(artifact_name)}/content`,
      { headers: { "internal-key": internal, "x-share-password": pw }, cache: "no-store" },
    );
    if (check.status === 401) return <PasswordGate name={artifact_name} error />;
    if (!check.ok) return <Centered title="Something went wrong" />;
  }

  if (meta.is_html) {
    return (
      <iframe
        src={contentUrl}
        sandbox="allow-scripts allow-popups allow-forms"
        className="h-screen w-screen border-0"
        title={meta.filename}
      />
    );
  }

  return <AutoDownload url={contentUrl} filename={meta.filename} />;
}
```

- [ ] **Step 6: Type-check**

Run: `cd /Users/daniel.claessen/Desktop/Projects/exulu/frontend && npx tsc --noEmit`
Expected: no errors. (Confirm `getAuthOptions` is exported from `app/api/auth/[...nextauth]/options`; `lib/graphql/server.ts` imports it the same way.)

- [ ] **Step 7: Manual end-to-end test**

Set `INTERNAL_SECRET` (== backend's) and `COMPANION_S3_ENDPOINT` in the frontend env. With the backend running:
1. Create a **public** share of a `.html` key via the dialog → open the copied URL in a logged-out browser → HTML renders in the sandboxed iframe.
2. Create a **public** share of a `.pdf`/`.docx` key → the file downloads.
3. Create a **password** share → visiting prompts for a password; wrong → re-prompt; correct → renders/downloads.
4. Create a **regular** share scoped to yourself → logged-out visit redirects to `/login?destination=…`; an authorized logged-in visit serves; an unauthorized user gets `403` (blank/again — acceptable).
5. An expired link → "This link has expired".

- [ ] **Step 8: Commit**

```bash
cd /Users/daniel.claessen/Desktop/Projects/exulu/frontend
git add "app/artifacts/[artifact_name]"
git commit -m "feat(artifacts): add /artifacts/[name] viewer route"
```

---

## Self-Review

**Spec coverage:**
- Share UI in message-renderer & session-files → Tasks 9b (FileItem, used by message-renderer tiles) + 9a (file-row). ✓
- `shared_artifacts` table with s3 key, expiry, auth mode, unique name, RBAC → Task 1. ✓
- Frontend `/artifacts/:artifact_name` route, auth check, HTML inline vs download → Task 10. ✓
- Inline S3-URL detection + subtle CTA → Tasks 6 + 9c. ✓
- `COMPANION_S3_ENDPOINT` via `/api/config` → Task 5. ✓
- Backend-trusts-frontend via `INTERNAL_SECRET`/`internal-key`; regular mode forwards viewer token + `checkRecordAccess` → Task 4 + Task 10 content route. ✓

**Type consistency:** `auth_mode` values, `s3key`/`name`/`expires_at`/`content_type`/`password_hash` field names, and the `{ name }` create response are identical across Tasks 1/4/7/8/10. `getSharedArtifactByName`, `normalizeS3Key`, `isHtmlKey`, `deriveFilename`, `contentHeadersFor` signatures match between Tasks 2/3 and their use in Task 4. `RBACControl.onChange(mode, users, roles, teams)` matches `components/rbac.tsx`.

**Open verification flagged inline (not placeholders):** exact `RBACControl` props (Task 8 Step 1 note), `Input`/`Label` primitive paths, and `t("files.share")` i18n key (Task 9a note) — each carries a concrete fallback.
