# Hermes Advanced Agent Mode — Design

**Date:** 2026-06-03
**Branch:** `feature/hermes-agent-integration`
**Status:** Approved design, pending implementation plan

## Summary

Add an optional **"advanced agent mode"** to Exulu Agents that routes a chat request
through the [Hermes Agent](https://hermes-agent.nousresearch.com) harness (Nous Research)
instead of the current Vercel AI SDK → litellm flow. The feature is fully backwards
compatible: it is a per-agent toggle, off by default, gated globally by the
`ENABLE_HERMES_AGENT` env var. When off, nothing about the existing flow changes.

Hermes provides a richer agent runtime (long-running tasks, tool-approval gating,
long-context compression, learning over time, its own skills/file/bash runtime). Exulu
contributes its capabilities to that runtime via MCP (tools) and synced skills, and
points Hermes at the existing litellm proxy for model calls.

## Goals

- Per-agent **advanced mode** toggle, backwards compatible, off by default.
- One isolated Hermes **profile per agent** (or per agent/user when private).
- Reuse Exulu's existing **auth, RBAC, rate limiting, session storage, statistics**.
- Keep the **frontend unchanged** — `chat.tsx` keeps consuming the same UIMessage stream.
- Keep **litellm as the single model gateway**; Hermes never calls providers directly.

## Non-goals

- Replacing the existing simple flow (it remains the default and is untouched).
- Running Hermes for non-advanced agents.
- Making Hermes' `state.db` the authority for history or access control.

## Key decisions (resolved during brainstorming)

| Decision | Choice | Rationale |
|---|---|---|
| Installation | **Official installer**, gated by `ENABLE_HERMES_AGENT` | Hermes is not confirmed pip-installable; docs only document the `curl \| bash` installer (binary at `~/.local/bin/hermes`, Python 3.11+). Use the supported path rather than force-fit the venv/requirements.txt pattern. |
| API surface | **Runs lifecycle** (`POST /v1/runs` + `/v1/runs/{id}/events` SSE) | Unlocks the agentic features that justify "advanced mode": long tasks, tool-approval gating, stop/interrupt, progress events. |
| Gateway lifecycle | **Lazy start + idle eviction** (bounded LRU pool) | Each profile is a separate process on its own port (no shared router exists). Lazy spawn + idle shutdown scales to many agents without running them all. |
| History source of truth | **Exulu `agent_messages`** (dual-write) | Preserves existing RBAC, search, statistics, exports. Hermes `state.db` is an implementation detail we map onto, never read for authorization. |
| Agent loop / file & bash / skills runtime | **Owned by Hermes** in advanced mode | Hermes has its own sandbox + skills runtime. Exulu contributes tools via MCP and skills via sync; the existing Exulu file sandbox is not used in this path. |
| Session RBAC | Enforced in Exulu via existing `agent_sessions` RBAC | Map Exulu session ↔ Hermes session; gate every access through `agent_sessions`. |

## Background — current flow (researched)

- Request: `chat.tsx` → `POST {slug}/:instance` in `src/exulu/routes.ts:562-939`.
- Streaming: `provider.generateStream()` (`src/exulu/provider.ts:802-1157`) assembles the
  system prompt, builds a file sandbox + tools, calls `streamText()` (Vercel AI SDK)
  against litellm, and returns a stream piped via
  `result.stream.pipeUIMessageStreamToResponse(res, ...)` (UIMessage SSE → `useChat`).
- litellm: supervised child process (`src/exulu/litellm/supervisor.ts`), OpenAI-compatible
  at `http://127.0.0.1:4000/v1`, auth `Bearer ${LITELLM_MASTER_KEY}`, gated by
  `EXULU_USE_LITELLM`. Python tooling installed via `ee/python/setup.sh` into a venv;
  venv python version detected dynamically (`src/exulu/litellm/db-init.ts:216-240`).
- Agents: `src/postgres/core-schema.ts:202-282` (`instructions`, `model`, `tools`,
  `skills`, `memory`, `rights_mode`, RBAC, rate limits, ...).
- RBAC: `checkRecordAccess` (`src/utils/check-record-access.ts`) over `rights_mode`
  (`private | users | roles | teams | public`).
- Sessions: `agent_sessions` (RBAC-enabled) + `agent_messages`; `saveChat()` /
  `getAgentMessages()` in `provider.ts`.
- Tools/skills: `getEnabledTools` (`src/utils/enabled-tools.ts`),
  `getEnabledSkills`; skills stored on S3, downloaded to a session sandbox via
  `downloadSkill` (`ee/invoke-skills/create-sandbox.ts:163-208`).

## Background — Hermes facts that shaped the design (researched)

- **Profiles** = isolated home dir selected by `HERMES_HOME` (`~/.hermes/profiles/<name>/`),
  each with its own `config.yaml`, `.env`, `SOUL.md`, `state.db`, skills, gateway.
- **Multi-profile = N processes**, one port each (`API_SERVER_PORT` per profile's `.env`).
  No built-in path/header routing between profiles — Exulu routes to ports itself.
- **API server** config via `.env` (`API_SERVER_ENABLED`, `API_SERVER_HOST`,
  `API_SERVER_PORT`, `API_SERVER_KEY`), default `127.0.0.1:8642`, `Bearer` auth.
- **Runs lifecycle**: `POST /v1/runs` → `run_id`; `GET /v1/runs/{id}/events` (SSE);
  `POST /v1/runs/{id}/approval`; `POST /v1/runs/{id}/stop`. `X-Hermes-Session-Id` carries
  our external session identity.
- **Model block** (point at litellm): `model.provider: custom`, `base_url`, `api_key`;
  model name key is **`model.default`** (not `model.model`). When `base_url` is set Hermes
  calls it directly with `api_key`.
- **MCP**: `mcp_servers.<name>.url` + `headers` supports HTTP MCP. Tools namespaced
  `mcp_<server>_<tool>`; per-server `tools.include`/`exclude`.
- **Skills**: `skills.external_dirs` (supports `~` and `${VAR}`). On-disk skill = a folder
  with a required `SKILL.md` (YAML frontmatter: `name`, `description`, `version`, ...).
- **SOUL.md**: slot #1 of the system prompt, at `$HERMES_HOME/SOUL.md`, loaded only from
  `HERMES_HOME`, **never overwritten by Hermes if it exists** → Exulu owns writing it.
- **Sessions**: SQLite `state.db` per profile, string IDs (`sess_...`); no built-in
  external-ID mapping → we map ourselves.

> One unknown to pin in Phase 0: exact run **event names** on the SSE stream. The adapter
> is the single component coupled to Hermes' wire format, by design.

## Architecture

Advanced mode is a **second execution path** behind the existing route. A single branch —
`if (agent.advanced_mode && isHermesEnabled())` — diverts from `provider.generateStream()`
to the Hermes path. Auth, RBAC, rate-limit pre-check, session resolution, message
persistence, and statistics remain shared. The frontend is unchanged because the new path
adapts Hermes' run-event SSE back into the same UIMessage stream `useChat` consumes.

```
chat.tsx ──POST /:instance (stream)──► routes.ts
                                          │
                          advanced_mode? ─┴─────────────┐
                              no                        yes
                               │                         │
                    provider.generateStream      hermes/run-stream.ts
                    (AI SDK → litellm)                    │
                                              ┌───────────┼─────────────┐
                                         provision    POST /v1/runs   adapt SSE
                                         profile      + SSE events  ►  UIMessage
                                              │                         stream
                                    hermes gateway (profile, port N)
                                              │  model→litellm:4000   tools→MCP
                                              ▼
                                   litellm proxy   +   /mcp/<agent_id> (ExuluTools)
```

### Components (each isolated, single-purpose)

1. **Hermes supervisor & process pool** — `src/exulu/hermes/supervisor.ts`
   Models the litellm supervisor. Lazy-spawns a profile's `hermes gateway`, supervises
   health/respawn, allocates a port from a pool, evicts after idle timeout (bounded LRU).
   Interface: `ensureGateway(profileId) → baseUrl`. Knows nothing about agents.

2. **Profile provisioner** — `src/exulu/hermes/provisioner.ts`
   Given an agent (+ optional user), materializes `HERMES_HOME/profiles/<id>/`: writes
   `config.yaml` (model→litellm, MCP url, skills dir), `.env` (`API_SERVER_*`, port, key),
   seeds/overwrites `SOUL.md` from agent `instructions`, syncs enabled skills. Idempotent,
   hash-gated. Pure filesystem/config; no process or HTTP concerns.
   Interface: `ensure(profileId, agent, user) → void`.

3. **Install / runtime setup** — `ee/python/setup.sh` addition, gated `ENABLE_HERMES_AGENT`
   Installs Hermes via the official installer; validated at boot like docling/litellm.

4. **ExuluTools MCP server** — `src/exulu/hermes/mcp/`, mounted at `/mcp/:agentId`
   HTTP MCP endpoint exposing the agent's *enabled* ExuluTools (context search, web search,
   custom tools) by wrapping `ExuluTool.execute`. Reuses `getEnabledTools`. The bridge that
   lets Hermes call Exulu capabilities.

5. **Run-stream adapter** — `src/exulu/hermes/run-stream.ts`
   Calls `POST /v1/runs`, subscribes to `/v1/runs/{id}/events`, translates Hermes events →
   UIMessage stream parts so `pipeUIMessageStreamToResponse`/`useChat` work unchanged. Maps
   Exulu `session_id` ↔ Hermes session via `X-Hermes-Session-Id`. The only component
   coupled to Hermes' wire format.

6. **Session/run mapping + RBAC** — `hermes_session_id` column on `agent_sessions`
   Keeps `agent_messages` as the source of truth (dual-write). Access gated by existing
   `agent_sessions` RBAC; Hermes `state.db` is never the authority for who-can-see-what.

## Data flow

### Provisioning (lazy, content-hashed)

On an advanced-mode request, the provisioner hashes the inputs that affect the profile —
`instructions` (→SOUL.md), enabled `skills`, enabled `tools` (→MCP set), `model`, and
profile scope. If `HERMES_HOME/profiles/<id>/.exulu-hash` matches, skip; otherwise
(re)write `config.yaml`, `.env`, `SOUL.md`, re-sync skills, and bump the hash. SOUL.md is
overwritten by us (Hermes won't), so instruction edits propagate. Skills sync reuses the
existing S3→disk download into `/agents/skills/<profileId>/`, transforming each folder to
present the `SKILL.md` Hermes expects.

### Request (advanced mode, streaming)

```
1. routes.ts: auth, RBAC, rate-limit pre-check, resolve session     ← shared, unchanged
2. branch: agent.advanced_mode && isHermesEnabled()
3. profileId = scope==='shared' ? agent.id : `${agent.id}/${user.id}`
4. provisioner.ensure(profileId, agent, user)         // hash-gated write
5. baseUrl = supervisor.ensureGateway(profileId)      // lazy spawn + port + health; touch LRU
6. hermesSessionId = resolve from agent_sessions.hermes_session_id (create-or-load)
7. run-stream: POST /v1/runs (messages, X-Hermes-Session-Id, Bearer key)
8. subscribe GET /v1/runs/{run_id}/events (SSE) → translate → UIMessage stream
9. pipeUIMessageStreamToResponse(res, ...)            // same as today
10. onFinish: saveChat() to agent_messages (dual-write), statistics, token usage  ← shared
```

Tool calls flow **Hermes → `/mcp/<agentId>` → `ExuluTool.execute` → Hermes**. A Hermes
`approval.request` maps to a UIMessage tool-approval part the frontend already understands;
approve/deny posts to `/v1/runs/{id}/approval`. Stop maps to `POST /v1/runs/{id}/stop`.

### Event → UIMessage mapping (adapter core)

| Hermes run event | UIMessage stream part |
|---|---|
| message/text delta | text-delta |
| reasoning chunk | reasoning part |
| tool start | tool-call (input) part |
| tool complete | tool-result part |
| approval request | tool-approval-request part |
| run finished | finish + token/usage metadata |
| error | error part |

(Exact event names pinned in Phase 0/1 against the live API.)

## Data model changes

**`agents` table (`core-schema.ts`) — two new columns:**
- `advanced_mode` (boolean, default `false`) — the `form.tsx` toggle.
- `advanced_agent_profile_scope` (text: `'shared' | 'private'`, default `'shared'`) —
  shared = one profile for all users of the agent; private = one profile per agent/user.
  **Distinct from RBAC `rights_mode`** (which still controls *who can access* the agent);
  this only controls *profile sharing*.

**`agent_sessions` table — one new column:**
- `hermes_session_id` (text, nullable) — set when a session runs in advanced mode. RBAC is
  the table's existing access control; no separate mapping table. Profile id stays derived
  (`agent.id` or `agent.id/user.id`), not stored.

**New env vars:**
- `ENABLE_HERMES_AGENT` — gates install + the entire path.
- `HERMES_HOME` — profiles root (default `~/.hermes`).
- `HERMES_PORT_RANGE` — gateway port pool (e.g. `8642-8700`).
- `HERMES_IDLE_TIMEOUT_MS` — idle eviction threshold.
- `HERMES_MAX_GATEWAYS` — LRU cap.
- Per-profile `API_SERVER_KEY` is generated by the provisioner (not a global env var).

**Frontend:** `form.tsx` gains the two toggles (shown when `ENABLE_HERMES_AGENT`).
`chat.tsx` is unchanged.

## Phasing

Each phase is independently shippable behind `ENABLE_HERMES_AGENT` (off by default), so
`main` is never destabilized.

- **Phase 0 — Spike & install.** Add the installer to `setup.sh` gated by
  `ENABLE_HERMES_AGENT`; validate at boot. Manually create one profile pointed at litellm,
  start one `hermes gateway`, curl `POST /v1/runs` + events SSE. **Pin the real event
  names and wire format.** Output: findings note + known-good `config.yaml`/`.env` template.

- **Phase 1 — Supervisor + provisioner.** `supervisor.ts` (lazy spawn, port pool,
  health/respawn, idle LRU eviction) and `provisioner.ts` (hash-gated config/`.env`/SOUL
  write; skills/MCP stubbed). Tests spawn a real gateway and assert a round-trip.

- **Phase 2 — Run-stream adapter + route branch (end-to-end chat).** The `advanced_mode`
  branch in `routes.ts`, `run-stream.ts` translating events → UIMessage stream, session
  mapping via `hermes_session_id`, dual-write to `agent_messages`. **Milestone: a real
  advanced-mode conversation streams in `chat.tsx`, no tools yet.**

- **Phase 3 — ExuluTools over MCP.** `/mcp/:agentId` server wrapping `getEnabledTools` →
  `ExuluTool.execute`; provisioner writes `mcp_servers.url`. Includes approval/stop mapping.

- **Phase 4 — Skills sync.** S3→`/agents/skills/<profileId>/` with `SKILL.md` transform;
  provisioner adds `skills.external_dirs`. Confirms Exulu skill format vs Hermes.

- **Phase 5 — Frontend toggles + profile scope.** `form.tsx` toggles; private scope creates
  per-user profiles. Polish: eviction tuning, error surfacing, docs.

## Cross-cutting concerns (spec-wide checklist, not phases)

- **Graceful degradation:** Hermes unavailable → clear, surfaced error; consider optional
  fallback to simple mode.
- **Port exhaustion:** pool full → evict LRU or queue; never crash the request.
- **Secret handling:** per-profile `API_SERVER_KEY` generated; litellm master key never
  written to a world-readable file; profile dirs locked down.
- **Cleanup:** deleting an agent tears down its profile dir + gateway; private-scope
  profiles cleaned when the user loses access.
- **Concurrency:** provisioning and gateway spawn are guarded against duplicate concurrent
  requests for the same profile (single-flight).

## Open questions / to confirm during implementation

- Exact Hermes run **event names** and payload shapes (Phase 0).
- Whether Exulu's on-disk skill format already satisfies Hermes' `SKILL.md` frontmatter or
  needs a transform (Phase 4).
- Whether to offer a **fallback to simple mode** on Hermes failure, or hard-fail (Phase 2).

---

## Revision 2026-06-04 — verified wire format, sandboxing, new phases

Live-gateway testing pinned the wire format and surfaced a security model change.

**Verified facts (supersede earlier guesses):**
- `POST /v1/runs` uses the OpenAI **Responses** shape: `{ input: string, session_id }`
  (model is server-side via config.yaml), returns `{ run_id, status }`.
- `/v1/runs/{id}/events` streams **Hermes-native** SSE: no `event:` line (type in
  `data.event`), tool name in `data.tool`, **no call id**, **no structured args** (only a
  `preview` string), and `tool.completed` carries **no result** (just `duration` + `error`).
  Confirmed events: `tool.started`, `tool.completed`, `message.delta`, `reasoning.available`,
  `run.completed` (with `usage: { input_tokens, output_tokens, total_tokens }`).
- The adapter's `normalizeEvent`/`translateEvent` were rewritten to this; tool ids are
  synthesized and `started`/`completed` paired via a LIFO stack.
- **Token usage is per-run and accurate** (e.g. 957k for a deep tool-using turn, 77k for a
  lighter one). It is high because Hermes re-injects growing context (incl. large tool
  outputs) across many internal LLM calls. Not a display bug — surfaced via
  `messageMetadata.totalTokens`.

**Security finding:** Hermes' built-in `terminal`/`search_files`/`read_file` tools execute
on the **host** with the backend's privileges (observed running `ls`/`find`/file reads
across the user's home dir). Unacceptable for shared/`public` agents. Mitigations adopted:
- `approvals.mode: smart` in every profile (auto-approve low-risk, prompt on destructive) —
  overridable via `HERMES_APPROVALS_MODE`. **Requires** the approval round-trip (below).
- `terminal: { backend: local, cwd: <profileDir>/workspace }` — an **absolute** per-profile
  workspace, keeping the agent out of Hermes' own config/state. (`cwd: "."` would mean the
  launch dir, not the profile dir.)
- **Per-gateway OS-user isolation** (new phase): run each `hermes gateway` as a dedicated
  unprivileged user whose HOME is the profile dir, so even shell tools can't reach the rest
  of the host.

**Revised / added phases:**
- **Phase 3 — ExuluTools over MCP** (unchanged intent): `/mcp/:agentId`, provisioner writes
  `mcp_servers.url`.
- **Phase 3b — Approval round-trip:** track active runs (run id + gateway) so a Hermes
  `approval.request` event → frontend `ToolCallApproval` → backend `POST /v1/runs/{id}/approval`
  / `/stop`. Needed for `approvals.mode: smart` not to hang on destructive actions.
- **Phase 4 — Skills sync** (unchanged).
- **Phase 6 — Auto-generated skills surfacing:** Hermes auto-distills past conversations into
  skills under `${profileDir}/skills/`. Expose them in `chat.tsx` (sidebar) with
  review/edit/delete — backend endpoints to list/read/update/delete skill files in the
  profile, gated by the agent's existing RBAC.
- **Phase 7 — OS-user isolation:** supervisor spawns the gateway under a per-profile
  unprivileged user (uid/gid + HOME=profileDir). Platform-specific; Linux-first.

**Done in this revision:** `approvals.mode` + `terminal.cwd`/workspace are written by the
provisioner (config format v2).
