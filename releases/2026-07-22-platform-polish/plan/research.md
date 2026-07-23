# Research — 2026-07-22 Platform Polish roundup

Four small features/fixes. A and B are reliability work on the meeting-recording pipeline;
C and D are UX additions (skills web UI, chat export). All verified against code on
backend `develop` and frontend `main` working trees, 2026-07-22.

Commits:
- A: frontend `0b55998` — feat(transcriptions): run never-ran post-processing prompts from the review sheet (2026-07-22)
- B: backend `63c47bc` — fix(recall): reconcile stuck meeting jobs and make post-processing crash-safe (2026-07-22)
- C: frontend `252590a`, `4990fdd`, `69e892b`, `4ac6150`, `843ffe0`, `b9818d1`, `5fe486d` (2026-07-09)
- D: frontend `d7d4e3b` — feat(chat): formatted copy/download for email and WhatsApp (2026-07-21)

---

## What shipped & why it matters

### A) Run never-ran post-processing prompts from the transcript review sheet (reliability fix + small feature)

When you start a meeting recording you can attach post-processing prompts
(composer section "Post-processing", hint: "Run prompts on the transcript
automatically when it's ready"). Those prompts auto-run when the transcript
arrives — but if that auto-run was ever lost (server crash/restart mid-run, see
item B), the review sheet used to just say "No post-processing results." with
no way to recover the configured prompts.

Now the review sheet detects configured prompts that have **no result** and
renders each one as a card with a **Run** button, named via the prompt library
("Prompt no longer available" if the prompt was since deleted). While the
backend's automatic run is genuinely in flight the sheet shows "Running…" and
polls every 5 s until the result cards appear. Honest framing: this is a safety
net for a failure mode, plus it fixed a pre-existing staleness bug where even
the existing "Re-run" button's result never showed up without reopening the
sheet.

"Never-ran" precisely means: the job row has `post_processing_prompts`
configured but no matching entry in `post_processing_outputs` — the
fire-and-forget auto-run after `transcript.done` died or never started.

### B) Stuck meeting recordings recover themselves (reliability fix, backend-only)

The Recall.ai webhook route ACKs with 2xx **before** processing (so Recall
never times out), but Recall never redelivers an ACKed event — so a crash or
restart mid-processing permanently stranded meeting jobs in the UI at
"Recording finished" or "Transcribing…", and lost post-processing runs could
never re-run. Users saw meetings stuck in Processing forever.

Fix: a background reconciliation loop (every 60 s, started only when Recall is
configured) finds rows stuck in `queued`/`transcribing` for >10 minutes and
re-drives them from Recall's own state through the exact same guarded webhook
handlers — idempotent by construction, so a late webhook racing the sweep is
harmless. Safeguards: live meetings are never transcribed mid-call (only a
COMPLETED recording is driven to transcription), Recall-side 404s and
transcript failures are terminal, and every job gives up with a clear error
after 24 h even under persistent API errors. Post-processing became
crash-safe: an atomic `"[]"` claim + per-prompt heartbeat prevents
double-spending LLM calls, and results are merged optimistically so concurrent
writers can't clobber each other. Recall API calls got per-attempt timeouts
(60 s API / 300 s downloads) with retries restricted to idempotent GETs, so a
timed-out POST can't create duplicate bots or double-billed transcripts.

Benefit-first framing: meeting recordings now finish — or fail with a reason —
on their own; no more zombie "Processing" rows and no more silently missing
meeting summaries.

### C) Skills library: upload a skill from a file OR a folder, download as .skill (web-UI UX)

The skills library's "New skill" dialog now accepts three upload shapes: a
`.zip`, a single `.md`, and — new — a `.skill` bundle, plus an entire **skill
folder** via a second drop zone (folder picker or drag-and-drop; the folder is
zipped client-side with fflate, junk files like `.DS_Store`/`__MACOSX`
stripped, validated for a root `SKILL.md`, max 50 MB / 500 files). The dialog
prefills Name and Description from the skill's `SKILL.md` frontmatter — only
into fields you haven't typed in. On the other side, every skill's overflow
menu now offers "Export as .skill" alongside "Download as .zip", so skills
round-trip between the web UI and the filesystem format agents use.

Scope note: the agent-installer / registry / publish flow is already covered by
the 2026-07-13 "Connect your agent" release page — this item is ONLY the web-UI
upload/download UX (the create dialog's dropzones + the detail panel's
export/download menu). Do not re-announce "Connect your agent" or the
copy-install-prompt action here.

### D) Chat messages copy/download formatted for email and WhatsApp

The per-message **Copy** button on assistant messages used to put raw markdown
on the clipboard — pasting into an email or WhatsApp showed literal `**` and
`#` characters. Now Copy writes a dual-flavor clipboard payload: email-safe
HTML (inline styles only, which is all email clients keep on paste) plus
WhatsApp-flavored plain text (`*bold*`, `_italic_`, `~strike~`, headings as
bold lines, tables as aligned monospace blocks). The **Download** button became
a two-item menu: "Formatted (HTML)" (a self-contained styled HTML document) and
"Markdown" (raw). Copies and downloads now exclude reasoning parts — only the
visible answer text is exported — and export URLs are protocol allow-listed
(http/https/mailto/tel) since the plain remark→rehype export pipeline doesn't
sanitize like the on-screen renderer does.

---

## UI reconstruction cues

### A) Review sheet post-processing cards

Component: `/Users/daniel.claessen/Desktop/Projects/exulu/frontend/app/(application)/transcriptions/components/review-sheet.tsx`
- `PostProcessingResults` at line 706; stale-claim constant `POST_PROCESSING_CLAIM_STALE_MS = 30 * 60 * 1000` at line 704 (mirrors backend `POST_PROCESSING_REDO_STALE_MS`).
- `inFlight` computation lines 730-736: prompts configured + outputs `[]`-claimed + `updatedAt` fresh → "Running…"; polling `setInterval(..., 5000)` lines 767-773.
- Pending card markup (lines ~805-838): `<div className="rounded-md border p-3">`, name `<span className="min-w-0 truncate text-sm font-medium">`, Run `<Button variant="ghost" size="sm" ... className="shrink-0 max-md:h-11">` with `Loader2 className="mr-1 size-3.5 animate-spin"` while running; subtitle `<p className="mt-1 text-sm text-muted-foreground">`.
- Section heading: `<p className="text-sm font-medium">` with `t("review.postProcessing")`.
- Prompt names fetched via `GET_PROMPT_LIBRARY` (`app/(application)/transcriptions/queries.ts:143`); mutation `RUN_TRANSCRIPT_POST_PROCESSING` (`queries.ts:121`).

Exact strings (`messages/en.json` → `transcriptions.review` / `transcriptions.toasts`):
- Sheet title: "Review transcript"; section: "Post-processing"
- New: "Run", "Not run yet.", "Prompt no longer available"
- Existing: "Re-run", "Running…", "Failed", "No post-processing results."
- Toasts: success "Prompt re-run", error "Couldn't run the prompt"
- German: "Ausführen", "Noch nicht ausgeführt.", "Prompt nicht mehr verfügbar"

Context (list page): title "Transcripts"; row states from `app/(application)/transcriptions/components/job-row.tsx:70-77` — meeting rows show `humanizeBotStatus` (`types.ts:187-203`): "Recording finished" (bot `done`), "Call ended", "In the call — recording", else "Queued…" / "Transcribing…".

### B) Backend recall recovery (no UI of its own)

- Webhook route: `/Users/daniel.claessen/Desktop/Projects/exulu/backend/src/exulu/routes.ts:637` (`app.post("/recall/webhooks", ...)`) — verify signature → ACK 200 → `void recallService.handleWebhookEvent(event)` (lines 660-666).
- Loop: `/Users/daniel.claessen/Desktop/Projects/exulu/backend/src/exulu/recall/reconcile-loop.ts` — `RECONCILE_INTERVAL_MS = 60_000`; log line `[EXULU-RECALL] reconcile tick recovered N job(s)`; started from `src/exulu/app/index.ts:474-477` iff `recallEnabled()`; stops on SIGINT/SIGTERM.
- Sweep: `src/exulu/recall/service.ts:608` `reconcileOnce(limit = 10)` — stuck query on `status IN ('queued','transcribing')`, `updatedAt` older than `RECONCILE_STALE_MS` (10 min, line 42); redo query for `awaiting_review` rows with prompts but empty outputs older than `POST_PROCESSING_REDO_STALE_MS` (30 min, line 51).
- Guards: `_reconcileQueued` (line 704) probes live meetings only after `RECONCILE_PROBE_QUIET_MS` (60 min, line 45); recording-completion gate at lines 719-733; `_reconcileError` (line 682) — 404 terminal, `RECONCILE_GIVE_UP_MS` 24 h (line 48): error text "still stuck 24 hours after the meeting start (last error: …)".
- Crash-safe post-processing: `runPostProcessing` atomic `"[]"` claim `service.ts:430-445`; per-prompt heartbeat line 450-453; optimistic `_mergeOutputs` lines 462-500; manual `runOnePostProcessing` line 506 throws `"POST_PROCESSING_IN_FLIGHT: the automatic post-processing run is still in progress; its results will appear shortly."` while a fresh claim exists.
- Client timeouts: `src/exulu/recall/client.ts:40-41` — `API_TIMEOUT_MS = 60_000`, `DOWNLOAD_TIMEOUT_MS = 300_000`; `retry_on_reject` opt-in for idempotent GETs only.
- Tests shipped: `src/exulu/recall/service.test.ts` (878 lines added), `client.test.ts`.
- Job status vocabulary (for prose): `queued` → `transcribing` → `awaiting_review`; terminal `failed` / `cancelled`. Source tag `source: "recall"`.

### C) Skill upload/download UI

Create dialog: `/Users/daniel.claessen/Desktop/Projects/exulu/frontend/app/(application)/skills/components/create-skill-dialog.tsx`
- Title: "New skill" with `Sparkles className="size-5 text-primary"`; description: "Create a skill package. You'll be taken to the editor where you can add files and scripts."
- Mode tabs (`TabsList className="grid w-full grid-cols-2"`): "Create blank" (Plus icon) / "Create from upload" (Upload icon).
- Upload section label: "Skill bundle" (`create.bundleLabel`).
- Dropzone 1 (lines 305-310): label "Drag & drop or click to choose", hint ".zip (full skill folder) or single .md file", `accept={[".zip", ".md", ".skill"]}`.
- Dropzone 2 (lines 311-316, `directory`): label "Or drop / pick a skill folder", hint "Folder must contain a SKILL.md at its root".
- Selected-file chip (lines 281-302): `flex items-center gap-3 rounded-md border bg-muted/30 p-3`, `FileArchive className="size-6 shrink-0 text-primary"`, filename + "{size} KB", ghost button "Choose a different file".
- Frontmatter prefill: `.zip`/`.skill` → `readSkillMetaFromZip` (lines 124-136); folder → after client zip (lines 152-154); fills only empty Name/Description (`setName((prev) => prev || meta.name || ...)`).
- Footer: "Create & open" (Plus icon); busy: "Uploading…" / "Creating…"; errors: "Only .zip and .md files are supported" (note: this toast copy predates `.skill` and doesn't mention it), "Name is required", "Choose a .zip or .md file to upload".

Dropzone primitive: `/Users/daniel.claessen/Desktop/Projects/exulu/frontend/components/primitives/dropzone.tsx`
- Zone is a single `<button>` — classes (line 181-188): `flex min-h-24 w-full flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-border bg-transparent px-4 py-6 text-center transition-colors duration-150`, hover `hover:border-muted-foreground/50 hover:bg-muted/40`, drag-active `border-primary bg-primary/5`.
- `Upload className="size-5 text-muted-foreground"` icon, label `text-sm font-medium text-foreground`, hint `text-xs text-muted-foreground`.
- `directory` prop (line 41-42): `webkitdirectory` input + recursive `readDropEntries` drag-drop traversal (lines 46-97).

Bundle util: `/Users/daniel.claessen/Desktop/Projects/exulu/frontend/lib/skills/bundle.ts`
- fflate `zipSync(tree, { level: 6 })` (line 79); limits `MAX_TOTAL_BYTES = 50 MB`, `MAX_ENTRIES = 500` (lines 5-6); junk filter `.DS_Store`/`Thumbs.db`/`desktop.ini`/`__MACOSX/`/`.git` (lines 8-13); validation errors: "Folder is empty.", "Too many files ({n} > 500).", "Folder exceeds 50 MB uncompressed.", "Folder must contain a SKILL.md at its root." (lines 55-70); frontmatter parser lines 15-30.

Export menu: `/Users/daniel.claessen/Desktop/Projects/exulu/frontend/app/(application)/skills/components/skill-detail-panel.tsx:269-302` (header overflow menu)
- "Download as .zip" (Download icon) → `skillsApi.download(id, version)` → file `<safe-name>-v<version>.zip`; label swaps to "Preparing download…" while busy.
- "Export as .skill" (FileArchive icon) → `skillsApi.download(id, version, "skill")` → file `<safe-name>.skill` (lines 234-258).
- Also present but OUT OF SCOPE for this page: "Copy install prompt" (writes `Install the Exulu skill "<name>"`), "Copy ID" — covered by 2026-07-13-connect-your-agent.
- Toasts: "Skill download started" / "Couldn't download skill".
- API: `/Users/daniel.claessen/Desktop/Projects/exulu/frontend/lib/api/skills.ts:25` — `download(skillId, version?, format?: "zip" | "skill")` → `GET {base}/skills/{id}/download?version=&format=`.
- Library page chrome: title "Skills", button "New skill", description "Reusable skill packages your agents can load." (`messages/en.json` → `skills.*`).

### D) Chat formatted copy/download

Actions row: `/Users/daniel.claessen/Desktop/Projects/exulu/frontend/components/message-renderer.tsx`
- Copy action (lines 1239-1257): `MessageAction` label "Copy", `CopyIcon className="size-3"`; calls `copyMessageFormatted(messageMarkdown(message))`.
  - Success toast: "Copied message" — description "Formatted copy — paste into email or WhatsApp." (rich) or "The message was copied as text." (plain fallback).
  - Error toast: "Copy failed" — "Clipboard is not available in this browser."
- Download action (lines 1276-1290): `MessageAction` label "Download", `DownloadIcon className="size-3"`, now a `DropdownMenu` (`align="start"`) with items **"Formatted (HTML)"** and **"Markdown"**; files `message-<timestamp>.html` / `.md`; toast "Downloaded message" — "The message was downloaded as a formatted HTML file." / "…as a Markdown file."
- Hover-reveal fix: actions row gains `[@media(hover:hover)_and_(pointer:fine)]:has-[[data-state=open]]:opacity-100` so the row stays visible while the Download menu is open.
- Only `text` parts are exported (`messageMarkdown`, ~line 57) — reasoning/tool parts excluded.

Export lib: `/Users/daniel.claessen/Desktop/Projects/exulu/frontend/lib/export/message-export.ts` (453 lines, tested in `message-export.test.ts`)
- `markdownToWhatsAppText` (line 225): `**bold**`→`*bold*`, `_italic_`, `~~strike~~`→`~strike~`, `` `code` `` kept, headings → whole line bold (`*Heading*`), links → "text (url)" (bare URLs left as-is), images → URL, tables → column-padded monospace inside ``` fences (lines 151-175), `---` → `"----------"`, task-list checkboxes → `[x]` / `[ ]`.
- `markdownToClipboardHtml` (line 366): remark-gfm → rehype with inline styles only (`TAG_STYLES`, lines 246-267; link color `#7033ff` — product primary); root font stack `-apple-system, …` at 15px/1.55 (`ROOT_STYLE`).
- URL allow-list `SAFE_PROTOCOLS = {http, https, mailto, tel}` (line 322, `sanitizeUrlProperties`).
- `buildMessageHtmlDocument` (line 389): standalone `<!doctype html>` doc, `<title>Chat message</title>`, body `max-width:720px` centered.
- `copyMessageFormatted` (line 420): `ClipboardItem` with `text/html` + `text/plain`; returns "rich" | "plain"; degrades to `writeText` when rich write is rejected.
- Spec: `docs/superpowers/specs/2026-07-21-chat-copy-download-formatting-design.md` (frontend repo).

---

## Developer surfaces

- A: none public. Internal GraphQL mutation `runTranscriptPostProcessing` reused; nothing new exposed.
- B: none public. `/recall/webhooks` already existed (Recall-facing, signature-verified); the reconcile loop is internal. No new env vars, no API changes.
- C: borderline — the app REST endpoint `GET /skills/{id}/download` gained a `format=skill` query param (frontend `lib/api/skills.ts:25-33`), and uploads accept `.skill` staging keys. This is the app's own API, not a documented integration surface; do not present it as a developer feature.
- D: none. Pure client-side (`lib/export/message-export.ts`); the only deps added are unified/remark/rehype packages.

---

## Demo-worthy moments

### A — recover a lost meeting summary
1. Transcripts page → a meeting row ("Meeting recording") in "Awaiting review" → click "Review".
2. Review sheet's "Post-processing" section shows a card: prompt name + "Not run yet." + **Run** button.
3. Click Run → spinner on the button ("Run" with Loader2) → toast "Prompt re-run".
4. Card flips into a result card with the generated summary and a "Re-run" button.
(Alt beat: "Running…" line while the automatic run is in flight, resolving into result cards via the 5 s poll.)

### B — no UI; prose or abstract animation only
1. Timeline graphic: webhook event → server ACKs 200 → crash → event never redelivered → job stuck at "Recording finished".
2. Reconcile loop ticks (60 s) → asks Recall for the bot's real state → re-drives the same handlers → job lands in "Awaiting review".
3. Guard beats worth a caption each: never transcribes a live call; gives up with a clear error after 24 h; LLM post-processing can't double-spend.

### C — drag a skill folder in, get a skill out
1. Skills page → "New skill" → tab "Create from upload".
2. Drag a skill folder onto "Or drop / pick a skill folder" (zone border flips to `border-primary bg-primary/5`).
3. Chip appears (`my-skill.zip`, size) and Name/Description prefill themselves from SKILL.md frontmatter.
4. "Create & open" → editor opens with the full folder contents.
5. Coda: back on a skill's detail panel, overflow menu → "Export as .skill" → file downloads.

### D — copy once, paste anywhere
1. Hover an assistant message with headings, bold, a list and a table → actions row appears → click Copy.
2. Toast: "Copied message — Formatted copy — paste into email or WhatsApp."
3. Split-screen paste: email compose shows styled headings/table; WhatsApp shows `*bold*`, `_italic_`, tidy monospace table.
4. Download menu beat: DownloadIcon → "Formatted (HTML)" → a clean standalone page opens.

---

## Flags / requirements

- A + B require Recall.ai to be configured on the backend (`recallEnabled()`, backend `src/exulu/recall/env.ts`); the reconcile loop only starts then (`src/exulu/app/index.ts:474-477`). Frontend shows the meeting mode only when `config.recall.enabled` (`app/(application)/transcriptions/page.tsx:86-100`). Post-processing additionally needs prompt-library entries and at least one agent.
- A is frontend-only but depends on B's backend semantics (the `"[]"` claim + 30-min staleness) — ship notes should treat A+B as one story told from two sides.
- B: NOTE from memory/repo state — the recall-webhook-recovery work was merged locally (backend develop, frontend main) but NOT pushed as of 2026-07-22, and UAT is still open. Verify push/UAT status before announcing.
- C: no feature flag; available to anyone who can create skills. `SKILLS_RBAC_TEAMS_SUPPORTED` only affects the access-mode picker, not upload/download. The "unsupportedFile" toast copy still says "Only .zip and .md files are supported" (doesn't mention `.skill`) — avoid quoting it as a format hint.
- D: no flag. Rich clipboard needs `ClipboardItem` support (Safari/Chrome fine); otherwise it silently degrades to WhatsApp-flavored plain text — the toast wording tells you which happened. Reasoning text is intentionally no longer copied; that's a behavior change worth one sentence.
- Branding note for demo reconstruction: exported-HTML links use the product primary `#7033ff`; page design itself should follow the petrol/teal brand direction, not violet.
