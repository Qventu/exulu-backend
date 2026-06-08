# Hermes Agent profiles (advanced agent mode)

This directory documents the per-profile files Exulu generates for the
[Hermes Agent](https://hermes-agent.nousresearch.com) harness when an Exulu
agent has **advanced mode** enabled. You do **not** edit anything here — Exulu's
provisioner writes the real files at runtime under `${HERMES_HOME}/profiles/<id>/`.

## How it fits together

- One Hermes **profile** per Exulu agent (`<agentId>`), or per agent/user
  (`<agentId>/<userId>`) when the agent's
  `advanced_agent_profile_scope` is `private`.
- Each in-use profile runs its own `hermes gateway` process on its own port,
  supervised by `src/exulu/hermes/supervisor.ts` (lazy start + idle eviction).
- Every model call still flows through the LiteLLM proxy — Hermes' `model`
  block points `base_url` at LiteLLM.

## Enabling

1. `ENABLE_HERMES_AGENT=true` (gates install + the whole code path).
2. Run `npm run python:setup` — installs the `hermes` binary when the flag is on.
3. Toggle **advanced mode** on an individual agent in the agent form.

## Env vars

| Var | Default | Purpose |
| --- | --- | --- |
| `ENABLE_HERMES_AGENT` | (unset) | Global gate for advanced mode. |
| `HERMES_HOME` | `~/.hermes` | Root for profile directories. |
| `HERMES_BIN` | (auto) | Override path to the `hermes` binary. |
| `HERMES_PORT_RANGE` | `8642-8700` | Gateway port pool. |
| `HERMES_MAX_GATEWAYS` | `20` | LRU cap on concurrent gateways. |
| `HERMES_IDLE_TIMEOUT_MS` | `900000` | Idle eviction threshold (15 min). |
| `HERMES_APPROVALS_MODE` | `smart` | Tool-approval policy written to config.yaml. |
| `HERMES_TERMINAL_BACKEND` | `docker` | Backend that runs native shell/file tools (`docker` isolates without host user namespaces; `local`/`ssh`/`modal`/`daytona`/`singularity` also selectable). Docker must be available to the host process. |
| `HERMES_DOCKER_IMAGE` | `nikolaik/python-nodejs:python3.11-nodejs20` | Image for the docker backend (needs python + node). |
| `BACKEND` | `http://127.0.0.1:<PORT>` | URL a gateway uses to reach Exulu's `/mcp/:agentId` (set this if the host app's port isn't `PORT`/`EXULU_PORT`). |
| `EXULU_MCP_KEY` | `LITELLM_MASTER_KEY` | Bearer token guarding the ExuluTools MCP endpoint. |

ExuluTools reach the agent over HTTP MCP at `/mcp/<agentId>` and **add to** Hermes'
native tools (bash, filesystem, …) rather than replacing them.

See `config.yaml.example`, `.env.example`, and `SOUL.md.example` in this folder
for the shape of the generated files.
