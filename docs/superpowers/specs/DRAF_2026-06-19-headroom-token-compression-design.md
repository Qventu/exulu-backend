# Optional Headroom token compression for LiteLLM

**Date:** 2026-06-19
**Status:** Approved — ready for implementation plan

## Problem

Exulu spawns and supervises a local LiteLLM proxy when `EXULU_USE_LITELLM=true`
(see `src/exulu/litellm/supervisor.ts` and
`docs/superpowers/specs/2026-05-23-litellm-proxy-integration-design.md`). We want
to optionally reduce token usage by routing all proxied LLM calls through
[Headroom](https://headroom-docs.vercel.app/docs/litellm), which compresses
conversation context in a LiteLLM pre-call hook before requests reach the
provider.

Headroom integrates with a LiteLLM **proxy** deployment by:

1. Installing the `headroom-ai` pip package into the same environment as LiteLLM.
2. Adding its callback class to `litellm_settings.callbacks` in the proxy config:

   ```yaml
   litellm_settings:
     callbacks: ["headroom.integrations.litellm_callback.HeadroomCallback"]
   ```

The complication: the proxy config (`config.litellm.yaml`, by default in the
consumer's CWD) is **operator-supplied** — the package reads it but does not
generate it. So enabling the callback "via an env var" requires injecting it at
spawn time without mutating the operator's file.

## Goals

- A single env var, `ENABLE_TOKEN_COMPRESSION=true`, enables Headroom compression
  on the spawned LiteLLM proxy. Only meaningful when `EXULU_USE_LITELLM=true`.
- When the flag is off or unset, behavior is byte-for-byte unchanged.
- The operator's `config.litellm.yaml` is never modified.
- Enabling/disabling is automatic — the operator does not edit their config.

## Non-goals

- Headroom's manual `compress()` API or ASGI-middleware integration modes.
- Per-model or per-request compression tuning. (Headroom's defaults only.)
- A live-proxy integration test of compression behavior.

## Design

### 1. Feature flag

A helper alongside the existing `isLiteLLMEnabled()` in `supervisor.ts`:

```ts
export const isTokenCompressionEnabled = (): boolean =>
  process.env.ENABLE_TOKEN_COMPRESSION === "true";
```

It is only consulted inside the LiteLLM boot path, so it is implicitly a no-op
when LiteLLM mode is off.

### 2. Pip dependency

Add `headroom-ai` to `ee/python/requirements.txt`, installed unconditionally,
mirroring the existing `litellm[proxy]` note ("only used when
`EXULU_USE_LITELLM=true` ... always installed so the dep is ready when the env
var is flipped"). Pin to a tested version. During implementation, confirm the
pinned `headroom-ai` version is compatible with `litellm[proxy]==1.85.1` and
that the callback import path is exactly
`headroom.integrations.litellm_callback.HeadroomCallback` — verify against the
installed package, not the docs.

### 3. Config merge (core)

New module `src/exulu/litellm/headroom-config.ts` with a pure, unit-testable
core:

```ts
export const HEADROOM_CALLBACK =
  "headroom.integrations.litellm_callback.HeadroomCallback";

/**
 * Returns the operator's LiteLLM YAML with the Headroom callback ensured in
 * litellm_settings.callbacks. Idempotent. Pure — no IO.
 */
export function mergeHeadroomCallback(yamlText: string): string;
```

Behavior of `mergeHeadroomCallback`:

- Parse `yamlText` with the `yaml` package.
- Ensure a `litellm_settings` mapping exists.
- Normalize `litellm_settings.callbacks` to a list:
  - missing → `[]`
  - a single string → `[string]`
  - already a list → unchanged
- Append `HEADROOM_CALLBACK` only if not already present (idempotent).
- Re-serialize and return. `os.environ/...` values are ordinary YAML strings and
  round-trip unchanged.

### 4. Wiring into the supervisor

In `startLiteLLMSupervisor`, **after** the existing `existsSync(configPath)`
check and **only when** `isTokenCompressionEnabled()`:

1. Read the operator config at `cfg.configPath`.
2. Run `mergeHeadroomCallback`.
3. Write the result to a stable temp path,
   `resolve(os.tmpdir(), "exulu-litellm.merged.yaml")`.
4. Override `cfg.configPath` to the temp path before the supervise loop starts.

Because `cfg` is captured once and reused for every (re)spawn, all respawns use
the merged file. The merge runs once per boot, which is sufficient — respawns are
crash-recovery, not config reloads.

The `yaml` package is declared as a direct dependency (already present
transitively in `node_modules`, so no new install) so the import is not relying
on a transitive package.

### 5. Error handling

Compression is an optional enhancement, so the merge is **best-effort**:

- If reading, parsing, or writing fails, log a clear `[EXULU-LITELLM]` warning
  (including the underlying error) and leave `cfg.configPath` pointing at the
  original operator config.
- LiteLLM startup is never blocked by a compression-config failure — the proxy
  still comes up, just without compression.

### 6. Testing

Unit tests for `mergeHeadroomCallback` (no live proxy):

- empty / minimal config (no `litellm_settings`)
- `litellm_settings` present but no `callbacks`
- `callbacks` as a single string
- `callbacks` as an existing list (Headroom appended)
- Headroom already present (idempotent — no duplicate)
- `os.environ/...` values preserved through the round-trip

## Files touched

- `ee/python/requirements.txt` — add `headroom-ai` pin.
- `src/exulu/litellm/supervisor.ts` — `isTokenCompressionEnabled()` + merge wiring
  in `startLiteLLMSupervisor`.
- `src/exulu/litellm/headroom-config.ts` — new pure merge module.
- `src/exulu/litellm/headroom-config.test.ts` — new unit tests.
- `package.json` — declare `yaml` as a direct dependency.
- Operator-facing docs / `config.yaml.example` comment — note the new env var.
