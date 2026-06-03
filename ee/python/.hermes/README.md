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

See `config.yaml.example`, `.env.example`, and `SOUL.md.example` in this folder
for the shape of the generated files.
