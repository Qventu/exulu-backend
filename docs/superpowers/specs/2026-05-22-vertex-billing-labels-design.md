# Vertex Billing Labels via Custom Fetch — Design

**Date:** 2026-05-22
**Status:** Approved (pending user review of this doc)

## Goal

Attach Google Cloud billing labels to every Vertex `generateContent` request so that GCP cost reports can attribute spend per provider, user, role, and project. Labels are injected by mutating the JSON request body inside a custom `fetch` passed to `createVertex`.

Reference: https://docs.cloud.google.com/vertex-ai/generative-ai/docs/multimodal/add-labels-to-api-calls

## Label rules (from Google)

- Up to 64 labels per call.
- Each label is a key-value pair.
- Key length: 1–63 chars. Cannot be empty.
- Value length: 0–63 chars. May be empty.
- Charset: lowercase letters, digits, `_`, `-`. UTF-8; international chars allowed.
- Keys must start with a lowercase letter or international character.
- Keys must be unique within a single call.

## Scope

In scope:
- All four Vertex providers in `src/templates/providers/google/vertex/index.ts`: `gemini-2.0-flash`, `gemini-2.5-flash`, `gemini-2.5-pro`, `gemini-3-pro-preview`.
- Both runtime call sites for `model.create()` (`src/exulu/provider.ts:364` sync, `src/exulu/provider.ts:891` streaming) and the OpenAI-compatible gateway (`src/exulu/openai-gateway.ts:350`).

Out of scope:
- Anthropic-on-Vertex and other Vertex variants not in `vertex/index.ts`.
- Gemini direct (non-Vertex) provider — different billing model, no `labels` body field.
- Per-agent custom label overrides — easy to add later by extending the `create()` param shape.

## Architecture

### New file: `src/templates/providers/google/vertex/labels.ts`

Exports:

```ts
export function sanitizeLabelKey(raw: string): string;
export function sanitizeLabelValue(raw: string | number | undefined): string | undefined;

export function buildLabels(input: {
  providerId: string;
  providerName: string;
  user?: number;
  role?: string;
  project?: string;
  agent?: string;
}): Record<string, string>;

export function createLabeledFetch(
  labels: Record<string, string>,
): FetchFunction;
```

`FetchFunction` is the type re-exported by `@ai-sdk/provider-utils` and accepted by `createVertex({ fetch })`.

### Sanitization rules

Applied to both keys and values (they share Google's charset rules):

1. NFKC normalize, lowercase.
2. Replace any char outside `[a-z0-9_-]` with `-`.
3. **Keys only:** if the first char isn't `[a-z]`, prefix with `k_`.
4. Truncate to 63 chars.
5. `buildLabels` drops entries whose value sanitizes to an empty string (noise reduction).
6. Defensive cap at 64 entries; we only emit 6, so this is a guard.

Periods in `provider_name` (e.g. `gemini-2.5-flash`) become `-` → `gemini-2-5-flash`. Acceptable.

### Label set produced by `buildLabels`

| Key            | Source                          | Notes                                                                  |
| -------------- | ------------------------------- | ---------------------------------------------------------------------- |
| `provider_id`  | `ExuluProvider.id` (closure)    | always present, e.g. `default_vertex_gemini_2_5_flash_provider`        |
| `provider_name`| `ExuluProvider.name` (closure)  | always present, sanitized                                              |
| `user_id`      | `user` arg                      | omitted if undefined                                                   |
| `role_id`      | `role` arg                      | omitted if undefined                                                   |
| `project_id`   | `project` arg                   | omitted if undefined                                                   |
| `agent_id`     | `agent` arg                     | runtime agent instance id; omitted if undefined                        |

### Fetch wrapper behavior — `createLabeledFetch(labels)`

Returned function has signature `(input, init) => Promise<Response>`.

1. If `init?.body` is missing or method is not POST → forward unchanged.
2. Decode body to string:
   - `string` → as-is
   - `Uint8Array` / `Buffer` → `new TextDecoder().decode(body)`
   - anything else (`ReadableStream`, `FormData`, …) → forward unchanged with a one-time `console.warn`. Vertex generateContent uses JSON, so this shouldn't fire in practice.
3. `JSON.parse` in try/catch. On failure: forward unchanged + `console.warn`.
4. Merge: `parsed.labels = { ...parsed.labels, ...labels }`. Caller-supplied labels win — defensive against future paths that pre-populate labels.
5. `JSON.stringify(parsed)`.
6. Build new `init`: replace `body`, remove any existing `Content-Length` header (let the runtime recompute), preserve all other headers.
7. Forward to `globalThis.fetch(input, newInit)`.

**Invariant:** any failure in steps 2–6 falls back to forwarding the original request unmodified. Labels are best-effort; a billing label must never break a model call.

## Changes to `vertex/index.ts`

Each of the four `createVertex(googleAuthPayload)` calls becomes:

```ts
const labels = buildLabels({
  providerId: "default_vertex_gemini_2_5_flash_provider", // matches the outer id
  providerName: "GEMINI-2.5-FLASH",
  user, role, project, agent,
});

const vertex = createVertex({
  ...googleAuthPayload,
  fetch: createLabeledFetch(labels),
});
```

The `create` arrow function lexically captures the outer `id`/`name` literals — no `this` plumbing needed.

The auth payload's existing top-level keys (`project`, `location`, `googleAuthOptions`) must continue to be spread into `createVertex` — wrapping them inside a `googleAuthOptions` key would break Vertex auth.

## Context plumbing — three call sites

The WIP `types/provider-config.ts:7` declares:

```ts
create: ({ apiKey, user, role, project, agent }: {
  apiKey?: string; user?: number; role?: string; project?: string; agent?: string;
}) => LanguageModel;
```

Today, callers only pass `apiKey`. Updates:

### `src/exulu/provider.ts:364` (sync `generate`)
```ts
const model = this.model.create({
  ...(providerapikey ? { apiKey: providerapikey } : {}),
  user: user?.id,
  role: user?.role?.id,
  project, // resolve project from session BEFORE this call (small reorder of existing code)
  agent: agent?.id,
});
```

### `src/exulu/provider.ts:891` (streaming)
Same shape. Same small reorder so `project` is known before `create()`.

### `src/exulu/openai-gateway.ts:350`
```ts
const languageModel = provider.config.model.create({
  apiKey: providerapikey,
  user: user.id,
  role: user.role?.id,
  project: project?.id,
  agent: agent?.id,
});
```

If `user.id` / `agent.id` / `project.id` are numeric in scope, coerce with `String(...)` to match the `string` types in the signature.

## Testing

One unit test file: `src/templates/providers/google/vertex/labels.test.ts`.

- `sanitizeLabelKey`: invalid-char replacement, truncation at 63, leading-non-letter prefix, empty-input handling.
- `sanitizeLabelValue`: same, plus `undefined`/`number` handling.
- `buildLabels`: drops undefineds, includes all dimensions when present, output is sanitized.
- `createLabeledFetch`:
  - Given a stub fetch, JSON body in → JSON body out with `labels` merged; `Content-Length` dropped; other headers preserved.
  - Pre-existing `labels` field merged with caller-supplied taking precedence.
  - Non-JSON body → forwarded unmodified.
  - Body as `Uint8Array` → decoded, mutated, forwarded.

No integration test against real Vertex. Manual verification: invoke each of the four providers from a dev agent and check Cloud Billing reports for label propagation (≥24h lag).

## Risks & mitigations

| Risk                                                                  | Mitigation                                                                                            |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Body mutation breaks a request due to encoding edge case              | All decode/parse paths wrapped in try/catch; fall back to forwarding the original `init` unmodified.  |
| AI SDK changes its body type (e.g. switches to `ReadableStream`)      | Wrapper detects unknown body types and forwards unchanged + warns. Caught at the next SDK upgrade.    |
| User/project IDs contain PII surfaced to GCP billing                  | Only numeric IDs are sent — no emails, names, or other PII. Sanitization further strips anything odd. |
| Label cardinality explosion (per-user) inflates billing report size   | GCP allows up to 64 labels/call; cardinality across calls is fine for billing reports.                |

## Migration / rollout

Single PR. No data migration. The change is observable only in GCP Cloud Billing reports after ~24h. Reversible by removing the `fetch` option from `createVertex(...)` calls.
