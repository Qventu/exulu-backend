# Skill Library: `.skill` Upload, Folder Upload & Agent Distribution

**Date:** 2026-07-08
**Status:** Approved design, pending implementation plan
**Repos:** `exulu/backend`, `exulu/frontend`

## Motivation

Users work with skills in agent environments (Claude Code, OpenCode, claude.ai) and want the central Exulu skill library to interoperate with them:

1. Upload `.skill` files — Anthropic's (undocumented) zip packaging used by claude.ai.
2. Upload a full skill folder — today the file picker descends into the directory instead of accepting it.
3. Use the library as a "plugin repo": tell an agent "install skill X" or "fetch the latest version" and have it pull from Exulu.
4. Publish from the agent back to Exulu: upload a new skill or push an updated version of an existing one without going through the UI.

## Background facts (verified)

- A `.skill` file is a plain zip archive containing `<skill-name>/SKILL.md` plus optional support files (e.g. `references/`). Example verified: `skill-auditor.skill` → `skill-auditor/SKILL.md`, `skill-auditor/references/applying-edits.md`.
- The existing bundle extractor (`src/skills/bundle-extractor.ts`) already handles this exact shape: zip validation, single-folder-wrapper unwrap, `SKILL.md`-at-root requirement, 50 MB / 500-entry limits, junk filtering. Only the `.skill` file extension is rejected today.
- Claude Code's native plugin marketplace is git-centric: plugin sources must be git repos or npm packages; HTTPS zip sources and custom auth headers (API keys) are not supported; single skills cannot be installed — only whole plugins. This rules out serving a native marketplace directly from the backend and motivates the REST-registry approach (decision below).

## Decisions

- **Distribution model:** REST registry + bootstrap skill (chosen over git-sync marketplace, and over doing both). Works uniformly for Claude Code, OpenCode, and other agents; respects existing API-key auth and RBAC; allows installing single skills.
- **Bootstrap delivery:** Copy-paste install one-liner shown in the platform UI (chosen over a public GitHub marketplace repo). No external hosting to maintain; the script always serves the current bootstrap skill.

## Part 1 — `.skill` upload (and export)

### Backend (`src/exulu/routes.ts`)

- `POST /skills/:skillId/upload-sign`: accept extension `.skill` in addition to `.zip` / `.md`. Content type `application/zip` (or `application/octet-stream`).
- `POST /skills/:skillId/init-from-upload`: treat a `.skill` staging key exactly like `.zip` (the extractor is unchanged).
- `GET /skills/:skillId/download`: new optional query param `format=skill`. When set, the bundle is wrapped in a single `<skill-name>/` folder inside the zip and served with filename `<skill-name>.skill` — round-trip compatible with claude.ai upload. Default (`format=zip`) behavior unchanged.

### Frontend (`app/(application)/skills/components/create-skill-dialog.tsx`)

- Dropzone accepts `.skill` by extension (browsers report no MIME type for it).
- **Frontmatter prefill:** on selecting a `.skill`/`.zip`, read the archive client-side (fflate, shared with Part 2), locate `SKILL.md` (post-unwrap root), parse YAML frontmatter, and prefill the dialog's name/description fields. Prefill is best-effort: parse failure never blocks the upload.
- Skill detail panel / editor: the existing download action gains a `.skill` export option.

## Part 2 — Folder upload

Frontend-only; reuses the existing zip pipeline (upload-sign → presigned PUT → init-from-upload). No new backend path.

- **Folder picker:** secondary "select folder" affordance using `webkitdirectory`.
- **Drag-and-drop of folders:** Dropzone drop handler traverses `DataTransferItem.webkitGetAsEntry()` recursively to collect files with relative paths.
- **Client-side zip:** assemble the collected files into a zip with fflate, rooted at the folder name (single-folder wrapper — the backend unwraps it).
- **Pre-upload validation (client-side, mirrors backend limits):**
  - `SKILL.md` must exist at the folder root → otherwise a clear error, no upload.
  - ≤ 50 MB uncompressed, ≤ 500 files → otherwise a clear error.
  - OS junk (`.DS_Store`, `__MACOSX/`, `Thumbs.db`, `desktop.ini`, `.git/`) is skipped during collection.
- Frontmatter prefill from Part 1 applies to folder uploads too.

## Part 3 — Agent registry + bootstrap skill

### Registry endpoints (backend, `src/exulu/routes.ts`)

All authenticated with the existing mechanisms (`Authorization` bearer / `exulu-api-key`), all RBAC-filtered to skills the calling user may read. Skills are addressed **by name** (the `skills.name` column is already unique + indexed).

| Endpoint | Method | Purpose |
|---|---|---|
| `/skills/registry` | GET | List visible skills: `{ name, description, tags, current_version, updated_at }[]`. Optional `?tag=` filter. |
| `/skills/registry/:name` | GET | Single skill metadata incl. version history. 404 if unknown, 403 if RBAC denies. |
| `/skills/registry/:name/download` | GET | Zip stream of the skill bundle. `?version=latest` (default) or `?version=<N>`. Reuses the existing bundler used by `/skills/:skillId/download`, with lookup by name. |
| `/skills/registry/:name` | POST | **Publish**: raw zip body (`Content-Type: application/zip`, `.skill` payloads are identical). If no skill with this name exists → create the skill (private to the caller, description/tags from SKILL.md frontmatter) and extract to `v1`. If it exists and the caller has write access → extract into the next version slot, update `current_version` + `history`. Same validation as the UI path (`bundle-extractor.ts`: SKILL.md at root, 50 MB, 500 entries). |
| `/skills/agent/install.sh` | GET | **Public** (no auth): shell script for the bootstrap one-liner. |
| `/skills/agent/bootstrap` | GET | **Public**: zip of the `exulu-skills` bootstrap skill, fetched by the install script. |

The public endpoints expose only the generic bootstrap skill and installer — no library content.

### Bootstrap skill `exulu-skills`

Lives as a static asset in the backend repo (e.g. `src/skills/bootstrap/exulu-skills/SKILL.md`), served by `/skills/agent/bootstrap`.

Its `SKILL.md` teaches the agent:

- **Config:** read `~/.config/exulu/skills.json` → `{ "backend": "<url>", "api_key": "<key>" }`.
- **List/search:** `GET /skills/registry` with the API key.
- **Install ("installier mal X"):** download `GET /skills/registry/<name>/download`, unzip into `.claude/skills/<name>/` (project) or `~/.claude/skills/<name>/` (global — ask the user which, default project), then write a marker file `.exulu-skill.json` → `{ "name", "version", "source" }` into the installed folder.
- **Update ("hol die aktuellste Version"):** for each installed skill with an `.exulu-skill.json`, compare `version` against `current_version` from the registry; re-download when newer. Never overwrite a folder without a marker file (it wasn't installed from Exulu).
- **Publish ("lad den Skill nach Exulu hoch"):** zip the local skill folder (excluding the `.exulu-skill.json` marker and OS junk) and `POST /skills/registry/<name>` with the zip body. New name → new skill; existing name with write access → new version. On success, write/refresh the marker file with the returned version. Before publishing over an existing skill, fetch its metadata and confirm with the user that a new version of *that* skill is intended.
- **OpenCode & others:** same flow, target the harness's skill directory instead of `.claude/skills/`.

### Install script (`/skills/agent/install.sh`)

- Downloads and unpacks the bootstrap skill into `~/.claude/skills/exulu-skills/` (creates the directory if needed). If an OpenCode skill directory exists (`~/.config/opencode/skills/` or `~/.opencode/skills/`), installs a copy there as well.
- Prompts interactively for the API key (never passed on the command line → nothing sensitive in shell history) and writes `~/.config/exulu/skills.json` with `chmod 600`. Because the script runs as `curl … | sh` (stdin is the pipe), the prompt reads from `/dev/tty`; when no TTY is available it skips the prompt and prints instructions for creating the config manually. Backend URL is baked into the script at serve time from `process.env.BACKEND`.
- Idempotent: re-running updates the bootstrap skill in place and keeps existing config unless the user re-enters a key.

### Frontend

- **"Connect your agent" dialog** on the skills page: shows the one-liner (`curl -fsSL $BACKEND/api/skills/agent/install.sh | sh`), short explanation, link to API-key management.
- **Per-skill install hint:** copy button on the skill detail panel producing the agent prompt, e.g. `Install the Exulu skill "<name>"`.

## Error handling

- Upload: unsupported extension → existing 400 path; `.skill` archives failing validation get the same errors as `.zip` (missing SKILL.md, size, entry count, unsafe paths).
- Folder upload: all validation errors surface in the dialog before any network call.
- Registry: 404 unknown name, 403 RBAC denial, 400 invalid version. Download of a version that has no files → 404 with explicit message.
- Publish: 400 on validation failure (missing SKILL.md, size/entry limits, name in path not matching a creatable/writable skill), 403 when the name exists but the caller lacks write access, 409 when the name exists but is owned by another user the caller cannot even see (avoids leaking existence: respond 409 "name unavailable"). Payload size enforced before buffering completes (request size limit on the route).
- Install script: fails loudly (set -e) with actionable messages; never leaves a partial skill folder (unpack to temp, then move).

## Testing

- **Backend unit tests:** upload-sign extension acceptance (`.skill` ok, others rejected); `format=skill` download produces wrapped zip with correct filename; registry list respects RBAC (visible vs. denied user); by-name lookup 404/403/version resolution; publish creates v1 for a new name, bumps version for an owned name, 403/409 for foreign names, 400 for invalid bundles; install.sh endpoint serves script with correct backend URL.
- **Frontend:** unit tests for folder collection → zip assembly (junk filtering, SKILL.md validation, limits) and frontmatter prefill parsing; manual UAT for picker, drag-and-drop, and `.skill` upload with the real `skill-auditor.skill`.
- **End-to-end (manual):** run the one-liner locally, then in a Claude Code session: "installier mal skill-auditor" and "hol die aktuellste Version" against a local backend.

## Out of scope

- Native Claude Code plugin marketplace (git-sync) — possible later stage, explicitly deferred.
- Public unauthenticated skill sharing.
