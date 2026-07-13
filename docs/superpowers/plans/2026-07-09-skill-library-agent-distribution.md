# Skill Library: `.skill` Upload, Folder Upload & Agent Distribution — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users upload `.skill` files and whole skill folders into the Exulu skill library, and let coding agents (Claude Code, OpenCode, and ~48 others) install, update, and publish skills against any client's Exulu instance.

**Architecture:** Backend gains agent-facing REST endpoints on the existing Express app (`src/exulu/routes.ts`) that address skills by name, reuse the existing bundle extractor and RBAC helpers, and serve an embedded bootstrap skill. The frontend gains client-side folder→zip assembly (fflate), `.skill` acceptance, frontmatter prefill, a "Connect your agent" install one-liner served from a new Next.js route, and an install hint on the detail panel. A shell installer resolves each per-client backend URL via the existing `/api/config` contract and installs the bootstrap skill into the user's chosen agent clients (copy by default, symlink opt-in).

**Tech Stack:** TypeScript, Express, Knex/Postgres, JSZip, S3 (Uppy wrappers), jest (backend); Next.js App Router, React, fflate, vitest (frontend); POSIX sh (installer).

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-07-08-skill-library-agent-distribution-design.md` (in this backend repo). Every task's requirements implicitly include it.
- **`.skill` = zip.** A `.skill` file is a plain zip; treat it identically to `.zip` everywhere. The existing extractor (`src/skills/bundle-extractor.ts`) already handles the format; only extension whitelists and export filenames change.
- **Bundle limits (must stay in sync front/back):** SKILL.md required at post-unwrap root; ≤ 50 MB uncompressed; ≤ 500 entries; skip OS junk (`__MACOSX/`, `.DS_Store`, `Thumbs.db`, `desktop.ini`, and `.git/` for folder collection).
- **Auth:** all `/skills/registry/*` endpoints authenticate via the existing `requestValidators.authenticate(req)` (Bearer JWT or `exulu-api-key`); `/skills/agent/bootstrap` is public. RBAC read/write via `checkRecordAccess(record, "read"|"write", user)` after hydrating `RBAC` with `RBACResolver(db, "skill", id, rights_mode)`.
- **Backend build is `tsup`** with no static-asset copy step — embed the bootstrap skill as TypeScript string modules, never as loose files expected in `dist/`.
- **URL resolution:** the user supplies the frontend base URL (e.g. `https://ai.open.de`); the backend/API URL (e.g. `https://backend.ai.open.de`) is `GET <baseUrl>/api/config` → `.backend`. Normalize base URLs: strip trailing slashes, default scheme to `https://`.
- **Two repos:** backend `= /Users/daniel.claessen/Desktop/Projects/exulu/backend`, frontend `= /Users/daniel.claessen/Desktop/Projects/exulu/frontend`. Commit within the repo a task touches. The client manifest is duplicated in both repos (data list, no shared package) — keep the two copies identical.
- **Node** backend pinned to v22.18.0; do not change engines.

---

## File Structure

**Backend (`/Users/daniel.claessen/Desktop/Projects/exulu/backend`):**
- `src/skills/bundle-extractor.ts` — MODIFY: add `wrapForSkillExport()` + export version-folder helper reuse (Task 2). Existing extractor untouched for `.skill` (already zip).
- `src/skills/skill-access.ts` — CREATE: `resolveSkillByName()`, `canAccessSkill()` (Tasks 7–10).
- `src/skills/frontmatter.ts` — CREATE: `parseSkillFrontmatter()` (Task 10, shared meta parse for publish-create).
- `src/skills/bootstrap/exulu-skills.ts` — CREATE: embedded bootstrap `SKILL.md` + `clients.json` strings (Tasks 11–12).
- `src/skills/bootstrap/clients.ts` — CREATE: the client manifest (id → skill dir) as data (Task 11).
- `src/exulu/routes.ts` — MODIFY: `.skill` in upload-sign (Task 1), `format=skill` download (Task 2), registry list/metadata/download/publish + bootstrap routes (Tasks 7–11).
- Co-located `*.test.ts` files for the new pure helpers.

**Frontend (`/Users/daniel.claessen/Desktop/Projects/exulu/frontend`):**
- `package.json` — MODIFY: add `fflate` (Task 4).
- `lib/skills/bundle.ts` — CREATE: `zipFiles()`, `readSkillMetaFromZip()`, `collectFolderFiles()`, `validateBundleFiles()` (Tasks 4, 6).
- `lib/api/skills.ts` — MODIFY: `download()` gains `format` param (Task 3b).
- `app/(application)/skills/components/create-skill-dialog.tsx` — MODIFY: accept `.skill`, folder upload, prefill (Tasks 3, 5, 6).
- `components/primitives/dropzone.tsx` — MODIFY: optional `directory` + folder drop traversal (Task 6).
- `app/(application)/skills/components/skill-detail-panel.tsx` — MODIFY: `.skill` export + install hint (Task 14).
- `app/(application)/skills/components/connect-agent-dialog.tsx` — CREATE: "Connect your agent" dialog (Task 14).
- `app/api/skills/install.sh/route.ts` — CREATE: installer script route (Task 13).
- `lib/skills/clients.ts` — CREATE: client manifest copy for the installer route (Task 13).
- Co-located `*.test.ts` for `lib/skills/bundle.ts`.

---

## Part 1 — `.skill` upload & export

### Task 1: Backend accepts `.skill` in upload-sign

**Files:**
- Modify: `src/exulu/routes.ts` (the `POST /skills/:skillId/upload-sign` handler, ~line 3314)

**Interfaces:**
- Produces: `upload-sign` accepts `extension ∈ {".zip", ".md", ".skill"}`. `.skill` is later sent to `init-from-upload` with `isZip: true`.

- [ ] **Step 1: Widen the extension check**

In the `upload-sign` handler, replace the extension guard:

```typescript
    if (extension !== ".zip" && extension !== ".md" && extension !== ".skill") {
      res.status(400).json({ detail: 'extension must be ".zip", ".md", or ".skill".' });
      return;
    }
```

- [ ] **Step 2: Type-check**

Run: `npm run type-check`
Expected: no new errors.

- [ ] **Step 3: Manual verification**

Run the backend, then:
```bash
curl -s -X POST "$BACKEND/skills/00000000-0000-0000-0000-000000000000/upload-sign" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"extension":".skill","contentType":"application/zip"}'
```
Expected: `404 Skill not found` (extension accepted — we passed the extension guard and reached the skill lookup), NOT `400 extension must be...`. A `400` here is a failure.

- [ ] **Step 4: Commit**

```bash
git add src/exulu/routes.ts
git commit -m "feat(skills): accept .skill extension in upload-sign"
```

---

### Task 2: Backend `.skill` export (`format=skill` on download)

**Files:**
- Modify: `src/exulu/routes.ts` (the `GET /skills/:skillId/download` handler, ~line 3509)

**Interfaces:**
- Consumes: existing `download` handler variables `zip` (JSZip), `skill`, `version`, `safeName`, `fileCount`, and the per-file loop that adds `relativePath`.
- Produces: `?format=skill` wraps every entry under `<safeName>/` and serves `<safeName>.skill`; default (`zip`/absent) is unchanged.

- [ ] **Step 1: Read the query param and branch the archive layout**

In the `download` handler, after `const version = ...` validation and before building entries, add:

```typescript
    const asSkill = req.query.format === "skill";
```

Then, in the per-file loop, prefix the in-archive path when exporting as a skill. Replace `zip.file(relativePath, bytes);` with:

```typescript
      const archivePath = asSkill ? `${safeName}/${relativePath}` : relativePath;
      zip.file(archivePath, bytes);
```

Note: `safeName` is currently computed near the end of the handler. Move its declaration to **above** the file loop so it is available there:

```typescript
    const safeName =
      String(skill.name ?? "skill")
        .replace(/[^a-zA-Z0-9-_]+/g, "-")
        .replace(/^-+|-+$/g, "") || "skill";
```

Delete the later duplicate `const safeName = ...` line.

- [ ] **Step 2: Wrap `version.txt` too and set the filename**

The `version.txt` entry must also live inside the wrapper folder so the archive has a single top-level dir (round-trips through the extractor's wrapper-unwrap). Replace the `zip.file("version.txt", ...)` call's first argument:

```typescript
    zip.file(
      asSkill ? `${safeName}/version.txt` : "version.txt",
      [ /* unchanged body */ ].join("\n"),
    );
```

Replace the filename + content-disposition block:

```typescript
    const filename = asSkill ? `${safeName}.skill` : `${safeName}-v${version}.zip`;
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(buffer);
```

- [ ] **Step 3: Type-check**

Run: `npm run type-check`
Expected: no new errors.

- [ ] **Step 4: Manual verification (round-trip)**

Download an existing skill as `.skill`, then confirm it re-uploads cleanly:
```bash
curl -s "$BACKEND/skills/$SKILL_ID/download?format=skill" -H "Authorization: Bearer $TOKEN" -o /tmp/out.skill
unzip -l /tmp/out.skill    # expect a single top-level <name>/ folder containing SKILL.md
```
Expected: one wrapper folder; `<name>/SKILL.md` present. This is exactly the shape `extractBundleToS3` unwraps.

- [ ] **Step 5: Commit**

```bash
git add src/exulu/routes.ts
git commit -m "feat(skills): add .skill export format to download endpoint"
```

---

### Task 3: Frontend accepts `.skill` upload (dialog + Dropzone + api client)

**Files:**
- Modify: `app/(application)/skills/components/create-skill-dialog.tsx` (accept list ~line 260, validation ~line 108, submit ~line 160)
- Modify: `lib/api/skills.ts` (`download` signature)

**Interfaces:**
- Consumes: `skillsApi.uploadSign(id, ext, contentType)`, `skillsApi.initFromUpload(id, stagingKey, isZip)` (existing).
- Produces: `.skill` files upload end-to-end; `skillsApi.download(id, version, format?)`.

- [ ] **Step 1: Accept `.skill` in the Dropzone**

In `create-skill-dialog.tsx`, change the Dropzone `accept` prop:

```tsx
            accept={[".zip", ".md", ".skill"]}
```

- [ ] **Step 2: Accept `.skill` in the file validation**

Replace the extension guard (~line 108):

```tsx
          const lower = file.name.toLowerCase();
          if (
            !lower.endsWith(".zip") &&
            !lower.endsWith(".md") &&
            !lower.endsWith(".skill")
          ) {
            toast.error(t("create.unsupportedFile"));
            return;
          }
          setUploadFile(file);
```

- [ ] **Step 3: Treat `.skill` as a zip in submit**

Replace the isZip/ext/contentType derivation in the upload branch (~line 160):

```tsx
          const lower = uploadFile.name.toLowerCase();
          const isZip = lower.endsWith(".zip") || lower.endsWith(".skill");
          const ext = lower.endsWith(".md") ? ".md" : ".skill" === lower.slice(-6) ? ".skill" : ".zip";
          const contentType =
            uploadFile.type || (isZip ? "application/zip" : "text/markdown");
```

Note: `ext` is the extension we tell the backend to store the staging object under; `.skill` and `.zip` both extract as zip (`isZip: true`), so mislabeling between them is harmless, but pass the real one.

- [ ] **Step 4: Add `format` to the api-client download**

In `lib/api/skills.ts`, update `download` to pass an optional format through to the query string. Current call builds a URL with `?version=`; add `&format=` when provided:

```typescript
  download: async (id: string, version?: number, format?: "zip" | "skill"): Promise<Blob> => {
    const params = new URLSearchParams();
    if (version) params.set("version", String(version));
    if (format) params.set("format", format);
    const qs = params.toString();
    // ... existing fetch, appending `?${qs}` when qs is non-empty, same auth headers ...
  },
```

Keep the existing auth/header/blob logic; only the query-string assembly changes. If the existing implementation already uses `URLSearchParams`, just add the `format` line.

- [ ] **Step 5: Type-check + lint**

Run: `cd ../frontend && npx tsc --noEmit && npm run lint`
Expected: no new errors.

- [ ] **Step 6: Manual verification**

In the skills UI, create a skill via Upload using `/Users/daniel.claessen/Downloads/skill-auditor.skill`. Expected: upload succeeds, skill appears with SKILL.md + `references/applying-edits.md`.

- [ ] **Step 7: Commit**

```bash
git add app/\(application\)/skills/components/create-skill-dialog.tsx lib/api/skills.ts
git commit -m "feat(skills): accept .skill upload and add .skill download format"
```

---

## Part 2 — Folder upload + frontmatter prefill

### Task 4: Client bundle utility (fflate) + tests

**Files:**
- Modify: `package.json` (frontend) — add `fflate`
- Create: `lib/skills/bundle.ts`
- Create: `lib/skills/bundle.test.ts`

**Interfaces:**
- Produces:
  - `type CollectedFile = { path: string; data: Uint8Array }`
  - `zipFiles(files: CollectedFile[], rootFolder: string): Uint8Array` — deterministic zip, every entry prefixed `rootFolder + "/"`.
  - `readSkillMetaFromZip(zipBytes: Uint8Array): { name?: string; description?: string }` — locate post-unwrap-root `SKILL.md`, parse frontmatter; never throws.
  - `parseFrontmatter(md: string): Record<string, string>` — minimal `---`-fenced scalar parser.
  - `isOsJunk(path: string): boolean`
  - `validateBundleFiles(files: CollectedFile[]): { ok: true } | { ok: false; error: string }` — SKILL.md-at-root, ≤ 500 files, ≤ 50 MB.

- [ ] **Step 1: Add fflate**

Run: `cd /Users/daniel.claessen/Desktop/Projects/exulu/frontend && npm install fflate`
Expected: `fflate` appears in `package.json` dependencies.

- [ ] **Step 2: Write failing tests**

Create `lib/skills/bundle.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import {
  zipFiles,
  readSkillMetaFromZip,
  parseFrontmatter,
  isOsJunk,
  validateBundleFiles,
  type CollectedFile,
} from "./bundle";

const enc = (s: string) => new TextEncoder().encode(s);

describe("parseFrontmatter", () => {
  it("extracts name and description from a --- fenced block", () => {
    const md = "---\nname: my-skill\ndescription: Does a thing\n---\n# Body\n";
    expect(parseFrontmatter(md)).toEqual({ name: "my-skill", description: "Does a thing" });
  });
  it("returns empty object when no frontmatter", () => {
    expect(parseFrontmatter("# just a heading")).toEqual({});
  });
});

describe("isOsJunk", () => {
  it("flags OS junk and .git", () => {
    expect(isOsJunk("__MACOSX/foo")).toBe(true);
    expect(isOsJunk("a/.DS_Store")).toBe(true);
    expect(isOsJunk(".git/config")).toBe(true);
    expect(isOsJunk("SKILL.md")).toBe(false);
  });
});

describe("validateBundleFiles", () => {
  it("requires SKILL.md at the folder root", () => {
    const files: CollectedFile[] = [{ path: "my-skill/SKILL.md", data: enc("---\nname: x\n---\n") }];
    expect(validateBundleFiles(files)).toEqual({ ok: true });
  });
  it("fails when SKILL.md is missing", () => {
    const files: CollectedFile[] = [{ path: "my-skill/other.md", data: enc("x") }];
    const r = validateBundleFiles(files);
    expect(r.ok).toBe(false);
  });
  it("fails when over 500 files", () => {
    const files: CollectedFile[] = [{ path: "s/SKILL.md", data: enc("---\nname: x\n---\n") }];
    for (let i = 0; i < 500; i++) files.push({ path: `s/f${i}.txt`, data: enc("y") });
    const r = validateBundleFiles(files);
    expect(r.ok).toBe(false);
  });
});

describe("zipFiles + readSkillMetaFromZip round-trip", () => {
  it("zips under a root folder and reads back frontmatter", () => {
    const files: CollectedFile[] = [
      { path: "SKILL.md", data: enc("---\nname: round-trip\ndescription: hi\n---\n# x") },
    ];
    const zip = zipFiles(files, "round-trip");
    expect(readSkillMetaFromZip(zip)).toEqual({ name: "round-trip", description: "hi" });
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run lib/skills/bundle.test.ts`
Expected: FAIL — module `./bundle` not found.

- [ ] **Step 4: Implement `lib/skills/bundle.ts`**

```typescript
import { zipSync, unzipSync, strFromU8 } from "fflate";

export type CollectedFile = { path: string; data: Uint8Array };

const MAX_TOTAL_BYTES = 50 * 1024 * 1024;
const MAX_ENTRIES = 500;

export function isOsJunk(path: string): boolean {
  if (path.startsWith("__MACOSX/")) return true;
  if (path === ".git" || path.startsWith(".git/") || path.includes("/.git/")) return true;
  const base = path.split("/").pop() ?? "";
  return base === ".DS_Store" || base === "Thumbs.db" || base === "desktop.ini";
}

export function parseFrontmatter(md: string): Record<string, string> {
  // Only the leading --- fenced block; simple `key: value` scalar lines.
  const match = /^﻿?---\r?\n([\s\S]*?)\r?\n---/.exec(md);
  if (!match) return {};
  const out: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[m[1]] = v;
  }
  return out;
}

// Detect a single top-level wrapper folder shared by every path, matching the
// backend extractor's unwrap so "SKILL.md at root" is checked consistently.
function stripWrapper(paths: string[]): (p: string) => string {
  const heads = new Set(paths.map((p) => p.split("/")[0]).filter(Boolean));
  if (heads.size === 1) {
    const head = [...heads][0] + "/";
    if (paths.every((p) => p.startsWith(head))) return (p) => p.slice(head.length);
  }
  return (p) => p;
}

export function validateBundleFiles(
  files: CollectedFile[],
): { ok: true } | { ok: false; error: string } {
  const clean = files.filter((f) => !isOsJunk(f.path));
  if (clean.length === 0) return { ok: false, error: "Folder is empty." };
  if (clean.length > MAX_ENTRIES)
    return { ok: false, error: `Too many files (${clean.length} > ${MAX_ENTRIES}).` };
  let total = 0;
  for (const f of clean) total += f.data.byteLength;
  if (total > MAX_TOTAL_BYTES)
    return { ok: false, error: "Folder exceeds 50 MB uncompressed." };
  const strip = stripWrapper(clean.map((f) => f.path));
  const hasSkillMd = clean.some((f) => strip(f.path) === "SKILL.md");
  if (!hasSkillMd) return { ok: false, error: "Folder must contain a SKILL.md at its root." };
  return { ok: true };
}

export function zipFiles(files: CollectedFile[], rootFolder: string): Uint8Array {
  const tree: Record<string, Uint8Array> = {};
  for (const f of files) {
    if (isOsJunk(f.path)) continue;
    tree[`${rootFolder}/${f.path}`] = f.data;
  }
  return zipSync(tree, { level: 6 });
}

export function readSkillMetaFromZip(
  zipBytes: Uint8Array,
): { name?: string; description?: string } {
  try {
    const entries = unzipSync(zipBytes);
    const paths = Object.keys(entries).filter((p) => !p.endsWith("/") && !isOsJunk(p));
    const strip = stripWrapper(paths);
    const skillPath = paths.find((p) => strip(p) === "SKILL.md");
    if (!skillPath) return {};
    const fm = parseFrontmatter(strFromU8(entries[skillPath]));
    return { name: fm.name, description: fm.description };
  } catch {
    return {};
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run lib/skills/bundle.test.ts`
Expected: PASS (all cases).

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json lib/skills/bundle.ts lib/skills/bundle.test.ts
git commit -m "feat(skills): add client-side bundle util (fflate zip + frontmatter + validation)"
```

---

### Task 5: Frontmatter prefill in the create dialog

**Files:**
- Modify: `app/(application)/skills/components/create-skill-dialog.tsx`

**Interfaces:**
- Consumes: `readSkillMetaFromZip` from `lib/skills/bundle`.
- Produces: on selecting a `.skill`/`.zip`, empty name/description fields are prefilled from SKILL.md frontmatter (best-effort).

- [ ] **Step 1: Import the util**

```tsx
import { readSkillMetaFromZip } from "@/lib/skills/bundle";
```

- [ ] **Step 2: Prefill after a zip/`.skill` is accepted**

In the file-accept handler, after `setUploadFile(file);`, add (for zip-family files only):

```tsx
          if (lower.endsWith(".zip") || lower.endsWith(".skill")) {
            try {
              const buf = new Uint8Array(await file.arrayBuffer());
              const meta = readSkillMetaFromZip(buf);
              // Only fill fields the user hasn't typed into.
              setName((prev) => prev || meta.name || "");
              setDescription((prev) => prev || meta.description || "");
            } catch {
              /* prefill is best-effort; ignore parse failures */
            }
          }
```

Use the actual state setters in this component (confirm the names of the name/description state setters in the file and match them).

- [ ] **Step 3: Type-check + lint**

Run: `npx tsc --noEmit && npm run lint`
Expected: no new errors.

- [ ] **Step 4: Manual verification**

Select `skill-auditor.skill` in the Upload tab. Expected: the name field prefills to `skill-auditor` (or its frontmatter `name`) and description fills from frontmatter, without overwriting anything already typed.

- [ ] **Step 5: Commit**

```bash
git add app/\(application\)/skills/components/create-skill-dialog.tsx
git commit -m "feat(skills): prefill name/description from uploaded skill frontmatter"
```

---

### Task 6: Folder upload (picker + drag-and-drop + client zip)

**Files:**
- Modify: `components/primitives/dropzone.tsx` (add `directory` prop + folder drop traversal)
- Modify: `app/(application)/skills/components/create-skill-dialog.tsx` (folder mode → zip → existing upload pipeline)

**Interfaces:**
- Consumes: `collectFolderFiles` (new, below), `validateBundleFiles`, `zipFiles`, `readSkillMetaFromZip`.
- Produces: selecting/dropping a folder assembles a client-side zip and runs the existing uploadSign → PUT → initFromUpload flow with `isZip: true`.

- [ ] **Step 1: Add folder collection to the bundle util (test first)**

Add to `lib/skills/bundle.test.ts`:

```typescript
import { collectFromFileList } from "./bundle";

describe("collectFromFileList", () => {
  it("uses webkitRelativePath and strips the top folder name", async () => {
    const f = new File([enc("---\nname: x\n---\n")], "SKILL.md");
    Object.defineProperty(f, "webkitRelativePath", { value: "my-skill/SKILL.md" });
    const files = await collectFromFileList([f] as unknown as FileList);
    expect(files).toEqual([{ path: "my-skill/SKILL.md", data: expect.any(Uint8Array) }]);
  });
});
```

Run: `npx vitest run lib/skills/bundle.test.ts` → FAIL (`collectFromFileList` not exported).

- [ ] **Step 2: Implement `collectFromFileList`**

Add to `lib/skills/bundle.ts`:

```typescript
// From an <input webkitdirectory> FileList: each File carries a
// webkitRelativePath like "folder/sub/file"; we keep that as the entry path.
export async function collectFromFileList(list: FileList | File[]): Promise<CollectedFile[]> {
  const files: CollectedFile[] = [];
  for (const file of Array.from(list as ArrayLike<File>)) {
    const rel = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
    if (isOsJunk(rel)) continue;
    files.push({ path: rel, data: new Uint8Array(await file.arrayBuffer()) });
  }
  return files;
}
```

Run: `npx vitest run lib/skills/bundle.test.ts` → PASS.

- [ ] **Step 3: Add `directory` support + folder drop traversal to Dropzone**

In `components/primitives/dropzone.tsx`:

Add `directory?: boolean` to `DropzoneProps`. On the native `<input>`, set the non-standard attributes when `directory` is true:

```tsx
        <input
          // ...existing props...
          {...(directory ? ({ webkitdirectory: "", directory: "" } as any) : {})}
        />
```

Add a recursive drop-entry walker so dropping a folder yields files with relative paths. Add this helper in the file:

```tsx
async function readDropEntries(items: DataTransferItemList): Promise<File[]> {
  const out: File[] = [];
  const walk = (entry: any, prefix: string): Promise<void> =>
    new Promise((resolve) => {
      if (entry.isFile) {
        entry.file((file: File) => {
          Object.defineProperty(file, "webkitRelativePath", {
            value: prefix + file.name,
            configurable: true,
          });
          out.push(file);
          resolve();
        });
      } else if (entry.isDirectory) {
        const reader = entry.createReader();
        const readBatch = () =>
          reader.readEntries(async (ents: any[]) => {
            if (!ents.length) return resolve();
            await Promise.all(ents.map((e) => walk(e, prefix + entry.name + "/")));
            readBatch();
          });
        readBatch();
      } else resolve();
    });
  const roots = Array.from(items)
    .map((it) => (it.webkitGetAsEntry ? it.webkitGetAsEntry() : null))
    .filter(Boolean);
  await Promise.all(roots.map((r: any) => walk(r, "")));
  return out;
}
```

In the existing `onDrop` handler, when `directory` is enabled and `e.dataTransfer.items` is present, use `readDropEntries` instead of `e.dataTransfer.files`, then call `onFiles(collected)`. Keep the current file-based path for non-directory dropzones.

- [ ] **Step 4: Wire folder mode in the create dialog**

In `create-skill-dialog.tsx`, add a folder Dropzone (or a second `directory` Dropzone under a "Folder" affordance). Its `onFiles` handler:

```tsx
  const handleFolderFiles = async (fileList: File[]) => {
    const collected = await collectFromFileList(fileList);
    const check = validateBundleFiles(collected);
    if (!check.ok) {
      toast.error(check.error);
      return;
    }
    // Root folder name = the common top segment; fall back to the skill name.
    const top = collected[0]?.path.split("/")[0] || "skill";
    const zipBytes = zipFiles(collected, top);
    setUploadFile(new File([zipBytes], `${top}.zip`, { type: "application/zip" }));
    const meta = readSkillMetaFromZip(zipBytes);
    setName((prev) => prev || meta.name || top);
    setDescription((prev) => prev || meta.description || "");
  };
```

This reuses the existing upload branch (a zip `File` in `uploadFile` → `isZip: true`). Confirm the submit branch already handles a `.zip` `uploadFile`; no further change needed.

Add the imports:

```tsx
import {
  collectFromFileList,
  validateBundleFiles,
  zipFiles,
  readSkillMetaFromZip,
} from "@/lib/skills/bundle";
```

- [ ] **Step 5: Type-check, lint, unit tests**

Run: `npx tsc --noEmit && npm run lint && npx vitest run lib/skills/bundle.test.ts`
Expected: all pass.

- [ ] **Step 6: Manual verification**

Unzip `skill-auditor.skill` to a folder and (a) pick it via the folder button, (b) drag-drop the folder. Expected: both assemble a zip, validate, prefill name, and upload successfully. Dropping a folder without a SKILL.md at root shows the validation error and does not upload.

- [ ] **Step 7: Commit**

```bash
git add components/primitives/dropzone.tsx app/\(application\)/skills/components/create-skill-dialog.tsx lib/skills/bundle.ts lib/skills/bundle.test.ts
git commit -m "feat(skills): support full skill folder upload (picker + drag-drop + client zip)"
```

---

## Part 3 — Agent registry, bootstrap skill & installer

### Task 7: Skill access helpers + registry list endpoint

**Files:**
- Create: `src/skills/skill-access.ts`
- Create: `src/skills/skill-access.test.ts`
- Modify: `src/exulu/routes.ts` (add `GET /skills/registry`)

**Interfaces:**
- Produces:
  - `resolveSkillByName(db, name): Promise<any | null>` — the skill row or null.
  - `canAccessSkill(db, skill, action, user): Promise<boolean>` — hydrates RBAC via `RBACResolver(db, "skill", skill.id, skill.rights_mode)` then `checkRecordAccess`.
  - `filterReadableSkills(db, skills, user): Promise<any[]>`.
  - `GET /skills/registry?tag=` → `{ skills: { name, description, tags, current_version, updated_at }[] }`.

- [ ] **Step 1: Write failing tests for the pure logic**

Create `src/skills/skill-access.test.ts`. RBAC hydration hits the DB, so test the pieces we can isolate — public/creator fast-paths through a fake db that returns no rbac rows:

```typescript
import { canAccessSkill } from "./skill-access";

const fakeDb = () => {
  const fn: any = () => fn;
  fn.from = () => fn;
  fn.where = () => fn;
  fn.select = async () => []; // no rbac rows
  return fn;
};

describe("canAccessSkill", () => {
  it("allows the creator to read a private skill", async () => {
    const db = fakeDb();
    const skill = { id: "s1", rights_mode: "private", created_by: 42 };
    const user = { id: 42, type: "user" } as any;
    expect(await canAccessSkill(db, skill, "read", user)).toBe(true);
  });
  it("denies a non-creator reading a private skill", async () => {
    const db = fakeDb();
    const skill = { id: "s1", rights_mode: "private", created_by: 42 };
    const user = { id: 7, type: "user" } as any;
    expect(await canAccessSkill(db, skill, "read", user)).toBe(false);
  });
  it("allows anyone to read a public skill", async () => {
    const db = fakeDb();
    const skill = { id: "s1", rights_mode: "public", created_by: 42 };
    const user = { id: 7, type: "user" } as any;
    expect(await canAccessSkill(db, skill, "read", user)).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx jest src/skills/skill-access.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/skills/skill-access.ts`**

```typescript
import { RBACResolver } from "../../ee/rbac-resolver.ts";
import { checkRecordAccess } from "../utils/check-record-access.ts";
import type { User } from "@EXULU_TYPES/models/user";

export async function resolveSkillByName(db: any, name: string): Promise<any | null> {
  const row = await db("skills").where({ name }).first();
  return row ?? null;
}

export async function canAccessSkill(
  db: any,
  skill: any,
  action: "read" | "write",
  user?: User,
): Promise<boolean> {
  // Fast paths (public / creator / admin / api) don't need RBAC hydration, but
  // hydrating is cheap and keeps the users/roles/teams modes correct.
  const rbac = await RBACResolver(db, "skill", skill.id, skill.rights_mode || "private");
  return checkRecordAccess({ ...skill, RBAC: rbac }, action, user);
}

export async function filterReadableSkills(db: any, skills: any[], user?: User): Promise<any[]> {
  const out: any[] = [];
  for (const s of skills) {
    if (await canAccessSkill(db, s, "read", user)) out.push(s);
  }
  return out;
}
```

Confirm the relative import paths compile (`../../ee/rbac-resolver.ts` from `src/skills/`); adjust to the project's actual alias if `ee` is path-aliased.

- [ ] **Step 4: Run tests to verify pass**

Run: `npx jest src/skills/skill-access.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the `GET /skills/registry` route**

In `src/exulu/routes.ts`, near the other skill routes, add:

```typescript
  /**
   * GET /skills/registry?tag=<tag>
   * Agent-facing catalog of skills the caller may read. Addresses skills by
   * name (unique). RBAC-filtered via canAccessSkill.
   */
  app.get("/skills/registry", async (req: Request, res: Response) => {
    const authResult = await requestValidators.authenticate(req);
    if (!authResult.user?.id) {
      res.status(authResult.code ?? 401).json({ detail: authResult.message });
      return;
    }
    const { db } = await postgresClient();
    const tag = typeof req.query.tag === "string" ? req.query.tag : undefined;
    const all = await db("skills").select("*");
    const readable = await filterReadableSkills(db, all, authResult.user);
    const skills = readable
      .filter((s) => {
        if (!tag) return true;
        const tags = Array.isArray(s.tags) ? s.tags : [];
        return tags.includes(tag);
      })
      .map((s) => ({
        name: s.name,
        description: s.description ?? "",
        tags: Array.isArray(s.tags) ? s.tags : [],
        current_version: s.current_version ?? 1,
        updated_at: s.updatedAt ?? s.updated_at ?? null,
      }));
    res.json({ skills });
  });
```

Add the import at the top of `routes.ts`:

```typescript
import {
  resolveSkillByName,
  canAccessSkill,
  filterReadableSkills,
} from "../skills/skill-access.ts";
```

- [ ] **Step 6: Type-check + manual verification**

Run: `npm run type-check`
Then with a running server: `curl -s "$BACKEND/skills/registry" -H "Authorization: Bearer $TOKEN"` → JSON `{ skills: [...] }` containing only skills the user can read.

- [ ] **Step 7: Commit**

```bash
git add src/skills/skill-access.ts src/skills/skill-access.test.ts src/exulu/routes.ts
git commit -m "feat(skills): add RBAC-filtered registry list endpoint + access helpers"
```

---

### Task 8: Registry metadata endpoint (`GET /skills/registry/:name`)

**Files:**
- Modify: `src/exulu/routes.ts`

**Interfaces:**
- Consumes: `resolveSkillByName`, `canAccessSkill`.
- Produces: `GET /skills/registry/:name` → `{ name, description, tags, current_version, history }`; `404` unknown, `403` denied.

- [ ] **Step 1: Add the route**

```typescript
  app.get("/skills/registry/:name", async (req: Request, res: Response) => {
    const authResult = await requestValidators.authenticate(req);
    if (!authResult.user?.id) {
      res.status(authResult.code ?? 401).json({ detail: authResult.message });
      return;
    }
    const { db } = await postgresClient();
    const skill = await resolveSkillByName(db, req.params.name);
    if (!skill) {
      res.status(404).json({ detail: "Skill not found." });
      return;
    }
    if (!(await canAccessSkill(db, skill, "read", authResult.user))) {
      res.status(403).json({ detail: "You don't have access to this skill." });
      return;
    }
    res.json({
      name: skill.name,
      description: skill.description ?? "",
      tags: Array.isArray(skill.tags) ? skill.tags : [],
      current_version: skill.current_version ?? 1,
      history: Array.isArray(skill.history) ? skill.history : [],
    });
  });
```

Important: register this **after** `GET /skills/registry` (Express matches in order; the bare `/skills/registry` route and `/skills/registry/:name` don't collide, but keep specific-before-param ordering for the `/download` sub-route in Task 9).

- [ ] **Step 2: Type-check + manual verification**

Run: `npm run type-check`
`curl -s "$BACKEND/skills/registry/skill-auditor" -H "Authorization: Bearer $TOKEN"` → metadata JSON; unknown name → 404.

- [ ] **Step 3: Commit**

```bash
git add src/exulu/routes.ts
git commit -m "feat(skills): add registry metadata endpoint by name"
```

---

### Task 9: Registry download endpoint (`GET /skills/registry/:name/download`)

**Files:**
- Modify: `src/exulu/routes.ts`

**Interfaces:**
- Consumes: `resolveSkillByName`, `canAccessSkill`, existing S3 zip-bundling logic.
- Produces: `GET /skills/registry/:name/download?version=latest|<N>` → zip stream (single wrapper folder, so it unpacks to `<name>/…`).

- [ ] **Step 1: Add the route (register before `/skills/registry/:name`)**

```typescript
  app.get("/skills/registry/:name/download", async (req: Request, res: Response) => {
    const authResult = await requestValidators.authenticate(req);
    if (!authResult.user?.id) {
      res.status(authResult.code ?? 401).json({ detail: authResult.message });
      return;
    }
    const { db } = await postgresClient();
    const skill = await resolveSkillByName(db, req.params.name);
    if (!skill) {
      res.status(404).json({ detail: "Skill not found." });
      return;
    }
    if (!(await canAccessSkill(db, skill, "read", authResult.user))) {
      res.status(403).json({ detail: "You don't have access to this skill." });
      return;
    }

    const vQuery = req.query.version;
    const version =
      !vQuery || vQuery === "latest" ? (skill.current_version ?? 1) : Number(vQuery);
    if (!Number.isFinite(version) || version < 1) {
      res.status(400).json({ detail: "Invalid version." });
      return;
    }

    const safeName =
      String(skill.name ?? "skill").replace(/[^a-zA-Z0-9-_]+/g, "-").replace(/^-+|-+$/g, "") ||
      "skill";
    const versionPrefix = `skills/${skill.id}/v${version}/`;
    const files = await listS3ObjectsByPrefix(versionPrefix, config);
    if (files.length === 0) {
      res.status(404).json({ detail: `Version v${version} has no files.` });
      return;
    }

    const zip = new JSZip();
    for (const file of files) {
      const idx = file.key.indexOf(versionPrefix);
      const rel = idx >= 0 ? file.key.slice(idx + versionPrefix.length) : file.key;
      if (!rel) continue;
      const bytes = await getS3ObjectBytes(file.key, config);
      zip.file(`${safeName}/${rel}`, bytes); // wrapper folder → unpacks to <name>/
    }
    const buffer = await zip.generateAsync({ type: "nodebuffer" });
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="${safeName}.skill"`);
    res.send(buffer);
  });
```

- [ ] **Step 2: Type-check + manual verification**

Run: `npm run type-check`
`curl -s "$BACKEND/skills/registry/skill-auditor/download" -H "Authorization: Bearer $TOKEN" -o /tmp/s.skill && unzip -l /tmp/s.skill` → single `skill-auditor/` wrapper with SKILL.md.

- [ ] **Step 3: Commit**

```bash
git add src/exulu/routes.ts
git commit -m "feat(skills): add registry download-by-name endpoint"
```

---

### Task 10: Publish endpoint (`POST /skills/registry/:name`)

**Files:**
- Create: `src/skills/frontmatter.ts` (+ `src/skills/frontmatter.test.ts`)
- Modify: `src/exulu/routes.ts`

**Interfaces:**
- Consumes: `express.raw`, `extractBundleToS3`, `resolveSkillByName`, `canAccessSkill`, `parseSkillFrontmatter`, `randomUUID`.
- Produces: `POST /skills/registry/:name` (raw zip body) → create new skill (v1, private to caller) or append a new version to an owned skill. Returns `{ name, version, created: boolean }`.

- [ ] **Step 1: Write failing test for the frontmatter parser**

Create `src/skills/frontmatter.test.ts`:

```typescript
import { parseSkillFrontmatter } from "./frontmatter";

describe("parseSkillFrontmatter", () => {
  it("reads name/description from a zip buffer's SKILL.md", async () => {
    const JSZip = (await import("jszip")).default;
    const zip = new JSZip();
    zip.file("my-skill/SKILL.md", "---\nname: my-skill\ndescription: hi\n---\n# body");
    const bytes = await zip.generateAsync({ type: "nodebuffer" });
    expect(await parseSkillFrontmatter(bytes)).toEqual({ name: "my-skill", description: "hi" });
  });
  it("returns empty object when no SKILL.md", async () => {
    const JSZip = (await import("jszip")).default;
    const zip = new JSZip();
    zip.file("notes.txt", "hello");
    const bytes = await zip.generateAsync({ type: "nodebuffer" });
    expect(await parseSkillFrontmatter(bytes)).toEqual({});
  });
});
```

Run: `npx jest src/skills/frontmatter.test.ts` → FAIL (module missing).

- [ ] **Step 2: Implement `src/skills/frontmatter.ts`**

```typescript
import JSZip from "jszip";

/** Parse a leading --- fenced block of simple `key: value` scalar lines. */
export function parseFrontmatter(md: string): Record<string, string> {
  const match = /^﻿?---\r?\n([\s\S]*?)\r?\n---/.exec(md);
  if (!match) return {};
  const out: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[m[1]] = v;
  }
  return out;
}

/** Locate the post-unwrap-root SKILL.md inside a zip buffer and read its meta. */
export async function parseSkillFrontmatter(
  zipBytes: Buffer,
): Promise<{ name?: string; description?: string }> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(zipBytes);
  } catch {
    return {};
  }
  const paths: string[] = [];
  zip.forEach((p, entry) => {
    if (!entry.dir) paths.push(p);
  });
  const heads = new Set(paths.map((p) => p.split("/")[0]).filter(Boolean));
  let strip = (p: string) => p;
  if (heads.size === 1) {
    const head = [...heads][0] + "/";
    if (paths.every((p) => p.startsWith(head))) strip = (p) => p.slice(head.length);
  }
  const skillPath = paths.find((p) => strip(p) === "SKILL.md");
  if (!skillPath) return {};
  const md = await zip.file(skillPath)!.async("string");
  const fm = parseFrontmatter(md);
  return { name: fm.name, description: fm.description };
}
```

Run: `npx jest src/skills/frontmatter.test.ts` → PASS.

- [ ] **Step 3: Add the publish route with a raw-body parser**

In `src/exulu/routes.ts`, add near the top of the routes function (once):

```typescript
  const rawZip = express.raw({ type: ["application/zip", "application/octet-stream"], limit: "50mb" });
```

Then the route:

```typescript
  /**
   * POST /skills/registry/:name   (body: raw zip / .skill bytes)
   * Publish from an agent. New name -> create a private skill at v1. Existing
   * name the caller can write -> append a new version. 403 when the name
   * exists but the caller lacks write; 409 when it exists but the caller can't
   * even read it (don't leak existence details).
   */
  app.post("/skills/registry/:name", rawZip, async (req: Request, res: Response) => {
    const authResult = await requestValidators.authenticate(req);
    if (!authResult.user?.id) {
      res.status(authResult.code ?? 401).json({ detail: authResult.message });
      return;
    }
    const name = req.params.name;
    const bytes = req.body as Buffer;
    if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
      res.status(400).json({ detail: "Empty body. Send the skill as a zip/.skill payload." });
      return;
    }

    const { db } = await postgresClient();
    const existing = await resolveSkillByName(db, name);

    if (existing) {
      const canRead = await canAccessSkill(db, existing, "read", authResult.user);
      const canWrite = await canAccessSkill(db, existing, "write", authResult.user);
      if (!canRead) {
        res.status(409).json({ detail: "That name is unavailable." });
        return;
      }
      if (!canWrite) {
        res.status(403).json({ detail: "You don't have write access to this skill." });
        return;
      }
      // Append a new version: extract into a temp v0 slot is overkill; write
      // straight into the next version prefix by reusing extractBundleToS3
      // against a version-scoped id shim is not available, so we snapshot then
      // overwrite v(current) files is unsafe. Simplest correct approach: bump
      // version, extract into it.
      const nextVersion = (existing.current_version ?? 1) + 1;
      try {
        await extractBundleToVersion({ bytes, skillId: existing.id, version: nextVersion, config });
      } catch (err: any) {
        if (err instanceof BundleValidationError) {
          res.status(400).json({ detail: err.message });
          return;
        }
        console.error("[SKILLS] publish (new version) failed", err);
        res.status(500).json({ detail: "Failed to publish new version." });
        return;
      }
      const history = Array.isArray(existing.history) ? existing.history : [];
      await db("skills").where({ id: existing.id }).update({
        current_version: nextVersion,
        history: JSON.stringify([
          ...history,
          { version: nextVersion, created_at: new Date().toISOString(), label: "Published from agent" },
        ]),
      });
      res.json({ name, version: nextVersion, created: false });
      return;
    }

    // New skill.
    const meta = await parseSkillFrontmatter(bytes);
    const skillId = randomUUID();
    try {
      await extractBundleToVersion({ bytes, skillId, version: 1, config });
    } catch (err: any) {
      if (err instanceof BundleValidationError) {
        res.status(400).json({ detail: err.message });
        return;
      }
      console.error("[SKILLS] publish (create) failed", err);
      res.status(500).json({ detail: "Failed to publish skill." });
      return;
    }
    try {
      await db("skills").insert({
        id: skillId,
        name,
        description: meta.description ?? "",
        s3folder: `skills/${skillId}`,
        tags: JSON.stringify([]),
        usage_count: 0,
        favorite_count: 0,
        current_version: 1,
        history: JSON.stringify([
          { version: 1, created_at: new Date().toISOString(), label: "Published from agent" },
        ]),
        rights_mode: "private",
        created_by: authResult.user.id,
      });
    } catch (err: any) {
      // Unique-name race: someone created it between our lookup and insert.
      res.status(409).json({ detail: "That name is unavailable." });
      return;
    }
    res.json({ name, version: 1, created: true });
  });
```

- [ ] **Step 4: Add `extractBundleToVersion` to the extractor**

The existing `extractBundleToS3` hardcodes `v1`. Add a version-parameterized sibling in `src/skills/bundle-extractor.ts` and have the existing function delegate to it (DRY — no duplicated validation):

```typescript
export interface ExtractBundleToVersionOptions {
  bytes: Buffer;
  skillId: string;
  version: number;
  config: ExuluConfig;
}

/** Same validation as extractBundleToS3, writing to v<version> and always
 * treating the payload as a zip (publish always sends a zip/.skill). */
export async function extractBundleToVersion(
  opts: ExtractBundleToVersionOptions,
): Promise<ExtractBundleResult> {
  const { bytes, skillId, version, config } = opts;
  return extractZipToPrefix(bytes, `skills/${skillId}/v${version}/`, config);
}
```

Refactor: extract the body of `extractBundleToS3`'s zip branch (everything from `JSZip.loadAsync` through the upload loop) into a private `extractZipToPrefix(bytes, prefix, config)` that takes the destination prefix instead of hardcoding `skills/${skillId}/v1/`. Have `extractBundleToS3` call `extractZipToPrefix(bytes, \`skills/${skillId}/v1/\`, config)` for the zip case (and keep the single-`.md` fast path as-is, writing to `skills/${skillId}/v1/SKILL.md`). Update the S3 key line inside the loop to `const s3Key = \`${prefix}${relPath}\`;`.

Add the import in `routes.ts`:

```typescript
import { extractBundleToS3, extractBundleToVersion, BundleValidationError } from "../skills/bundle-extractor.ts";
```

And `parseSkillFrontmatter`:

```typescript
import { parseSkillFrontmatter } from "../skills/frontmatter.ts";
```

- [ ] **Step 5: Verify the extractor refactor didn't break the v1 path**

Run: `npx jest` (backend suite) and `npm run type-check`.
Expected: existing skill upload behavior unchanged (all pass). If bundle-extractor has no existing test, add one asserting `extractZipToPrefix` writes SKILL.md to the given prefix using a mocked `uploadFile` (spy) — assert the s3Key argument equals `skills/<id>/v2/SKILL.md` for version 2.

- [ ] **Step 6: Manual verification**

```bash
# create-new:
curl -s -X POST "$BACKEND/skills/registry/publish-test" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/zip" \
  --data-binary @/tmp/s.skill
# -> {"name":"publish-test","version":1,"created":true}
# re-publish same name as owner:
curl -s -X POST "$BACKEND/skills/registry/publish-test" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/zip" \
  --data-binary @/tmp/s.skill
# -> {"name":"publish-test","version":2,"created":false}
```

- [ ] **Step 7: Commit**

```bash
git add src/skills/frontmatter.ts src/skills/frontmatter.test.ts src/skills/bundle-extractor.ts src/exulu/routes.ts
git commit -m "feat(skills): agent publish endpoint (create + new version) with version-scoped extractor"
```

---

### Task 11: Client manifest + bootstrap asset + bootstrap endpoint

**Files:**
- Create: `src/skills/bootstrap/clients.ts`
- Create: `src/skills/bootstrap/exulu-skills.ts`
- Modify: `src/exulu/routes.ts` (add public `GET /skills/agent/bootstrap`)

**Interfaces:**
- Produces:
  - `CLIENT_MANIFEST: { id: string; dir: string }[]` — `dir` is the skill directory relative to a root (e.g. `.claude/skills`, `.tabnine/agent/skills`, `.agents/skills`).
  - `BOOTSTRAP_SKILL_MD: string`, `BOOTSTRAP_CLIENTS_JSON: string`.
  - `GET /skills/agent/bootstrap` → zip with `exulu-skills/SKILL.md` and `exulu-skills/references/clients.json`.

- [ ] **Step 1: Create the client manifest**

Create `src/skills/bootstrap/clients.ts` (the full list mirrors the directories in `test-skills/`; `.agents` first as the cross-agent standard):

```typescript
export interface ClientEntry {
  id: string;
  /** Skill directory relative to the install root (project dir or $HOME). */
  dir: string;
}

export const CLIENT_MANIFEST: ClientEntry[] = [
  { id: "agents", dir: ".agents/skills" }, // cross-agent standard (symlink canonical store)
  { id: "claude", dir: ".claude/skills" },
  { id: "windsurf", dir: ".windsurf/skills" },
  { id: "continue", dir: ".continue/skills" },
  { id: "roo", dir: ".roo/skills" },
  { id: "kilocode", dir: ".kilocode/skills" },
  { id: "crush", dir: ".crush/skills" },
  { id: "goose", dir: ".goose/skills" },
  { id: "qwen", dir: ".qwen/skills" },
  { id: "iflow", dir: ".iflow/skills" },
  { id: "junie", dir: ".junie/skills" },
  { id: "kiro", dir: ".kiro/skills" },
  { id: "trae", dir: ".trae/skills" },
  { id: "augment", dir: ".augment/skills" },
  { id: "factory", dir: ".factory/skills" },
  { id: "devin", dir: ".devin/skills" },
  { id: "openhands", dir: ".openhands/skills" },
  { id: "pi", dir: ".pi/skills" },
  { id: "cortex", dir: ".cortex/skills" },
  { id: "zencoder", dir: ".zencoder/skills" },
  { id: "codebuddy", dir: ".codebuddy/skills" },
  { id: "codestudio", dir: ".codestudio/skills" },
  { id: "commandcode", dir: ".commandcode/skills" },
  { id: "codemaker", dir: ".codemaker/skills" },
  { id: "codeartsdoer", dir: ".codeartsdoer/skills" },
  { id: "lingma", dir: ".lingma/skills" },
  { id: "qoder", dir: ".qoder/skills" },
  { id: "rovodev", dir: ".rovodev/skills" },
  { id: "moxby", dir: ".moxby/skills" },
  { id: "mux", dir: ".mux/skills" },
  { id: "neovate", dir: ".neovate/skills" },
  { id: "ona", dir: ".ona/skills" },
  { id: "pochi", dir: ".pochi/skills" },
  { id: "reasonix", dir: ".reasonix/skills" },
  { id: "terramind", dir: ".terramind/skills" },
  { id: "tinycloud", dir: ".tinycloud/skills" },
  { id: "vibe", dir: ".vibe/skills" },
  { id: "adal", dir: ".adal/skills" },
  { id: "aider-desk", dir: ".aider-desk/skills" },
  { id: "autohand", dir: ".autohand/skills" },
  { id: "bob", dir: ".bob/skills" },
  { id: "hermes", dir: ".hermes/skills" },
  { id: "inferencesh", dir: ".inferencesh/skills" },
  { id: "jazz", dir: ".jazz/skills" },
  { id: "kode", dir: ".kode/skills" },
  { id: "mcpjam", dir: ".mcpjam/skills" },
  { id: "tabnine", dir: ".tabnine/agent/skills" }, // exception: nested under agent/
];
```

- [ ] **Step 2: Create the bootstrap skill content**

Create `src/skills/bootstrap/exulu-skills.ts`. `BOOTSTRAP_CLIENTS_JSON` is derived from the manifest so the two never drift:

```typescript
import { CLIENT_MANIFEST } from "./clients.ts";

export const BOOTSTRAP_CLIENTS_JSON = JSON.stringify(CLIENT_MANIFEST, null, 2);

export const BOOTSTRAP_SKILL_MD = `---
name: exulu-skills
description: Install, update, and publish skills from this Exulu instance's central skill library. Use when the user asks to install a skill, get the latest version of a skill, list available skills, or publish a skill to Exulu.
---

# Exulu Skills

Bridge between this machine's coding agents and the Exulu central skill library.

## Config

Read \`~/.config/exulu/skills.json\`:
\`\`\`json
{ "base_url": "https://ai.example.com", "backend": "https://backend.ai.example.com", "api_key": "sk_...", "clients": ["claude","agents"], "link_mode": "copy" }
\`\`\`
- \`base_url\` is the Exulu frontend URL the user gave. \`backend\` is the API root.
- If \`backend\` is missing but \`base_url\` is present, resolve it: \`GET <base_url>/api/config\` returns \`{ "backend": "..." }\`. Cache it back into the file.
- If no config exists, ask the user for their Exulu base URL and API key, resolve the backend, and run the installer: \`curl -fsSL <base_url>/api/skills/install.sh | sh\`.

Normalize \`base_url\`: strip trailing slashes; default scheme to https.

## Client targets & layout

The file \`references/clients.json\` maps client ids to skill directories (e.g. \`claude\` -> \`.claude/skills\`, \`agents\` -> \`.agents/skills\`, \`tabnine\` -> \`.tabnine/agent/skills\`). \`.agents/skills\` is the cross-agent standard and the canonical store for symlink mode.

When installing or downloading, use the remembered \`clients\` + \`link_mode\` from config. If asked to change targets, present the client list, pre-selecting directories that already exist under the project root or \`$HOME\`, defaulting to \`agents\` when none exist.

- copy mode: write the skill's real files into each selected client dir; each copy gets a \`.exulu-skill.json\` marker.
- symlink mode: write the real files once into \`.agents/skills/<name>/\` (with the marker), then symlink \`<other-client>/skills/<name>\` -> the canonical store. If a symlink can't be created, copy instead and warn.

## List / search

\`GET <backend>/skills/registry\` with header \`Authorization: Bearer <api_key>\` -> \`{ skills: [{ name, description, tags, current_version, updated_at }] }\`. Filter/search client-side.

## Install ("install skill X")

1. \`GET <backend>/skills/registry/<name>/download\` (Authorization: Bearer). It streams a \`.skill\` zip with a single \`<name>/\` wrapper folder.
2. Unzip and place per the layout above (copy or symlink into the selected clients; project dir unless the user asked for global \`$HOME\`).
3. Write \`.exulu-skill.json\` into the installed folder: \`{ "name": "<name>", "version": <current_version>, "source": "<backend>" }\`.

## Update ("get the latest version")

For each installed skill that has an \`.exulu-skill.json\`: read its \`version\`, fetch \`GET <backend>/skills/registry/<name>\`, compare with \`current_version\`, and re-download when newer. In symlink mode one re-download into \`.agents/skills\` updates every linked client. Never touch a skill folder that has no marker file.

## Publish ("publish skill X to Exulu")

1. Zip the local skill folder (exclude the \`.exulu-skill.json\` marker and OS junk; resolve any symlinks to real files first). Root the zip at a single \`<name>/\` folder.
2. \`POST <backend>/skills/registry/<name>\` with header \`Authorization: Bearer <api_key>\` and \`Content-Type: application/zip\`, raw zip as the body.
   - New name -> creates a private skill at v1.
   - Existing name you can write -> appends a new version.
   - \`403\` = you lack write access; \`409\` = the name is taken by someone else.
3. Before overwriting an existing skill, fetch \`GET <backend>/skills/registry/<name>\` and confirm with the user that a new version of *that* skill is intended. On success, refresh the marker's \`version\`.

## Other agents (OpenCode etc.)

Same flows; the target directory is whatever client id applies from \`references/clients.json\`.
`;
```

- [ ] **Step 3: Add the public bootstrap route**

In `src/exulu/routes.ts` (no auth — mirror `GET /config`):

```typescript
  app.get("/skills/agent/bootstrap", async (_req: Request, res: Response) => {
    try {
      const zip = new JSZip();
      zip.file("exulu-skills/SKILL.md", BOOTSTRAP_SKILL_MD);
      zip.file("exulu-skills/references/clients.json", BOOTSTRAP_CLIENTS_JSON);
      const buffer = await zip.generateAsync({ type: "nodebuffer" });
      res.setHeader("Content-Type", "application/zip");
      res.setHeader("Content-Disposition", 'attachment; filename="exulu-skills.zip"');
      res.send(buffer);
    } catch (err: any) {
      console.error("[SKILLS] Failed to build bootstrap zip", err);
      res.status(500).json({ detail: "Failed to build bootstrap skill." });
    }
  });
```

Add the import:

```typescript
import { BOOTSTRAP_SKILL_MD, BOOTSTRAP_CLIENTS_JSON } from "../skills/bootstrap/exulu-skills.ts";
```

- [ ] **Step 4: Type-check + verify the asset survives the build**

Run: `npm run type-check && npm run build`
Then confirm the bootstrap content is bundled (not a missing file at runtime): `grep -c "exulu-skills" dist/*.js || true` should find the embedded string. (Because it's a TS string constant, tsup inlines it — no static-file dependency.)

- [ ] **Step 5: Manual verification**

`curl -s "$BACKEND/skills/agent/bootstrap" -o /tmp/boot.zip && unzip -l /tmp/boot.zip`
Expected: `exulu-skills/SKILL.md` and `exulu-skills/references/clients.json`.

- [ ] **Step 6: Commit**

```bash
git add src/skills/bootstrap/clients.ts src/skills/bootstrap/exulu-skills.ts src/exulu/routes.ts
git commit -m "feat(skills): embed exulu-skills bootstrap skill + public bootstrap endpoint"
```

---

### Task 12: Bootstrap content self-review (no code)

**Files:** none (review of `src/skills/bootstrap/exulu-skills.ts`)

- [ ] **Step 1: Verify the SKILL.md is self-consistent**

Read `BOOTSTRAP_SKILL_MD` and confirm: every endpoint path matches Tasks 7–10 exactly (`/skills/registry`, `/skills/registry/<name>`, `/skills/registry/<name>/download`, `POST /skills/registry/<name>`); the config field names match Task 13's writer (`base_url`, `backend`, `api_key`, `clients`, `link_mode`); the marker filename is `.exulu-skill.json` everywhere. Fix any drift inline.

- [ ] **Step 2: Commit if changed**

```bash
git add src/skills/bootstrap/exulu-skills.ts
git commit -m "docs(skills): tighten bootstrap skill instructions" || echo "no changes"
```

---

### Task 13: Installer route (frontend `/api/skills/install.sh`)

**Files:**
- Create: `lib/skills/clients.ts` (frontend copy of the manifest, for the shell array)
- Create: `app/api/skills/install.sh/route.ts`

**Interfaces:**
- Produces: `GET <baseUrl>/api/skills/install.sh` → `text/plain` POSIX shell script with the caller's base URL baked in.

- [ ] **Step 1: Create the frontend manifest copy**

Create `lib/skills/clients.ts` with the SAME entries as backend `src/skills/bootstrap/clients.ts` (keep identical):

```typescript
export const CLIENT_DIRS: { id: string; dir: string }[] = [
  { id: "agents", dir: ".agents/skills" },
  { id: "claude", dir: ".claude/skills" },
  // ... identical to backend clients.ts (all entries, tabnine -> .tabnine/agent/skills) ...
];
```

(Copy the full list from Task 11 Step 1.)

- [ ] **Step 2: Create the route handler**

Create `app/api/skills/install.sh/route.ts`:

```typescript
import { CLIENT_DIRS } from "@/lib/skills/clients";

export const dynamic = "force-dynamic";

function baseUrlFrom(request: Request): string {
  const h = request.headers;
  const proto = h.get("x-forwarded-proto") ?? "https";
  const host = h.get("x-forwarded-host") ?? h.get("host");
  return host ? `${proto}://${host}` : new URL(request.url).origin;
}

export async function GET(request: Request) {
  const baseUrl = baseUrlFrom(request).replace(/\/+$/, "");
  // "id:dir" pairs the shell splits; agents first so it's the default.
  const clientPairs = CLIENT_DIRS.map((c) => `${c.id}:${c.dir}`).join(" ");
  const script = renderInstaller(baseUrl, clientPairs);
  return new Response(script, {
    status: 200,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function renderInstaller(baseUrl: string, clientPairs: string): string {
  return `#!/bin/sh
set -eu

BASE_URL="${baseUrl}"
CLIENT_PAIRS="${clientPairs}"
CONFIG_DIR="$HOME/.config/exulu"
CONFIG_FILE="$CONFIG_DIR/skills.json"

say() { printf '%s\\n' "$*"; }
die() { printf 'error: %s\\n' "$*" >&2; exit 1; }

command -v curl >/dev/null 2>&1 || die "curl is required"
command -v unzip >/dev/null 2>&1 || die "unzip is required"

# 1. Resolve the backend URL from the frontend base URL.
say "Resolving backend from $BASE_URL/api/config ..."
CONFIG_JSON="$(curl -fsSL "$BASE_URL/api/config")" || die "could not reach $BASE_URL/api/config"
BACKEND="$(printf '%s' "$CONFIG_JSON" | sed -n 's/.*"backend"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p')"
[ -n "$BACKEND" ] || die "no 'backend' field in /api/config response"
BACKEND="$(printf '%s' "$BACKEND" | sed 's:/*$::')"
say "Backend: $BACKEND"

# 2. Pick install root (project dir vs home).
ROOT="$(pwd)"
if [ -t 0 ] || [ -r /dev/tty ]; then
  printf 'Install into current project (%s) or home (~)? [project/home] ' "$ROOT" > /dev/tty
  read ANSWER < /dev/tty || ANSWER="project"
  [ "$ANSWER" = "home" ] && ROOT="$HOME"
fi
say "Install root: $ROOT"

# 3. Determine target clients: pre-select those whose dir already exists.
SELECTED=""
for pair in $CLIENT_PAIRS; do
  id="\${pair%%:*}"; dir="\${pair#*:}"
  if [ -d "$ROOT/\${dir%/skills}" ] || [ -d "$ROOT/$dir" ]; then
    SELECTED="$SELECTED $id"
  fi
done
[ -n "$SELECTED" ] || SELECTED="agents"
if [ -r /dev/tty ]; then
  printf 'Install into clients [%s]. Enter to accept, or type space-separated ids: ' "$(echo $SELECTED)" > /dev/tty
  read CHOICE < /dev/tty || CHOICE=""
  [ -n "$CHOICE" ] && SELECTED="$CHOICE"
fi
say "Clients: $(echo $SELECTED)"

# 4. Layout: copy (default) or symlink.
LINK_MODE="copy"
if [ -r /dev/tty ]; then
  printf 'Share one copy across clients via symlink? [y/N] ' > /dev/tty
  read S < /dev/tty || S="n"
  case "$S" in y|Y) LINK_MODE="symlink";; esac
fi
say "Layout: $LINK_MODE"

# 5. Download the bootstrap skill.
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
curl -fsSL "$BACKEND/skills/agent/bootstrap" -o "$TMP/boot.zip" || die "could not download bootstrap skill"
unzip -q "$TMP/boot.zip" -d "$TMP/unpacked" || die "could not unzip bootstrap skill"
SRC="$TMP/unpacked/exulu-skills"
[ -d "$SRC" ] || die "unexpected bootstrap layout"

# dir_for CLIENT_ID -> relative skill dir
dir_for() { for pair in $CLIENT_PAIRS; do case "$pair" in "$1:"*) printf '%s' "\${pair#*:}"; return;; esac; done; }

place() { # place <dest-parent-skills-dir>
  dest="$1/exulu-skills"
  if [ -e "$dest" ] && [ ! -f "$dest/.exulu-skill.json" ] && [ ! -L "$dest" ]; then
    say "skip $dest (exists, not managed by exulu)"; return
  fi
  rm -rf "$dest"
  mkdir -p "$1"
  cp -R "$SRC" "$dest"
}

CANON="$ROOT/.agents/skills"
if [ "$LINK_MODE" = "symlink" ]; then
  mkdir -p "$CANON"; place "$CANON"
fi
for id in $SELECTED; do
  d="$(dir_for "$id")"; [ -n "$d" ] || continue
  parent="$ROOT/$d"
  if [ "$LINK_MODE" = "symlink" ] && [ "$id" != "agents" ]; then
    mkdir -p "$parent"
    if ln -s "$CANON/exulu-skills" "$parent/exulu-skills" 2>/dev/null; then
      say "linked $parent/exulu-skills"
    else
      say "symlink failed for $parent; copying"; place "$parent"
    fi
  else
    place "$parent"
  fi
done

# 6. API key + config.
mkdir -p "$CONFIG_DIR"
API_KEY=""
if [ -f "$CONFIG_FILE" ]; then
  API_KEY="$(sed -n 's/.*"api_key"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p' "$CONFIG_FILE")"
fi
if [ -r /dev/tty ]; then
  printf 'Exulu API key%s: ' "$( [ -n "$API_KEY" ] && echo ' (Enter to keep existing)')" > /dev/tty
  stty -echo 2>/dev/null || true
  read NEWKEY < /dev/tty || NEWKEY=""
  stty echo 2>/dev/null || true
  printf '\\n' > /dev/tty
  [ -n "$NEWKEY" ] && API_KEY="$NEWKEY"
fi

CLIENTS_JSON="$(printf '%s' "$SELECTED" | awk '{for(i=1;i<=NF;i++){printf "%s\\"%s\\"",(i>1?",":""),$i}}')"
cat > "$CONFIG_FILE" <<EOF
{
  "base_url": "$BASE_URL",
  "backend": "$BACKEND",
  "api_key": "$API_KEY",
  "clients": [$CLIENTS_JSON],
  "link_mode": "$LINK_MODE"
}
EOF
chmod 600 "$CONFIG_FILE"

if [ -z "$API_KEY" ]; then
  say ""
  say "No API key set. Add one to $CONFIG_FILE (\\"api_key\\": \\"sk_...\\") to enable install/update/publish."
fi
say ""
say "Done. The 'exulu-skills' skill is installed. Ask your agent to \\"list Exulu skills\\" or \\"install skill <name>\\"."
`;
}
```

- [ ] **Step 3: Type-check + lint**

Run: `cd /Users/daniel.claessen/Desktop/Projects/exulu/frontend && npx tsc --noEmit && npm run lint`
Expected: no new errors.

- [ ] **Step 4: Lint the generated shell with shellcheck**

Fetch and shellcheck the rendered script:
```bash
curl -fsSL "http://localhost:3000/api/skills/install.sh" -o /tmp/install.sh
shellcheck -s sh /tmp/install.sh || true
```
Expected: no errors (warnings about `read` without `-r` in POSIX sh are acceptable; fix any genuine syntax error).

- [ ] **Step 5: Manual verification (end-to-end, local)**

With backend + frontend running locally and a valid API key:
```bash
cd /tmp/agent-test && mkdir -p .claude/skills
curl -fsSL "http://localhost:3000/api/skills/install.sh" | sh
```
Expected: prompts for root/clients/symlink/API key; installs `exulu-skills` into `.claude/skills/` (pre-selected because `.claude` exists) and `.agents/skills/`; writes `~/.config/exulu/skills.json` (chmod 600) with `base_url`, resolved `backend`, `clients`, `link_mode`. Verify `cat ~/.config/exulu/skills.json`.

- [ ] **Step 6: Commit**

```bash
git add lib/skills/clients.ts "app/api/skills/install.sh/route.ts"
git commit -m "feat(skills): installer route resolving per-client backend + multi-client bootstrap install"
```

---

### Task 14: "Connect your agent" dialog + install hint

**Files:**
- Create: `app/(application)/skills/components/connect-agent-dialog.tsx`
- Modify: `app/(application)/skills/components/skill-detail-panel.tsx` (overflow menu: `.skill` export + install hint)
- Modify: the skills page/toolbar to mount the Connect dialog (wherever the primary actions live — the same toolbar that hosts the create-skill button)

**Interfaces:**
- Consumes: `/api/config` (to display the current instance base URL), `skillsApi.download(id, version, "skill")`.
- Produces: a dialog showing the one-liner; a detail-panel action to export `.skill` and to copy an install prompt.

- [ ] **Step 1: Build the Connect dialog**

Create `app/(application)/skills/components/connect-agent-dialog.tsx`. It reads the current origin in the browser (`window.location.origin`) and shows the one-liner; no server round-trip needed since the install route lives on this same origin:

```tsx
"use client";
import * as React from "react";
import { toast } from "sonner";
// Use the project's existing Dialog + Button primitives (match imports used in
// create-skill-dialog.tsx).

export function ConnectAgentDialog({ open, onOpenChange }: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const [origin, setOrigin] = React.useState("");
  React.useEffect(() => {
    if (typeof window !== "undefined") setOrigin(window.location.origin);
  }, []);
  const cmd = `curl -fsSL ${origin}/api/skills/install.sh | sh`;
  return (
    /* Dialog wrapper (match the app's Dialog primitive) */
    <div>
      <p>Run this in your terminal to connect your coding agent to this Exulu instance:</p>
      <pre><code>{cmd}</code></pre>
      <button
        onClick={() => {
          void navigator.clipboard.writeText(cmd);
          toast.success("Copied");
        }}
      >Copy</button>
      <p>
        Your agent will ask which clients to install into (Claude Code, OpenCode, and others)
        and whether to share one copy across them via symlinks. You'll need an API key —
        create one in settings.
      </p>
    </div>
  );
}
```

Replace the placeholder `<div>`/`<button>` with the project's actual `Dialog`, `DialogContent`, and `Button` components (copy the import lines from `create-skill-dialog.tsx`). Add a "Connect your agent" trigger button in the skills toolbar next to the create button, wiring `open` state.

- [ ] **Step 2: Add `.skill` export + install hint to the detail panel**

In `skill-detail-panel.tsx`, add two items to `headerOverflowItems`:

```tsx
    {
      label: t("detail.exportSkill"),
      icon: FileArchive, // import from lucide-react
      onSelect: () => void handleExportSkill(),
      disabled: downloading,
    },
    {
      label: t("detail.copyInstallPrompt"),
      icon: Copy,
      onSelect: () => {
        void navigator.clipboard.writeText(`Install the Exulu skill "${skill.name}"`);
        toast.success(tCommon("copied"));
      },
    },
```

Add the `handleExportSkill` callback next to `handleDownloadZip` (same body, but `.skill`):

```tsx
  const handleExportSkill = React.useCallback(async () => {
    setDownloading(true);
    const version = skill.current_version ?? 1;
    try {
      const blob = await skillsApi.download(skill.id, version, "skill");
      const safeName = String(skill.name ?? "skill")
        .replace(/[^a-zA-Z0-9-_]+/g, "-").replace(/^-+|-+$/g, "") || "skill";
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${safeName}.skill`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      toast.success(t("detail.downloadStarted"));
    } catch (err) {
      toast.error(t("detail.downloadFailed"), { description: (err as Error).message });
    } finally {
      setDownloading(false);
    }
  }, [skill.id, skill.current_version, skill.name, t]);
```

Add `handleExportSkill` to the `headerOverflowItems` memo dependency array.

- [ ] **Step 3: Add the i18n strings**

Add keys used above (`detail.exportSkill`, `detail.copyInstallPrompt`, and a `connect.*` set if the dialog uses translations) to the skills message catalog(s). Run `npm run check-messages` and resolve any missing-key report.

- [ ] **Step 4: Type-check + lint**

Run: `npx tsc --noEmit && npm run lint`
Expected: no new errors.

- [ ] **Step 5: Manual verification**

- Open the skills page → "Connect your agent" → the one-liner shows `https://<this-host>/api/skills/install.sh` and Copy works.
- On a skill's detail panel overflow menu → "Export .skill" downloads `<name>.skill` (single wrapper folder); "Copy install prompt" copies `Install the Exulu skill "<name>"`.

- [ ] **Step 6: Commit**

```bash
git add app/\(application\)/skills/components/connect-agent-dialog.tsx app/\(application\)/skills/components/skill-detail-panel.tsx
# plus the toolbar file and message catalogs you touched
git commit -m "feat(skills): add Connect-your-agent dialog and .skill export / install-prompt actions"
```

---

## Self-Review

**Spec coverage:**
- Part 1 `.skill` upload → Task 1 (upload-sign), Task 3 (frontend). `.skill` export → Task 2, Task 14. Frontmatter prefill → Task 5 (and folder Task 6). ✅
- Part 2 folder upload (picker + drag-drop + client zip + validation) → Tasks 4, 6. ✅
- Part 3 registry list/metadata/download/publish → Tasks 7, 8, 9, 10. URL resolution → Task 13 (installer) + bootstrap SKILL.md (Task 11). Bootstrap skill + manifest + public endpoint → Tasks 11, 12. Multi-client + copy/symlink → Task 13 (installer) + documented for library skills in Task 11's SKILL.md. Connect dialog + install hint → Task 14. ✅
- Error handling (400/403/404/409, symlink fallback, no-marker skip) → Tasks 9, 10, 13. ✅

**Placeholder scan:** No "TBD"/"handle appropriately" — each code step carries real content. UI primitive imports are the one deliberate "match the existing component" instruction (Task 14); acceptable because the exact primitives are project-specific and named in `create-skill-dialog.tsx`.

**Type consistency:** `extractBundleToVersion` (Task 10) and its private `extractZipToPrefix` are defined in Task 10 Step 4 and imported in Step 3. `canAccessSkill`/`resolveSkillByName`/`filterReadableSkills` defined in Task 7, imported in Tasks 8–10. `readSkillMetaFromZip`/`collectFromFileList`/`validateBundleFiles`/`zipFiles` defined in Tasks 4/6, consumed in Tasks 5/6. Config field names (`base_url`, `backend`, `api_key`, `clients`, `link_mode`) match between the installer (Task 13) and bootstrap SKILL.md (Task 11), re-verified in Task 12. Endpoint paths match between routes (Tasks 7–11) and the bootstrap doc. Marker filename `.exulu-skill.json` consistent across Tasks 11 and 13. Client manifest duplicated backend (Task 11) / frontend (Task 13) — flagged as a keep-in-sync constraint.

**Route-order note:** register `/skills/registry/:name/download` (Task 9) before `/skills/registry/:name` (Task 8), and both after the literal `/skills/registry` (Task 7).
