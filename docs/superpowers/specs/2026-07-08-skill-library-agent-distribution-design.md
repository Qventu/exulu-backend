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
5. Work against any client's instance: instances are per-client (e.g. `https://ai.open.de`) with a separate backend host (e.g. `https://backend.ai.open.de`), so the agent must take the base URL from the user and resolve the backend URL from it.
6. Install into whichever coding agents the user runs: skills live in per-client dirs (`.<client>/skills/`, plus the cross-agent `.agents/skills/`), so install/download must let the user pick target clients (multi-select) and optionally share one copy across them via symlinks.

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
| `/skills/agent/bootstrap` | GET | **Public** (no auth): zip of the `exulu-skills` bootstrap skill, fetched by the install script. |

The public endpoint exposes only the generic bootstrap skill — no library content. The installer itself is served by the **frontend** (see "URL resolution" below), because the URL the user knows is the frontend base URL.

### URL resolution (base URL → backend URL)

Exulu instances are per-client and split across two hosts: a **frontend base URL** the user knows (e.g. `https://ai.open.de`) and a **backend/API URL** that differs (e.g. `https://backend.ai.open.de`). The user only ever supplies the base URL; the backend URL is resolved from it.

- **Contract:** `GET <baseUrl>/api/config` (an existing unauthenticated Next.js route, `frontend/app/api/config/route.ts`) returns `{ "backend": "<backend-url>", … }`. The `backend` field is the API root for all `/skills/registry/*` and `/skills/agent/*` calls. This is the same mechanism the Claude Code CLI already uses; the route's own comment documents this purpose.
- **Base-URL normalization:** strip a trailing slash before appending `/api/config` (`cleanBaseUrl = baseUrl.replace(/\/+$/, "")`), default the scheme to `https://` if the user omits it, and reject anything that doesn't resolve to a JSON body containing `backend`.
- **Installer** (`GET <baseUrl>/api/skills/install.sh`, a new frontend Next.js route alongside `/api/config`): serves the shell script with the caller's base URL baked in. Because it lives on the frontend, the one-liner naturally points at the client's own instance and the script can resolve the backend URL via `/api/config` at run time.

### Agent client targets & layout

Skills are read from a per-client directory. Coding agents converge on `.<client>/skills/<skill-name>/` under the project root (and the same under `$HOME` for a global install), with `.agents/skills/` as the emerging **cross-agent standard** directory. The bootstrap skill and the install script share one **client manifest** — a `client-id → relative skill dir` table — derived from the reference layout in `test-skills/` (mirrors `vercel-labs/agent-skills`). Notable entries:

- Standard `.<client>/skills/`: `agents` (the shared standard), `claude`, `windsurf`, `continue`, `roo`, `kilocode`, `crush`, `goose`, `qwen`, `iflow`, `junie`, `kiro`, `trae`, `augment`, `factory`, `devin`, `openhands`, `pi`, `cortex`, `zencoder`, `codebuddy`, `codestudio`, `commandcode`, `codemaker`, `codeartsdoer`, `lingma`, `qoder`, `rovodev`, `moxby`, `mux`, `neovate`, `ona`, `pochi`, `reasonix`, `terramind`, `tinycloud`, `vibe`, `adal`, `aider-desk`, `autohand`, `bob`, `hermes`, `inferencesh`, `jazz`, `kode`, `mcpjam`.
- Exception: `tabnine` → `.tabnine/agent/skills/`.

The manifest is data, not code branches, so new clients are one-line additions. The full list is generated from the `test-skills/` directory names (excluding the `data/` and bare `skills/` source folders).

**Client selection (multi-select).** When installing or downloading any skill (including the bootstrap skill itself), the user picks one or more target clients. The list shows all manifest clients, but **pre-selects only those whose directory already exists** in the project or `$HOME`. If none is detected, the default selection is `.agents/skills/` (the cross-agent standard). Scope (project vs. global `$HOME`) is asked once, default project.

**Layout: copy (default) vs. symlink (opt-in).**

- **Copy** (default): unpack real files into each selected client directory. Robust everywhere (incl. Windows without symlink privilege); every copy carries its own `.exulu-skill.json` marker.
- **Symlink** (opt-in): unpack real files once into the canonical store `.agents/skills/<name>/` (holding the marker), then create a symlink `<other-client>/skills/<name>` → the canonical store for every other selected client. One update location; updates re-download into the canonical store and existing symlinks stay valid. If a target can't be symlinked (e.g. Windows without privilege), the skill falls back to a copy for that target and warns.

The chosen clients + layout mode are remembered in config (`clients`, `link_mode`) so later installs/updates don't re-ask; the user can override per run.

### Bootstrap skill `exulu-skills`

Lives as a static asset in the backend repo (e.g. `src/skills/bootstrap/exulu-skills/SKILL.md`), served by `/skills/agent/bootstrap`. It ships the client manifest (as a data file, e.g. `references/clients.json`).

Its `SKILL.md` teaches the agent:

- **Config:** read `~/.config/exulu/skills.json` → `{ "base_url": "<frontend-url>", "backend": "<api-url>", "api_key": "<key>", "clients": ["claude", …], "link_mode": "copy" | "symlink" }`. `base_url` is what the user supplied; `backend` is the resolved API root (see "URL resolution"). `clients`/`link_mode` are the remembered target selection (see "Agent client targets & layout"). If `backend` is missing but `base_url` is present, the skill re-resolves it via `GET <base_url>/api/config` and caches it back. If no config exists at all, the skill asks the user for their Exulu base URL and API key, resolves the backend, and offers to run the installer.
- **List/search:** `GET <backend>/skills/registry` with the API key.
- **Install ("installier mal X"):** download `GET <backend>/skills/registry/<name>/download`, then place it into the selected client directories using the chosen layout (see "Agent client targets & layout" — multi-select clients, copy vs. symlink, project vs. global). Write the marker file `.exulu-skill.json` → `{ "name", "version", "source" }` into the canonical copy (symlink mode) or each copy (copy mode).
- **Update ("hol die aktuellste Version"):** for each installed skill with an `.exulu-skill.json`, compare `version` against `current_version` from the registry; re-download when newer. In symlink mode, one re-download into the canonical store updates all linked clients; in copy mode, refresh every copy. Never overwrite a folder without a marker file (it wasn't installed from Exulu).
- **Publish ("lad den Skill nach Exulu hoch"):** zip the local skill folder (excluding the `.exulu-skill.json` marker and OS junk; resolve symlinks to real files first) and `POST <backend>/skills/registry/<name>` with the zip body. New name → new skill; existing name with write access → new version. On success, write/refresh the marker file with the returned version. Before publishing over an existing skill, fetch its metadata and confirm with the user that a new version of *that* skill is intended.

### Install script (frontend route `/api/skills/install.sh`)

- Served by the frontend with the caller's **base URL** baked in (the frontend knows its own origin). The one-liner therefore always targets the client's own instance.
- **Resolves the backend URL first:** `cleanBaseUrl=<baseUrl without trailing slash>; backend=$(curl -fsSL "$cleanBaseUrl/api/config" | <extract .backend>)`. Aborts with a clear message if `/api/config` is unreachable or has no `backend` field.
- Downloads the bootstrap skill from `<backend>/skills/agent/bootstrap` and installs it into the selected client directories (same client manifest + selection logic as "Agent client targets & layout"): detects existing client dirs, pre-selects them, defaults to `.agents/skills/` when none is found, and honors copy vs. symlink. The bootstrap skill's own `exulu-skills/` folder is placed the same way library skills are.
- Prompts interactively for the API key (never passed on the command line → nothing sensitive in shell history) and writes `~/.config/exulu/skills.json` (`{ base_url, backend, api_key, clients, link_mode }`) with `chmod 600`. Because the script runs as `curl … | sh` (stdin is the pipe), the prompts read from `/dev/tty`; when no TTY is available it uses the defaults (detected clients, copy mode), skips the key prompt, and prints instructions for creating the config manually.
- Idempotent: re-running re-resolves the backend, updates the bootstrap skill in place, and keeps existing config (incl. `clients`/`link_mode`) unless the user re-enters values.

### Frontend

- **"Connect your agent" dialog** on the skills page: shows the one-liner pointing at the current instance's base URL — `curl -fsSL <baseUrl>/api/skills/install.sh | sh` (the frontend fills in its own origin) — plus a short explanation and a link to API-key management. Because the URL is baked in, the user never has to type the base URL when installing from the UI; the manual/agent path (no config yet) is where the skill prompts for it.
- **Per-skill install hint:** copy button on the skill detail panel producing the agent prompt, e.g. `Install the Exulu skill "<name>"`. Client selection and copy/symlink choice happen in the agent at install time (the bootstrap skill drives the multi-select), so the dialog only needs to mention that the agent will ask which clients to install into.

## Error handling

- Upload: unsupported extension → existing 400 path; `.skill` archives failing validation get the same errors as `.zip` (missing SKILL.md, size, entry count, unsafe paths).
- Folder upload: all validation errors surface in the dialog before any network call.
- Registry: 404 unknown name, 403 RBAC denial, 400 invalid version. Download of a version that has no files → 404 with explicit message.
- Publish: 400 on validation failure (missing SKILL.md, size/entry limits, name in path not matching a creatable/writable skill), 403 when the name exists but the caller lacks write access, 409 when the name exists but is owned by another user the caller cannot even see (avoids leaking existence: respond 409 "name unavailable"). Payload size enforced before buffering completes (request size limit on the route).
- Install script: fails loudly (set -e) with actionable messages; never leaves a partial skill folder (unpack to temp, then move).
- Client placement: symlink creation failure on a target (e.g. Windows without privilege) falls back to a copy for that target with a warning; an existing non-Exulu folder at a target path (no marker) is left untouched and reported, never overwritten.

## Testing

- **Backend unit tests:** upload-sign extension acceptance (`.skill` ok, others rejected); `format=skill` download produces wrapped zip with correct filename; registry list respects RBAC (visible vs. denied user); by-name lookup 404/403/version resolution; publish creates v1 for a new name, bumps version for an owned name, 403/409 for foreign names, 400 for invalid bundles; bootstrap endpoint serves the skill zip.
- **Frontend:** unit tests for folder collection → zip assembly (junk filtering, SKILL.md validation, limits) and frontmatter prefill parsing; `install.sh` route bakes in the correct base URL; `/api/config` returns `backend`; manual UAT for picker, drag-and-drop, and `.skill` upload with the real `skill-auditor.skill`.
- **URL resolution:** unit test for base-URL normalization (trailing slash, missing scheme) and backend extraction from `/api/config`; failure path when `backend` is absent.
- **Client targets & layout:** manifest covers every client dir in `test-skills/` (incl. the `.tabnine/agent/skills/` exception and `.agents/skills/`); detection pre-selects existing dirs and defaults to `.agents/skills/` when none exist; copy mode writes a marker per copy; symlink mode writes one canonical copy + valid symlinks and resolves symlinks before publish; symlink-failure falls back to copy.
- **End-to-end (manual):** run the one-liner locally, then in a Claude Code session: "installier mal skill-auditor" (choosing multiple clients + symlink mode) and "hol die aktuellste Version" against a local instance (verifying base URL → backend resolution and that all linked clients see the update).

## Out of scope

- Native Claude Code plugin marketplace (git-sync) — possible later stage, explicitly deferred.
- Public unauthenticated skill sharing.
