# Research — Agent Knowledge-Base Write Tools + Sandbox Document Vision Tools

Release page research, compiled 2026-07-22. All strings copied verbatim from source; refs are `file:line` against the current working trees (backend `develop`, frontend `main` + 2 docs commits).

Specs:
- Feature A: `backend/docs/superpowers/specs/2026-07-15-agent-kb-write-tools-design.md` (Approved)
- Feature B: `backend/docs/superpowers/specs/2026-07-13-sandbox-document-vision-tools-design.md` (Approved)

Key commits:
- Feature A backend (2026-07-20/21): `0807ca7` kb-editor config parser, `339bae4` per-context create/update tool factory, `aa764d4` injection from agent config, `5f4888a` guards (guest users, reserved keys, hidden fields), `8ecc13d` KB editor as picker entry in Query.tools default category.
- Feature A frontend (2026-07-20/22): `2f12f6f` config parse/serialize layer, `0f1df2b` KB editing config in agent editor, `c891b75` moved into Tools section default category, `b55a307` labeled switches, `1a4db38` switches no longer uncheck the row.
- Feature B backend (2026-07-13, merged 2026-07-14): `dd50915` parse_document, `769e0ba` image stash + prepareStep guard, `5ad2290` view_document_page with image-stash delivery, `718302b` size-limit vs missing-page distinction, `2443075` stash tool-name scoping + byte budget + page-range validation, `69eafab` pdftoppm exit-99 handling.

---

## What shipped & why it matters

### Feature A — Agent knowledge-base write tools (agents that maintain your knowledge, not just answer from it)

Until now agents could only *read* knowledge bases. Now an admin can allow an agent to **create and update items in specific knowledge bases during chat** — log a decision, file a support answer, correct a stale product entry — turning agents from consumers of your knowledge into curators of it.

How it works (spec summary + verified source):

- The admin enables a "Knowledge base editor" tool on the agent (Tools section, `default` category) and, per knowledge base, flips **Create** and/or **Update** on. Explicit opt-in: a context absent from the config, or with both flags off, gets **no** write tool (`backend/src/templates/tools/kb-editor-config.ts:30-32` — "Malformed input degrades to 'no writable contexts' — write access must never appear by accident").
- At chat runtime the single config entry is expanded into a **pair of real tools per writable knowledge base**: `create_<ctx>_item` and `update_<ctx>_item`, with zod schemas generated from that context's actual field definitions (names, types, enum values) so the model gets precise, typed inputs (`backend/src/templates/tools/context-write-tools.ts:138-273`).
- Writes are **gated twice**: the agent config grants the capability, and the invoking user's row-level rights still govern updates (`backend/src/utils/check-item-write-access.ts`). "An agent never lets a user do more than the UI would" (spec, Decisions table).
- Every write **asks for approval in the chat by default** (`needsApproval: !skipApproval`, `context-write-tools.ts:158,216`), with a per-agent "Skip chat approval" override for trusted automation agents.
- Created items are stamped `created_by = String(user.id)` and inherit the context's default visibility; if the context has embeddings/processing configured, the tool reports the queued job: "Processing/embeddings queued (job: …); changes become searchable when the job completes." (`context-write-tools.ts:135-136`).

### Feature B — Sandbox document vision tools (agents that can actually look at your documents)

Originating bug (spec, Problem section): a user uploaded `test.pdf` and asked about an image on page 2 — the agent "ran shell tricks (`file`, exit 127) and apologized". Tool results in the agentic loop are text-only, so even though the sandbox could render a PDF page, no channel carried pixels into the model's context.

Two small on-demand session tools fix this (registered automatically whenever session file uploads are configured — no per-agent toggle):

- **`parse_document`** — free, fast text extraction (no LLM, no OCR, no license gate). PDFs come back with `--- page N ---` markers so the agent learns *which page holds what*; Office formats (docx/xlsx/pptx/odt/…) are extracted whole via officeparser. Detects scanned PDFs (< 20 non-whitespace chars/page) and redirects: "Use view_document_page to look at pages visually, or suggest the user add the document to a knowledge base with a document processor for full OCR." (`backend/src/templates/tools/parse-document-tool.ts:82-87`).
- **`view_document_page`** — renders a PDF page (or an Office page via LibreOffice→PDF conversion, or an uploaded image directly) to PNG at up to 1568 px long edge and delivers it **into the model's own context** as a user-message image part, injected right after the tool result by a `prepareStep` guard (`backend/src/exulu/tool-image-attachments.ts:85-122`). The model literally sees the pixels within the same agentic loop — charts, scans, photos, layouts. This also fixed the agent's blindness to plain screenshots in the sandbox (spec, Tool 2).
- Delivery is via an in-process image stash (bounded: 100 entries, 30-min TTL, 100 MB byte budget, scoped to tool name `view_document_page` — `tool-image-attachments.ts:16-19`) because the openai-compatible transport stringifies rich tool-result content; images are intentionally never persisted to chat history.
- Deterministic refusal on non-vision models (LiteLLM `supports_vision` catalog flag): "The current model \"<id>\" does not support images, so this page cannot be shown to you." (`backend/src/templates/tools/view-document-page-tool.ts:69-74`).

---

## UI reconstruction cues

### Agent editor — Tools section (`frontend/app/(application)/agents/edit/[id]/sections/tools.tsx`)

Section skeleton (`tools.tsx:133-280`):
- `<section id="tools" className="scroll-mt-20 space-y-4">`; heading `<h2 className="text-lg font-medium">` = "Tools & skills" (`t("editor.sections.tools")`), summary line `text-sm text-muted-foreground`.
- Toolbar: search input with `Search` (lucide) icon absolutely positioned (`pl-10 pr-10` input), category `Select` (`w-full sm:w-[200px]`), outline `Button size="sm"` "Expand all" / "Collapse all", result count `ml-auto text-sm text-muted-foreground`.

Tool card (`frontend/app/(application)/agents/edit/[id]/components/agent-tool-card.tsx:104-360`):
- Row: `rounded-lg border border-l-4 hover:bg-muted/30`, left accent `border-l-secondary` for tools; icon square `shrink-0 rounded-md p-2 bg-muted` with `Wrench` icon `size-4 text-muted-foreground`.
- Title `text-base font-medium capitalize` renders `tool.name?.replace(/_/g, " ")` → **"Knowledge base editor"**; badges: outline badge with `Wrench` mini-icon + "Tool" (`t("editor.tools.typeTool")`), secondary badge with category → **"default"**; when enabled + configurable a `{filled}/{required}` config-count badge (destructive with `AlertCircle` when incomplete).
- Description under the title, `line-clamp-2 text-sm text-muted-foreground`: **"Let this agent create or update items in selected knowledge bases during chat. Configure per knowledge base whether the agent may create and/or update items."** (`backend/src/templates/tools/context-write-tools.ts:286-288`).
- Right side: `Info` icon button (`size-8` ghost), a `Settings` gear icon button when enabled+configurable, and the enable `Switch`. Enabling a configurable tool **auto-opens the config sheet** (`tools.tsx:91-94`).
- Config sheet: `SheetContent className="w-full overflow-y-auto sm:max-w-[540px]"`, header = icon square + capitalized title + Tool/default badges + description, then a "Configuration" (`t("editor.tools.configuration")`) block.

### KB editing config panel (`frontend/app/(application)/agents/edit/[id]/components/kb-editing/kb-editing-config-panel.tsx`)

The sheet special-cases `tool.id === KB_EDITOR_TOOL_ID` (`sections/tools.tsx:241-246`) and renders `KbEditingConfigPanel` instead of the generic config fields.

- Wrapper `space-y-3`; empty state `text-sm text-muted-foreground`: **"No contexts found."** (`en.json` `agents.editor.knowledge.noContexts`).
- One row per knowledge base (`space-y-2` list): `flex items-center justify-between gap-3 rounded-md border p-3`, left = shadcn `Checkbox` + `<span className="truncate text-sm font-medium">{ctx.name}</span>`.
- When the row's checkbox is on, right side shows two labeled shadcn `Switch`es (`flex shrink-0 items-center gap-4`), each wrapped in `<span className="flex items-center gap-2 text-sm text-muted-foreground">` with labels **"Create"** and **"Update"** (`en.json:460-461`). Checking a context defaults to `{ create: true, update: false }` (panel `setContextEnabled`, line 40-48) — opt into overwrite explicitly.
- Footer below a divider (`flex items-start justify-between gap-3 border-t pt-3`): title `text-sm font-medium` **"Skip chat approval"**, description `text-sm text-muted-foreground` **"Writes run without an approval prompt in the chat. Only enable for trusted automation agents."** (`en.json:462-463`), plus a `Switch` on the right.

ASCII of the sheet body (matches spec diagram + shipped markup):

```
┌ Knowledge base editor ────────────── [Tool] [default] ┐
│ Configuration                                          │
│ ┌───────────────────────────────────────────────────┐  │
│ │ ☑ Products KB          Create (●)   Update (●)    │  │
│ │ ☑ FAQ KB               Create (●)   Update (○)    │  │
│ │ ☐ Contracts KB                                    │  │
│ └───────────────────────────────────────────────────┘  │
│ ───────────────────────────────────────────────────    │
│ Skip chat approval                            (○)      │
│ Writes run without an approval prompt in the chat.     │
└────────────────────────────────────────────────────────┘
```

### What tool calls look like in chat

Generic tool chip (`frontend/app/(application)/chat/components/message-column.tsx:82-149` + `frontend/components/ai-elements/tool.tsx:25-92`):
- Collapsible card (`Tool` with `mt-3`, closed by default). Header: `WrenchIcon size-4 text-muted-foreground`, tool name in `font-medium text-sm`, then a rounded-full secondary status `Badge` with icon: "Pending" (circle) / "Running" (pulsing clock) / "Awaiting Approval" (yellow clock) / "Completed" (green check) / "Error" (red X) / "Denied" (orange X) (`tool.tsx:39-66`); `ChevronDownIcon` rotates on open.
- Chip name transform (`message-column.tsx:98-103`): strip `tool-`, underscores→spaces, first letter capitalized. So `create_products_item` shows as **"Create products item"**, `view_document_page` shows as **"View document page"**, `parse_document` shows as **"Parse document"**.
- Expanded body: `ToolInput` (pretty-printed input JSON) + `ToolOutput` (markdown-rendered result string).

Approval card, shown for KB writes by default (`frontend/app/(application)/chat/components/tool-call-approval.tsx:120-183`):
- `Card className="mt-3 border-border bg-card"`; `ShieldAlert` icon; title **"Run {tool}?"** → e.g. "Run create products item?"; description **"The agent wants to run this tool. Review the request and choose how to proceed."**
- Input preview: first well-known string field (`path`/`filename`/`query`/`name`-ish heuristics) in a `line-clamp-3 break-all rounded-md border bg-muted/40 px-3 py-2 font-mono text-xs` block.
- Buttons (stack below `sm`): primary **"Allow once"**, outline **"Allow for this chat"** (persists per session via localStorage `pre-approved-tool-calls-{sessionId}`), outline + `text-destructive` **"Deny"**.
- After response: slim status pill — green `border-success/30 bg-success/5` with `CheckCircle2` + **"Approved: {tool}"**, or destructive tint with `XCircle` + **"Denied: {tool}"**.

Note for demo accuracy: the image rendered by `view_document_page` is injected model-side only (prepareStep) — the human sees the collapsed tool chip and then the agent's visual answer, not the injected image itself. The tool result the user can expand reads: `{"attached": true, "filename": "report.pdf", "page": 3, "note": "The rendered image follows this tool result as an attached user message — analyze it there. …"}` (`view-document-page-tool.ts:132-137`).

---

## Developer surfaces

### Feature A — exact tool names + schemas

Tool naming (`backend/src/templates/tools/context-write-tools.ts:144,151,207`): `segment = sanitizeName(context.id).slice(0, 68)` where `sanitizeName` lowercases and replaces spaces with `_` (`backend/src/utils/sanitize-name.ts:1-3`). IDs:

- **`create_<segment>_item`** — display name `Create ${context.name} item`, category `knowledge_base_editing`, description `Create a new item in the "${context.name}" knowledge base.` + the context description (`context-write-tools.ts:151-154`).
- **`update_<segment>_item`** — display name `Update ${context.name} item`, description `Update an existing item in the "${context.name}" knowledge base. Provide the item's id (or external_id) plus only the fields to change; omitted fields keep their values.` (`context-write-tools.ts:207-212`).

Example: a context with id `products` yields `create_products_item` / `update_products_item`.

Input schema (built per context in `buildWriteSchema`, `context-write-tools.ts:29-99`):
- Base fields: `name` (string, required on create), `description` (string), `tags` (string array), `external_id` (string; create-only as content — on update it exists solely as a lookup key, "Lookup only — it is never changed.", line 46).
- Update adds optional `id` + `external_id` lookup keys; at least one is required at execute time ("Provide the id or external_id of the item to update.", line 224).
- Per-field mapping from `context.fields`: `enum` → string with `Must be one of: <values>` description; `json` → "as a valid JSON string"; `markdown` → "as a valid Markdown string"; `date` → "as an ISO-8601 date string"; `number`/`boolean` native; everything else string (`context-write-tools.ts:66-94`). Required flags apply only in create mode; update is a partial patch.
- Enum values are canonicalized case-insensitively at execute time; unmatched values return `Invalid value "<v>" for field "<f>". Allowed values: …` so the model self-corrects (`context-write-tools.ts:104-123`).

Stored config on the agent — one entry in `agents.tools` (`backend/src/templates/tools/kb-editor-config.ts:7`, spec "Stored config shape"):

```jsonc
{
  "id": "knowledge_base_editor",
  "type": "function",
  "name": "Knowledge base editor",
  "config": [
    { "name": "knowledge_bases", "type": "json",
      // Record<contextId, { create: boolean; update: boolean }>
      "value": "{\"products\":{\"create\":true,\"update\":true},\"faq\":{\"create\":true,\"update\":false}}" },
    { "name": "skip_approval", "type": "boolean", "value": false }
  ]
}
```

Parsed by `parseKbEditorConfig` (`kb-editor-config.ts:33-83`, never throws; both-false entries dropped server-side) and mirrored client-side in `frontend/.../components/kb-editing/config-schema.ts:27-59` (both-false entries *kept* so the row stays visibly checked — divergence is deliberate and commented at lines 46-49).

Plumbing:
- Picker entry pushed into `Query.tools` at `backend/src/graphql/schemas/index.ts:2411` via `createKbEditorPickerTool()` (`context-write-tools.ts:281-309`); its execute is a stub: "This entry is configuration-only; Exulu expands it into per-context create/update tools at runtime."
- `getEnabledTools` explicitly skips the id so it never reaches the registry (`backend/src/utils/enabled-tools.ts:35-40`).
- Runtime expansion + injection: `collectKbWriteTools(agent, contexts)` in `backend/src/templates/tools/convert-exulu-tools-to-ai-sdk-tools.ts:274-278`; vanished contexts are skipped silently (`context-write-tools.ts:323-327`).

Guards worth naming:
- **Guest/anonymous block:** `if (!user?.id) return { result: "Knowledge base writes require an authenticated user." }` on both executes (`context-write-tools.ts:161-163,218-220`; commit `5f4888a`).
- **Row-level write gate on update:** `checkItemWriteAccess` (`backend/src/utils/check-item-write-access.ts:13-96`) replicates GraphQL `validateWriteAccess`: super_admin / admin-scope API keys allowed; `public` allowed; `private` → creator only (string-normalized id compare); `users`/`roles`/`teams` → `rights: "write"` grant lookup in the shared `rbac` table. Not-found and access-denied share one message so the tool can't probe hidden rows: `Item not found in "<ctx>" or you don't have write access to it.` (`context-write-tools.ts:202-204`).
- **Reserved input keys:** fields named `model`, `user`, `contexts`, `memory`, `req`, `upload`, `sessionID`, `sessionItems`, `providerapikey`, `allExuluTools`, `currentTools`, `exuluConfig`, `toolVariablesConfig`, `oauth` are excluded — the AI-SDK execute wrapper injects these at runtime and would silently overwrite them (`context-write-tools.ts:20-24`).
- **Field skips:** `file` and `uuid` types, `calculated: true`, `editable: false`, `hidden: true` (write-only secrets) never appear in schemas (`context-write-tools.ts:61-64`). File fields are deliberately v1-excluded (spec "File fields": exposing `<name>_s3key` would let the model link arbitrary S3 objects).
- All failures return `{ result: "…" }` strings — never throws — so the model self-corrects.

### Feature B — exact tool names + schemas

**`parse_document`** (`backend/src/templates/tools/parse-document-tool.ts:137-159`):
- Description: `Extract the text of an uploaded PDF or Office document from this session's files, with "--- page N ---" markers for PDFs so you can locate content by page. Free and fast (no OCR): works only on documents with a real text layer. To SEE a page or an image inside a document, use view_document_page.`
- Input: `filename` (string, `Exact session file name, e.g. "report.pdf"`), `pages` (optional string, `PDF page or range to extract, e.g. "2" or "1-5" (default: all pages) (PDF only)`), `offset` (int ≥1), `limit` (int 1-1000, default 250).
- Output: `{ content, totalPages?, totalLines, offset, linesReturned }`; 16,000-char cap per call with `[slice truncated — request fewer lines]` marker (`parse-document-tool.ts:11,120-124`).
- Validation: bare-filename/path-traversal rejection (line 46-51), pages regex `^(\d+)(?:-(\d+))?$` with range checks (lines 22,89-99), pages option rejected for non-PDF, scanned-PDF detection (< 20 chars/page average).

**`view_document_page`** (`backend/src/templates/tools/view-document-page-tool.ts:143-161`):
- Description: `LOOK at a page of an uploaded PDF/Office document, or at an uploaded image, from this session's files. The rendered image is attached as a user message directly after this tool result so you can visually analyze photos, charts, scans, and layouts. Use parse_document first to find which page you need. Requires a vision-capable model.`
- Input: `filename` (string, `Exact session file name, e.g. "report.pdf" or "screenshot.png"`), `page` (int ≥1 optional, `Page number to render (default 1; ignored for image files)`).
- Rendering: poppler `pdftoppm` at 1568 px long edge, fallback re-render at 1024 px, hard cap 3,750,000 bytes (≈5 MB after base64) (`view-document-page-tool.ts:13-15,111-120`); Office → PDF via the ETag-cached LibreOffice preview path (`getPdfPreviewBytes`, `backend/src/sessions/pdf-preview-cache.ts`); images (png/jpg/jpeg/gif/webp) pass through directly.
- Delivery: `stashToolImage(toolCallId, …)` + `imageAttachmentGuard()` prepareStep composed into every agent loop (`backend/src/exulu/provider.ts:589,657,1216`, `backend/src/exulu/openai-gateway.ts:549,591`). Injected user message text marker: `[Image attached from tool call <id>: <label>]` (`tool-image-attachments.ts:3,69-71`). Stash bounds: 100 entries / 30-min TTL / 100 MB, scoped to tool name `view_document_page` (`tool-image-attachments.ts:16-19`).
- Size-limit vs missing-page distinction (commit `718302b`): out-of-range page → `Could not render page N of "file" — the document may have fewer pages.`; over-budget after downscale → `Page N of "file" is too complex to attach within the image size limit.` (`view-document-page-tool.ts:112-120`).
- Both tools register host-side whenever `sessionID` + `exuluConfig.fileUploads.s3Bucket` exist (`convert-exulu-tools-to-ai-sdk-tools.ts:298-306`); `needsApproval: false`; category `session`.

---

## Demo-worthy moments

### 1. "Log that decision" — the full KB write round-trip (hero demo)
1. Agent editor → Tools section → search "knowledge" → the **Knowledge base editor** card (Wrench icon, `default` badge) → flip the enable Switch.
2. Config sheet auto-opens: check **Decisions** knowledge base → labeled **Create** switch lights on (Update stays off) → save.
3. In chat: "Log a decision: we're standardizing on LiteLLM tag budgets, decided today."
4. Chip appears: **"Awaiting Approval"** → approval card **"Run create_decisions_item?"** with the item name in a mono preview → click **Allow once**.
5. Chip flips to **Completed**; expanded output: `Created item <id> in knowledge base "Decisions". Processing/embeddings queued (job: …); changes become searchable when the job completes.`
6. Cut to the knowledge workspace: the item is there, `created_by` = the chatting user.

### 2. "Fix the stale entry" — update with a safety net
1. Same agent, a context with **Update** enabled.
2. Chat: "The FAQ entry about pricing is outdated — the starter plan is now €49."
3. Agent retrieves the item (agentic search), then calls `update_faq_item` with just `id` + the one changed field — omitted fields keep their values (partial patch by design).
4. Approval card → **Allow for this chat** (persists for the session).
5. Output shows the fresh row: `Updated item <id> in knowledge base "FAQ". … Current item: {…}`.
6. Twist for the security beat: a user without row-level write access gets `Item not found in "FAQ" or you don't have write access to it.` — the agent config grants capability, the user's rights still rule.

### 3. "What's on page 3?" — the agent actually looks (Feature B hero)
1. Upload `report.pdf` to the session files panel; ask "What does the chart on page 3 show?"
2. Chip 1: **Parse document** — output has `--- page 1 --- … --- page 3 ---` markers; the agent locates the chart's caption.
3. Chip 2: **View document page** with `{ "filename": "report.pdf", "page": 3 }` — result: `attached: true`, and model-side the rendered 1568-px PNG is injected as a user-message image part.
4. The agent answers describing the chart's actual trend — something impossible from text extraction alone. (This is the exact scenario from the spec's originating bug: before, the agent "ran shell tricks (`file`, exit 127) and apologized".)

### 4. "The scan" — graceful degradation
1. Upload a scanned (image-only) PDF; ask for its contents.
2. `parse_document` refuses smartly: `"scan.pdf" has no extractable text layer (likely a scan or image-based PDF). Use view_document_page to look at pages visually, or suggest the user add the document to a knowledge base with a document processor for full OCR.`
3. Agent pivots to `view_document_page` and reads the page visually — self-correcting tool routing on camera.
4. Bonus beat: on a non-vision model the tool answers deterministically: `The current model "<id>" does not support images, so this page cannot be shown to you.`

---

## Flags / requirements

Feature A — Agent KB write tools:
- Per-agent, per-context **explicit opt-in** via the "Knowledge base editor" tool entry; no context is writable by default (both-false / absent = no tool). Core `src/`, **no EE license gate**.
- Chat **approval required by default** for every write; `skip_approval` (UI: "Skip chat approval") is the per-agent escape hatch for automation agents.
- Writes require an **authenticated user** (guest/public chats get a refusal string); updates additionally require **row-level write access** (rbac table / creator / public).
- No delete tool, no file-field writes, no bulk writes, no version history in v1 (spec "Out of scope"); updates overwrite in place — hence the approval default.
- Status caution for the page: backend commits are on local `develop` (up to `8ecc13d`), frontend on local `main` (up to `1a4db38`) — **merged locally, NOT pushed as of 2026-07-22; UAT pending**. Known backlog: friendlier PG 23505 duplicate-key message, master-disable check, cast cleanup.

Feature B — Sandbox document vision tools:
- Auto-registered session tools — **no admin toggle**; require a `sessionID` and configured file uploads (`exuluConfig.fileUploads.s3Bucket`, `convert-exulu-tools-to-ai-sdk-tools.ts:298-306`). `needsApproval: false` for both.
- `view_document_page` needs a **vision-capable model** (LiteLLM catalog `supports_vision`; deterministic refusal otherwise). `parse_document` works on any model but only on documents with a real text layer.
- System dependencies: poppler `pdftoppm` + `pdftotext` are REQUIRED_SYSTEM_DEPENDENCIES (`backend/src/exulu/system-dependencies.ts:64-74`); Office rendering rides the existing LibreOffice preview path.
- Rendered images are **never persisted to chat history** (in-process stash: 100 entries / 30-min TTL / 100 MB); later turns see only the marker text and the agent re-calls the tool to look again.
- Merged to develop 2026-07-14 (commits `dd50915` … `2443075`); shipped state.
- Boundary (per design decision): deep document processing (OCR, layout analysis) stays in knowledge bases with the EE `documentProcessor` — the chat sandbox deliberately only gets these two lightweight on-demand tools.
