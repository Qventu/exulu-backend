# In-chat image generation widget

**Date:** 2026-05-31
**Status:** Approved, ready for implementation plan
**Supersedes (in part):** the inline rendering added in 2026-05-29 (per-model `image_generation` tool that generates immediately and renders inline). The per-model tool is replaced; the inline renderer is kept for backwards compatibility with old sessions.

## Background

A previous iteration registered one `image_generation` tool per LiteLLM model whose `model_info.type === "image_generation"`. The tool called the LiteLLM proxy directly, uploaded the result to S3, and the frontend rendered the URL inline.

That flow gave the user no control over the request: prompt, count, size, quality and model were all decided by the assistant, and reference-image editing was impossible. We want a richer experience where the agent's tool call **opens a widget** and the user drives generation/editing from there.

## Goals

- One unified `image_generation` tool — model-agnostic — that the assistant invokes by passing only a prompt.
- An in-chat widget that lets the user adjust prompt / model / count / size / quality, attach reference images, save and reuse styles, generate or edit, and pick a final selection.
- The assistant only "sees" the result the user explicitly selects, via a system message inserted into the chat — historical messages are never mutated.
- New backend routes `/images/generate`, `/images/edit`, `/images/select`, `/images/history` that enforce session RBAC and reuse the existing LiteLLM + S3 infrastructure.

## Non-goals

- Building a standalone "Image Studio" page — all image work happens inside chat.
- Background/queued generation. `/images/generate` and `/images/edit` are synchronous (typical 5–30s).
- A dedicated admin UI for managing styles outside the widget.
- Migrating data from the previous inline rendering — the old renderer is retained for old sessions and the widget renders new sessions only.

## Architecture overview

```
Assistant agent
   │ calls tool image_generation({ prompt })
   ▼
ExuluTool execute (no LiteLLM call) ──► returns widget config
   │                                       (models + styles + defaults)
   ▼
message-renderer renders ImageGenerationWidget
   │
   ├─► POST /images/generate ──┐
   ├─► POST /images/edit    ───┤── LiteLLM proxy ─► S3 (sessions/<id>/images/<toolCallId>/<uuid>.<ext>)
   │                           │   ↳ insert image_generations row
   ├─► POST /images/select  ──── update image_generations.selected
   │                              + insert agent_messages row (role=system)
   │                              ↳ assistant sees it on its next turn
   └─► GET  /images/history ─── re-signed presigned URLs per stored S3 key
```

## Detailed design

### Tool contract

A single tool replaces the per-model factory:

```ts
new ExuluTool({
  id: "image_generation",
  name: "image_generation",
  needsApproval: false,
  inputSchema: z.object({
    prompt: z.string().describe("Initial prompt; the user can edit it in the widget."),
  }),
  // The execute receives the AI SDK options object as a second argument
  // (already wired in convert-exulu-tools-to-ai-sdk-tools.ts), which is
  // where `toolCallId` lives — we forward it into the widget config so
  // /images/* routes can scope rows to this particular tool invocation.
  execute: async ({ prompt, user, sessionID }, options) => {
    const toolCallId = options.toolCallId;
    const models = getRegisteredImageModels();
    const styles = await loadAvailableStyles(user); // RBAC-filtered to readable rows
    return { result: JSON.stringify({
      type: "image_generation_widget",
      toolCallId,
      sessionId: sessionID,
      initialPrompt: prompt,
      models,                                  // [{ name, sizes, qualities, supportsEdit, maxN }]
      styles,                                  // [{ id, name, description, owner: 'user'|'shared' }]
      defaults: {
        model: models[0].name,
        size: models[0].sizes.includes('1024x1024') ? '1024x1024' : models[0].sizes[0],
        quality: models[0].qualities.includes('auto') ? 'auto' : models[0].qualities[0],
        n: 1,
      },
    })};
  },
});
```

Registration in `ExuluApp.create()` is gated on `isLiteLLMEnabled() && s3Configured && parseImageGenerationModels(...).length > 0`. The previously-introduced loop creating one tool per model is removed.

`loadAvailableStyles(user)` runs:
1. `db.from('platform_configurations').whereLike('config_key', 'image_generation_style:%')`
2. For each row, call the existing `RBACResolver` to fetch the row's RBAC, then filter to rows the user has at least `read` on.
3. Tag each with `owner: row.created_by === user.id ? 'user' : 'shared'` so the picker can show ownership-distinguishing icons and gate edit/delete UI affordances. The backend still enforces — frontend icons are display-only.

### Per-model capabilities

A static lookup in `src/templates/tools/image-generation-models.ts`:

```ts
export const IMAGE_MODEL_CAPABILITIES: Record<string, {
  sizes: string[];
  qualities: string[];
  supportsEdit: boolean;
  maxN: number;
}> = {
  "gpt-image-1": { sizes: ["1024x1024","1024x1536","1536x1024","auto"],
                   qualities: ["auto","low","medium","high"], supportsEdit: true, maxN: 10 },
  "dall-e-3":    { sizes: ["1024x1024","1024x1792","1792x1024"],
                   qualities: ["standard","hd"], supportsEdit: false, maxN: 1 },
  // ...
};
export const getRegisteredImageModels = () =>
  parseImageGenerationModels(configPath).map(m => ({
    name: m.model_name,
    ...(IMAGE_MODEL_CAPABILITIES[m.model_name] ?? FALLBACK_CAPS),
  }));
```

`FALLBACK_CAPS` defaults to `{ sizes: ['1024x1024'], qualities: ['auto'], supportsEdit: false, maxN: 1 }` — unknown models still work, just conservatively.

### Database

**New table** `image_generations` (added to `src/postgres/core-schema.ts`):

| Field                       | Type     | Notes |
|---                          |---       |---    |
| `session_id`                | uuid     | FK by convention; indexed |
| `tool_call_id`              | text     | indexed; joins one widget to N rows |
| `user_id`                   | number   | indexed |
| `operation`                 | text     | `'generate' \| 'edit'` |
| `model`                     | text     | the `model_name` sent to LiteLLM |
| `prompt`                    | longText | raw user prompt (without style appended) |
| `applied_style_id`          | uuid     | platform_configurations id, nullable |
| `applied_style_markdown`    | longText | snapshot at time of call, nullable |
| `size`                      | text     | nullable |
| `quality`                   | text     | nullable |
| `n`                         | number   | default 1 |
| `reference_image_keys`      | json     | `string[]` of S3 keys; null for generate |
| `mask_image_key`            | text     | nullable, edit-only |
| `image_keys`                | json     | `string[]` of S3 keys of outputs |
| `revised_prompts`           | json     | `(string\|null)[]` aligned with `image_keys` |
| `selected`                  | boolean  | default false; set true via /images/select |
| `error`                     | text     | populated when generation failed |

`RBAC: false` — access derived from `agent_sessions` via `session_id`.

Migration: append to `init-db.ts` as a create-if-not-exists block (per project convention from the memory note: migrations live in `init-db.ts`, gated by column-existence checks; for a new table, create-if-not-exists is sufficient).

**Styles in `platform_configurations`** (no schema change):
- `config_key` = `image_generation_style:<slug>`, where `<slug>` is `lowercase, dashes, max 60 chars` derived from the style name. The colon prefix preserves the existing unique constraint on `config_key`.
- `config_value` (json) = `{ name: string, markdown: string }`.
- `description` = short subtitle (one line, ≤200 chars).
- RBAC is handled by `platform_configurations` row-level RBAC (it already has `RBAC: true`).
- Listing query: `WHERE config_key LIKE 'image_generation_style:%'`, filtered by RBAC at resolver time.

### Backend routes

All three mutating routes require LiteLLM enabled + S3 configured (503 otherwise) and verify session access with `checkRecordAccess(session, "write", user)`. `GET /images/history` requires `read`.

#### `POST /images/generate`

```ts
Body: {
  sessionId: string;
  toolCallId: string;
  model: string;
  prompt: string;
  styleId?: string;
  n?: number; size?: string; quality?: string;
}
```
1. Authenticate; verify session write access.
2. Validate `model` against registered image models; validate `n/size/quality` against `IMAGE_MODEL_CAPABILITIES[model]`.
3. Resolve `styleId` if provided: load row, verify read access via RBAC, snapshot `config_value.markdown`.
4. Compose final prompt: `prompt + (style ? "\n\n" + style.markdown : "")`.
5. `await waitForLiteLLMReady()`; call `generateImage()` (extended to accept `n` and return an `Array<{buffer, contentType, extension, revisedPrompt}>`).
6. Upload each output to `sessions/<sessionId>/images/<toolCallId>/<uuid>.<ext>` via `uploadFile`. Keep S3 keys.
7. Insert one `image_generations` row (`operation='generate'`, `selected=false`), arrays aligned.
8. Return `{ generationId, images: [{ key, presignedUrl, revisedPrompt }] }`.

#### `POST /images/edit`

```ts
Body: {
  sessionId: string;
  toolCallId: string;
  model: string;
  prompt: string;
  styleId?: string;
  referenceImageKeys: string[];   // ≥1
  maskKey?: string;
  n?: number; size?: string; quality?: string;
}
```
1. Authenticate; verify session write access.
2. Validate model supports edits (`IMAGE_MODEL_CAPABILITIES[model].supportsEdit`).
3. Validate every `referenceImageKeys[*]` and the optional `maskKey` is owned by this user — key must contain `user_<userId>/` OR live under this session's `sessions/<sessionId>/` prefix.
4. Resolve style same as `/images/generate`.
5. Fetch each ref's bytes via `getS3ObjectBytes`. Build a `FormData` per LiteLLM's curl spec: one `image=@...` per file, `mask=@...` if present, `prompt`, `model`, `n`, `size`, `response_format=b64_json`.
6. POST to `http://<host>:<port>/v1/images/edits` with `Authorization: Bearer <masterKey>`.
7. Upload outputs to the same S3 prefix; insert `image_generations` with `operation='edit'`, `reference_image_keys` and `mask_image_key` populated.
8. Return `{ generationId, images: [...] }`.

#### `POST /images/select`

```ts
Body: {
  sessionId: string;
  toolCallId: string;
  selections: { generationId: string; imageKey: string }[];
}
```
1. Authenticate; verify session write access.
2. For each `selection`: load the `image_generations` row, verify it belongs to this `sessionId` + `toolCallId`, verify `imageKey ∈ row.image_keys`, set `selected=true` (idempotent — already-true stays true).
3. Build a markdown body listing the selections:
   ```
   The user generated and selected the following image(s) in this chat:
   - <presigned url 1> (prompt: "<final prompt>", model: gpt-image-1)
   - <presigned url 2> (prompt: "<final prompt>", model: gpt-image-1)
   ```
4. Insert a new `agent_messages` row with `content` = `JSON.stringify(UIMessage{role: 'system', parts: [{type: 'text', text: <markdown>}]})`, fresh `message_id`, same `session`, owning user.
5. Return `{ ok: true, systemMessage: <UIMessage> }` so the frontend can `setMessages(prev => [...prev, systemMessage])` without refetching.

#### `GET /images/history?toolCallId=...&sessionId=...`

1. Authenticate; verify session read access.
2. Load all `image_generations` rows for that `(sessionId, toolCallId)` ordered by `createdAt asc`.
3. For each row, re-sign every entry in `image_keys` (and `reference_image_keys` when present) to fresh presigned URLs (1-day expiry).
4. Return `{ history: GenerationRow[] }` where each row carries the full request params + presigned URLs + `selected` flag.

#### Style CRUD

No new endpoints — uses the existing GraphQL `platform_configurations` resolvers (`createOne`, `updateOne`, `deleteOne`, `Pagination`) that already enforce row-level RBAC. The widget calls these directly.

### Frontend

#### Render entry point

`message-renderer.tsx`: detect tool parts whose parsed output has `type === "image_generation_widget"` and render `<ImageGenerationWidget config={result} />`. The existing detection branch for `type === "image_generation"` (the old inline renderer) is **kept** so historical messages still render — old sessions are not migrated.

#### `ImageGenerationWidget` component

State:
```ts
{
  mode: 'generate' | 'edit',          // flips to 'edit' when ≥1 reference is attached
  prompt: string,                     // initialized from config.initialPrompt
  selectedModel: string,
  n: number, size: string, quality: string,
  selectedStyleId?: string,
  referenceImageKeys: string[],
  maskKey?: string,
  history: GenerationRow[],           // loaded via GET /images/history on mount
  selectedImages: { generationId: string; imageKey: string }[],
  isGenerating: boolean,
  abortController?: AbortController,
  error?: string,
}
```

Layout (vertical):
1. Header row: model picker, style picker (with "+ New style"), collapse-history toggle
2. Prompt textarea (multiline, auto-grow)
3. References strip — drag-and-drop area + thumbnails of `referenceImageKeys`; optional mask uploader; "Use as reference" appears on history image lightboxes
4. Controls row: size, quality, count (- 1 +)
5. Generate button (becomes Edit when `mode === 'edit'`); shows abort affordance during `isGenerating`
6. History stack — newest first, each generation shows operation badge, model, applied final prompt, and `n` thumbnails with multi-select checkboxes
7. Footer: "Selected: N images" + "Use these" button (disabled when `selectedImages.length === 0`)

#### Generation flow

`onGenerate()`:
```
abortController = new AbortController();
POST /images/generate or /images/edit (depending on mode) with signal
  → on success: prepend returned generation to `history`, mark `isGenerating=false`
  → on abort: set error 'Cancelled'
  → on failure: set error from response, leave history intact
```

#### Reference image flow

- **Upload new:** drag/click → Uppy → existing `/s3/sign` flow → on completion, push returned S3 key to `referenceImageKeys`; render thumbnail via presigned GET.
- **From history:** click thumb in history → lightbox → "Use as reference" → push its S3 key to `referenceImageKeys` (no upload).
- **From session files panel:** drag thumb into references area → same as history.

#### Style picker

- Items: `{ id, name, description, owner: 'user' | 'shared' }`. Icons distinguish owned vs shared.
- "+ New style" opens `<EditStyleDialog>` — name, description, markdown textarea, `<RBACControl>` (default `private`).
- Save → GraphQL `platform_configurationsCreateOne({ config_key: 'image_generation_style:'+slug, config_value: {name, markdown}, description, RBAC mode + users/roles })`.
- Edit/delete on owned styles only (resolver enforces).
- On save the widget refetches its style list (lightweight query, prefix filter).

#### "Use these" flow

```
POST /images/select → on success:
  setMessages(prev => [...prev, returnedSystemMessage]);
  collapseToFinalSelectionView();
```

Collapsed view: thumbnails of selected images + "Edit again" button (re-expands).

#### Persistence on reload

`useEffect(() => { fetchHistory() }, [toolCallId])` runs on mount → rehydrates `history` and `selectedImages` (from `selected=true` rows). If any rows are selected, render the collapsed Final-selection view by default.

### RBAC and authorization

- Session-level: all routes require `checkRecordAccess(session, ...)` — `read` for `/images/history`, `write` for the rest.
- Reference images: server-side check that the S3 key path is owned by the calling user or scoped to the current session.
- Styles: `read` for use, `write` for edit/delete — enforced by the existing `platform_configurations` row-level RBAC resolver.
- The `/configuration` page filters out `config_key LIKE 'image_generation_style:%'` so prefix-keyed styles are only manageable from inside the widget.

### Error handling

- LiteLLM upstream failure: surface the status + message returned by `generateImage` / equivalent edit helper as `error` on the returned response; route returns 502 for upstream 5xx, passthrough for 4xx.
- Abort: client sends `AbortController.signal`. The route handler races the LiteLLM call against `req.on('close', ...)` and on a client-aborted close, propagates abort to the upstream `fetch` and returns early. No `image_generations` row is written for an aborted attempt — if S3 uploads have already started, the spawned uploads are left to complete (they're cheap) but no row references them; they are unreferenced bytes and can be reaped by a periodic GC job later (out of scope).
- Validation: 400 with a structured `{ field, message }` payload.
- Missing reference image / S3 key not owned: 403.
- Style not found / no read access: 404.

### Open follow-ups (out of scope for this spec)

- Background-queued generation (would replace synchronous routes when Azure rate-limits become a real problem).
- An "Image Styles" admin page if the in-widget management becomes too cramped — data is already structured for it.
- Per-image-row schema if delete-single-image is ever required (current `image_keys` array would need migrating to one-row-per-image).

## Testing

- Backend unit tests for `getModelCapabilities`, input validation on each route, `/images/select` correctly mutates rows + inserts the system message, reference-image ownership check.
- Backend integration test for the full generate→select cycle against a stubbed LiteLLM.
- Frontend component test for state transitions in `ImageGenerationWidget` (mode flip on first reference, disabled Generate button while loading, abort, rehydration from history).

## Implementation order (rough)

1. DB migration for `image_generations` (init-db.ts).
2. `IMAGE_MODEL_CAPABILITIES` + `getRegisteredImageModels`.
3. Refactor `image-generation.ts` helper to support `n` and an array return.
4. New routes: `/images/generate`, `/images/edit`, `/images/select`, `/images/history`.
5. Remove the per-model `createImageGenerationTool` factory; add `createImageGenerationWidgetTool` and wire into `ExuluApp.create()`.
6. Frontend: `ImageGenerationWidget`, `EditStyleDialog`, style picker.
7. `message-renderer.tsx` detection for the new widget shape.
8. Style listing filter on the `/configuration` page.
9. Tests + manual QA.
