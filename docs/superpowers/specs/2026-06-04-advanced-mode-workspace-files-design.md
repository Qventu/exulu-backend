# Advanced Mode — Shared Workspace & File Visibility

**Date:** 2026-06-04
**Branch:** `feature/hermes-agent-integration`
**Status:** Design + decision record (no per-session isolation; build the file UX)
**Parent spec:** `2026-06-03-hermes-agent-mode-design.md`

## Decision (filesystem scoping)

The advanced-mode filesystem is scoped to the **profile**, not the session, and
**this is intentional.** The admin chooses the profile scope per agent via
`advanced_agent_profile_scope`:

- **shared** — one profile (→ one gateway → one Docker container → one workspace)
  for **all users** of the agent.
- **private** — one profile per **user** (one container per user).

In both cases, **all sessions on a profile share the same container filesystem.**

### Why not per-session isolation

A hard per-session filesystem boundary is **not achievable within Hermes' model
without a container per session**: Hermes runs the native shell/file tools inside
its **one persistent container per profile**, as its own user, and we don't wrap
those calls (only our MCP tools run in our process). So we can't inject a per-
session user/`chroot`. The only kernel boundary Hermes exposes is the container,
which is per-profile. A container-per-session would give hard isolation but costs
a container + cold start per session — rejected as too heavy. So the boundary is
the admin's scope choice (shared vs private), and within a profile, sessions
share files **by design**.

### Why sharing is a feature

A shared workspace means **later sessions can build on files earlier sessions
created** — the agent's work accumulates and stays available across conversations
(decks, reports, datasets, scratch files). That continuity is valuable; we lean
into it rather than fight it.

## The thing we must build: file visibility & management

The risk of a shared, persistent workspace is that it's **invisible**: files
accumulate in a container the user never sees, shared across their sessions (and,
for shared-scope agents, across other users). Users need to **see, download, and
delete** those files, and understand the sharing scope. Without that UX, the
shared workspace is confusing and unmanageable.

### Backend — workspace file API (RBAC-gated)

Mirror the existing Hermes skills API (`/agents/:agentId/hermes-skills`):

- `GET    /agents/:agentId/workspace-files` — list files in the profile workspace
  (name, relative path, size, mtime), bounded (depth/count caps, skip dotfiles).
- `GET    /agents/:agentId/workspace-files/<path>` — download one file
  (stream, or upload to S3 and redirect to a presigned URL for large files).
- `DELETE /agents/:agentId/workspace-files/<path>` — delete a file.

The profile is derived from the agent + scope + authenticated user (same as the
skills API). Access gated by the agent's existing RBAC. Path-traversal-safe.
Reads come straight from the **host** bind-mounted workspace dir
(`${profileDir}/workspace`) — no container access needed, since the mount mirrors
the container filesystem.

### Frontend — a "Files" panel

A slide-over (like the skills sheet), triggered from the chat, that lists
workspace files with download + delete. Crucially, it states the **scope** so the
behavior is obvious:

- shared scope: *"These files are shared across everyone who uses this agent."*
- private scope: *"These files are shared across all your sessions with this
  agent."*

This makes "files persist and are shared" explicit and manageable, and doubles as
the **retrieval** mechanism (download what the agent created).

### Capture — nothing extra needed

Because the workspace is a host bind-mount, files the agent writes **into the
workspace** already appear on the host and in the browser automatically. (The
agent currently tends to write to its container home `/root` instead; nudging it
toward the workspace `cwd` via SOUL.md guidance is a soft, optional improvement —
NOT an isolation mechanism, just a default-location hint.) Files outside the
mounted workspace remain ephemeral and out of scope.

## Scaling & hygiene

- **Bounded listing:** depth + count caps; skip the read-only skills mount and
  dotfiles; `log()` anything truncated (no silent omission).
- **Cleanup:** sweeper prunes workspace files older than N days (host disk);
  deleting an agent already tears down its profile dir; for shared scope, growth
  is one workspace per agent (not per user/session), which is naturally bounded.
- **Large files:** stream downloads or hand off to S3 + presigned URL above a
  size threshold rather than buffering.

## Phasing

1. **Workspace file API** (backend): list / download / delete, RBAC-gated.
2. **Files panel** (frontend): slide-over with scope messaging, download, delete.
3. **Hygiene**: caps, TTL sweeper, optional S3 hand-off for large downloads.
4. *(Optional)* SOUL.md hint nudging the agent to use the workspace `cwd` as its
   default output location (a convenience, not a boundary).

## Decision record

- Per-session filesystem isolation: **rejected** (not feasible without container-
  per-session; too heavy). Scope is the admin's shared/private choice.
- Shared-across-sessions persistence: **kept as a feature**.
- Required follow-up: **file visibility/management UX** so the shared workspace is
  transparent and controllable.
