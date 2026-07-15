# Agent Knowledge-Base Write Tools — Design

**Date:** 2026-07-15
**Status:** Approved
**Repos:** exulu/backend (core), exulu/frontend (agent editor)

## Summary

Let Exulu agents create and update items in knowledge bases (ExuluContexts) during chat, via dynamically-injected per-context tool pairs (`create_<ctx>_item`, `update_<ctx>_item`). Which contexts an agent may write to — and whether it may create, update, or both per context — is configured per agent instance in the agent editor's Knowledge section. Writes are gated twice: the agent's config must allow the context, and the invoking user must have row-level write access. Every write requires chat approval by default, with a per-agent skip toggle.

## Decisions (all confirmed with Daniel)

| Decision | Choice | Why |
|---|---|---|
| Tool shape | One create + one update tool **per writable context** (memory-tool pattern) | Exact zod schemas from `context.fields` give the model precise field names/types/enums; a non-writable context's tools simply don't exist. Cost: 2 tools per writable context. |
| Permissions | **Agent config AND invoking user's row-level rights** | Agent config grants capability; `checkRecordAccess(record, 'write', user)` still governs updates to existing rows. An agent never lets a user do more than the UI would. |
| Config storage | **`knowledge_base_editor` tool entry in `agents.tools` JSON** (Approach A) | Follows the `agentic_context_search` precedent. No schema/GraphQL changes; `tools` already round-trips through the editor; approval/disable machinery works on tool entries. |
| UI placement | **Knowledge section** of the agent editor | Contexts stay in one mental model: "what this agent knows & may change". Retrieval config already lives there, not in Tools. |
| Approval | **`needsApproval: true` by default, per-agent `skip_approval` override** | Writes overwrite in place with no version history; safe default with an escape hatch for trusted automation agents. |

Rejected storage alternatives: a new `agents` column (coordinated frontend fragment/mutation changes are fragile — a mismatch hard-breaks the editor; code-defined agents never get DB columns) and a `writable` flag on the EE retrieval `kbProfile` (couples a core capability to the EE license and breaks the wizard's exactly-13-entry serialization contract).

## Stored config shape

One entry in the agent's `tools` array (`ExuluAgentToolConfig`):

```jsonc
{
  "id": "knowledge_base_editor",
  "type": "function",
  "name": "Knowledge base editor",
  "config": [
    {
      "name": "knowledge_bases",
      "type": "json",
      // Record<contextId, { create: boolean; update: boolean }>
      "value": "{\"products\":{\"create\":true,\"update\":true},\"faq\":{\"create\":true,\"update\":false}}"
    },
    { "name": "skip_approval", "type": "boolean", "value": false }
  ]
}
```

**Semantics are explicit opt-in:** a context absent from `knowledge_bases`, or with a missing/false flag, gets **no** write tool. This deliberately inverts the retrieval pipeline's default-enabled semantics (`enabled !== false`, empty = all) — write access must never be implicit.

## Backend

### New file: `src/templates/tools/context-write-tools.ts` (core `src/`, not `ee/`)

```ts
createContextWriteTools(
  agent: ExuluAgent,
  context: ExuluContext,
  perms: { create: boolean; update: boolean },
  skipApproval: boolean,
): ExuluTool[]
```

Returns up to two `new ExuluTool({ type: "function", ... })` instances. Tool ids/names: `create_<sanitized ctx id>_item` and `update_<sanitized ctx id>_item`. To satisfy the `^[a-z_][a-z0-9_]{4,79}` tool-id rule, the sanitized context-id segment is capped at 68 chars (7 for `create_` + 5 for `_item`); two writable contexts whose ids share their first 68 chars would collide, which is acceptable and documented (context ids are ≤80 chars and near-identical long ids don't occur in practice).

**Schema building** (extends the `memory-tool.ts` type-switch over `context.fields`):

- `text`/`longText`/`shortText`/`code`/`markdown` → `z.string()`; `number` → `z.number()`; `boolean` → `z.boolean()`; `json` → JSON-string with description; `enum` → case-insensitive preprocess against `enumValues`.
- `date` → `z.string()` described as ISO-8601 (memory tool skips dates; KB items commonly need them).
- **Skipped entirely:** `file` fields (see "File fields" below), `uuid` fields, and fields flagged `calculated: true` **or** `editable: false`. Note: verified that no backend write path enforces `calculated`/`editable` today (`calculated` is entirely unused; `editable` is UI metadata only, e.g. `transcriptions.ts` `raw_segments`/`post_processing`; the GraphQL input types include every field) — these tools are deliberately the first enforcement point, since an agent must never set processor-owned or non-editable fields. The generated `fts` column and processor `field` artifacts are never part of any schema.
- **Create schema:** `name` required; `description`, `tags` (string array), `external_id` optional; custom fields required iff flagged `required`.
- **Update schema:** `id` or `external_id` required (refine: at least one); every content field optional — partial patch, only provided keys are written. `external_id` is **lookup-only** on update (never written back); neither tool exposes a `rights_mode`/visibility input in v1.

**Create execute:**

1. Canonicalize enum inputs (case-insensitive match, drop out-of-enum values — memory-tool pattern).
2. Set `created_by = String(user.id)` (verified: `createItem` does not set it; `created_by` is a text column). Leave `rights_mode` unset so the column default (`configuration.defaultRightsMode ?? "private"`) applies.
3. `context.createItem(item, exuluConfig, user?.id, user?.role?.id, /* upsert */ false, /* embeddings override */ undefined)` — the context's own `calculateVectors` / processor trigger config decides side effects.
4. Report the new item id; if a BullMQ `job` id comes back, tell the model processing/embedding is queued.

**Update execute:**

1. Require `id` or `external_id`; resolve `external_id → row` via `context.getItem` (since `updateItem` throws without a resolved `id`, unlike `deleteItem`).
2. **Row-level gate:** `checkRecordAccess(existingRow, "write", user)` — on denial return a refusal string (no throw). The not-found and access-denied refusals use the **same generic message** ("item not found or you don't have write access") so the tool can't be used to probe for the existence of rows the user can't see (`getItem` itself has no access control). Note `'write'` does not imply `'read'` in `checkRecordAccess`; results are cached 60s.
3. Merge only the provided fields onto `{ id }`, canonicalize enums, then `context.updateItem(patch, exuluConfig, user?.id, user?.role?.id)`.
4. `updateItem` returns the **pre-update** record — re-fetch via `getItem` and return the fresh row summary (+ job id if queued).

Both executes wrap everything in try/catch and return failures as `{ result: "…" }` strings so the model can self-correct; `user.id` (integer) is string-normalized wherever compared to `created_by` (text).

### File fields (excluded in v1 — verified mechanics)

A `file` field is a two-step affair: the item column `<name>_s3key` (plain text) only stores an S3 key string; the bytes must be uploaded to S3 **first** — the frontend does this via presigned PUT (`GET /s3/params` / `POST /s3/sign`, `src/uppy/index.ts`), and tools could do it via the `upload({name, data, type})` helper injected into tool inputs (`convert-exulu-tools-to-ai-sdk-tools.ts` ~502-577; only defined when `exuluConfig.fileUploads` S3 settings are complete). `allowedFileTypes` is client-side metadata, enforced nowhere server-side.

v1 excludes file fields from both tool schemas for two reasons: (1) a chat agent has no file bytes to upload — wiring sandbox artifacts or session files into item fields is its own feature; (2) exposing `<name>_s3key` as a writable string would let the model link items to arbitrary S3 objects. The v2 path is clear if wanted later: accept a sandbox-artifact/session-file reference, copy it via the `upload` helper (which returns the durable `"<bucket>/<key>"`), and write that key to `<name>_s3key`.

### Config parsing: `parseKbEditorConfig` (co-located or sibling file)

Never-throw zod parser over the tool entry's `config` array (pattern: `ee/agentic-retrieval/pipeline/config.ts` / `migrate-agentic-retrieval-config.ts`). Tolerates: missing entry, `value` vs `default`, JSON string or object, `agents.tools` arriving as a JSON string instead of an array (legacy). Malformed input degrades to "no writable contexts", never to an error.

### Injection: `src/templates/tools/convert-exulu-tools-to-ai-sdk-tools.ts`

Next to the memory-tool injection (the tools need the agent/context factory closure — the invoking agent's identity is *not* in tool inputs):

1. Find the `knowledge_base_editor` entry in the agent's tool configs; parse with `parseKbEditorConfig`.
2. For each configured contextId, resolve against the live contexts map — **skip silently if the context no longer exists** (contexts are code-registered and can disappear between deploys).
3. Inject the returned tools into the AI-SDK map; `needsApproval` stays `true` (approval key: `"tool-" + sanitized name`) unless `skip_approval` is set, which passes `needsApproval: false`.

`src/utils/enabled-tools.ts` (`getEnabledTools`) gets an explicit skip for the `knowledge_base_editor` entry id so it doesn't fall through to the registry lookup (mirrors the `agentic_context_search` special case; the entry itself is config, not a model-visible tool).

## Frontend (agent editor, `app/(application)/agents/edit/[id]`)

### Knowledge section (`sections/knowledge.tsx`)

New "Knowledge base editing" block under the retrieval wizard and memory picker:

```
Knowledge base editing              [master switch]
┌──────────────────────────────────────────┐
│ ☑ Products KB       ☑ create  ☑ update   │
│ ☑ FAQ KB            ☑ create  ☐ update   │
│ ☐ Contracts KB      ─         ─          │
└──────────────────────────────────────────┘
Skip chat approval for writes       [toggle]
```

- Master switch adds/removes the `knowledge_base_editor` entry in the staged `editor.tools` state (`hooks.ts` `useAgentEditor`); context list comes from the already-fetched `refs.contexts` (`useEditorReferenceData` / `GET_CONTEXTS_EDITOR`).
- Card layout reuses the `components/knowledge-search/steps/knowledge-bases-step.tsx` checkbox-card pattern, with per-context **create** / **update** checkboxes. Checking a context defaults to create=true, update=false (opt into overwrite explicitly).
- "Skip approval" toggle maps to the `skip_approval` config entry.

### Parse/serialize layer: `components/kb-editing/config-schema.ts`

Never-throw zod layer over the entry's `config` rows, copied from the retrieval wizard's `config-schema.ts` pattern — its own 2-entry contract (`knowledge_bases` json + `skip_approval` boolean), independent of the wizard's 13-entry contract.

### No GraphQL changes

`tools` is already selected in `AGENT_EDITOR_FIELDS` and declared in `UPDATE_AGENT_EDITOR`; the staged tools array already lands in the save payload. Frontend `types/models/agent.ts` needs no structural change (tool config entries are already loosely typed).

## Error handling summary

| Failure | Behavior |
|---|---|
| Malformed / legacy stored config | Parser degrades to no writable contexts; never throws |
| Configured context no longer registered | Skipped at injection; tool never exists |
| User lacks row-level write access on update | Tool returns a refusal message; no write |
| Zod input mismatch | AI-SDK schema error → model retries with corrected args |
| Out-of-enum value | Canonicalized case-insensitively or silently dropped (never persisted) |
| Postgres error (e.g. `external_id` unique conflict) | Caught; returned as tool-result string |
| Async processor/embeddings | Job id reported to the model as queued work |

## Testing

Backend unit tests (co-located `*.test.ts`, precedent: `migrate-agentic-retrieval-config.test.ts`):

- `parseKbEditorConfig`: happy path, missing entry, malformed JSON, string-vs-array `tools`, value/default fallback.
- Schema builder: required-on-create vs optional-on-update, enum handling, skipped fields (`file`/`uuid` types, `calculated: true`, `editable: false`), date-as-string, id/external_id refine on update.
- Execute paths with a mocked context: `created_by` stamping, rights_mode left to default, permission denial on update, `external_id` resolution, fresh-row refetch after update, error-to-string behavior, embeddings override left undefined.

Frontend: follows existing editor conventions (no test infra there today); verified manually via the editor + a chat write round-trip.

## Out of scope (v1)

- Delete tool (request was create/update only).
- File-field writes / uploads (see "File fields" section for verified mechanics and the v2 path).
- Upsert semantics on create.
- Item version history (updates overwrite in place — mitigated by approval default).
- Bulk writes; one item per tool call.
- A `contexts` capability on `UserRole` (existing TODO at `src/graphql/schemas/index.ts:328` — unchanged).

## Key reference files

| File | Role |
|---|---|
| `backend/src/exulu/context.ts:608/738/857/896` | `createItem` / `updateItem` / `deleteItem` / `getItem` entry points |
| `backend/src/templates/tools/memory-tool.ts` | The template: dynamic per-context write tool, schema from fields, enum canonicalization |
| `backend/src/templates/tools/convert-exulu-tools-to-ai-sdk-tools.ts` | Dynamic injection layer; execute wrapping (user/config spread into inputs) |
| `backend/src/utils/enabled-tools.ts` | Agent tool-entry hydration; needs the explicit skip |
| `backend/src/utils/check-record-access.ts` | Row-level write gate for updates |
| `backend/ee/agentic-retrieval/pipeline/config.ts` | Defensive-zod config-parsing pattern |
| `frontend/app/(application)/agents/edit/[id]/sections/knowledge.tsx` | UI home |
| `frontend/.../components/knowledge-search/steps/knowledge-bases-step.tsx` | Checkbox-card multi-select pattern |
| `frontend/.../components/knowledge-search/config-schema.ts` | Never-throw parse/serialize pattern |
| `frontend/app/(application)/agents/edit/[id]/hooks.ts` | Staged editor state + save payload |
