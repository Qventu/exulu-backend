# Feature plan — Verifiable citations with source provenance

## Sources of truth

- Code (frontend commits `05b16be` 06-01 "deactivate referenced sources from
  feedback and citation preview", `d72ae0c` 06-01 CSP frame-src for PDF
  previews, `f1956c5` 06-16 ConfirmDialog flow, `900bf7d` 07-08 streaming perf):
  - `frontend/components/ai-elements/response.tsx` —
    `KnowledgeSourceCitationBadge` (lines 336–600), `WebSearchCitationBadge`
    (lines 203–333), the `cite-marker-knowledge-source` /
    `cite-marker-web-search` component mappings (lines 602–674)
  - `frontend/components/message-renderer.tsx:751–837` — regex-detects
    `{item_name: …, item_id: …, chunk_id: …, chunk_index: …, context: …}`
    blobs in assistant text and rewrites them into `<cite-marker-…>` tags
  - `frontend/components/primitives/confirm-dialog.tsx` — destructive confirm
  - Chat canvas: `frontend/components/ai-elements/message.tsx` (Message /
    MessageContent), `app/(application)/chat/components/message-column.tsx`
    (CHAT_COLUMN = `max-w-3xl`), `app/(application)/chat/components/composer.tsx`
    (form card line 512, send button 610–621, disclaimer 699–703)
- GraphQL: `GET_CHUNK_BY_ID(context)` and `UPDATE_ITEM(context)` in
  `frontend/queries/queries.ts:382–426` (snippet below)
- On-screen copy: **hardcoded in `response.tsx`** — there are NO i18n keys for
  the citation dialog. (`chat.feedbackDialog.deactivate*` in
  `frontend/messages/en.json` covers only the thumbs-down feedback path.)
  Composer strings from `chat.composer.*` (verbatim below).

## What shipped

Answers cite their sources, and the sources defend themselves. When retrieval
backs a claim, the model emits a citation blob inline; the renderer turns it
into a compact badge right where the claim is made (`Reports - Quarterly
Report.pdf #4`). Clicking the badge opens a provenance dialog that fetches the
chunk live (`{context}_itemsChunkById`): the exact retrieved chunk text, a
Field/Value metadata table (Source, Chunk #, Item ID, Item External ID,
Created at, Updated at), and — when the chunk came from a PDF
(`chunk_metadata.pdf` / `.document` + `.page`) — the source PDF embedded and
opened at the cited page (`iframe src="{presignedUrl}#page={page}"`). The PDF
preview resolves asynchronously (presigned URL) and replaces the chunk-text
zone once loaded. The same dialog carries a destructive **"Deactivate this
source"** action that archives the item globally (`UPDATE_ITEM` with
`archived: true`) behind a ConfirmDialog. Web-search citations get the sibling
treatment: a favicon + title + hostname badge opening a dialog with the quoted
snippet, an embedded page preview, and a Domain/Page table.

## Hook

**Every answer shows its work — down to the page.**

## Surface area

UI feature (chat conversation, assistant messages) + one real developer
surface (the context-scoped chunk-provenance GraphQL query the dialog itself
runs). One short on the knowledge-source badge → dialog → PDF-at-page moment;
web citations and the deactivate flow are page prose within this feature's
section.

## Short — `citations` (1920×1080, 9.4s)

One slice, ONE user action: clicking the citation badge in the answer. The
dialog opening, the chunk content rendering, and the PDF preview swapping in
are all reactive consequences of that single click (in the real product the
PDF presigned URL resolves asynchronously after the chunk query — the short
shows that authentic two-stage reveal).

### Demo arc (timed beats)

| t (s) | On screen | Why |
|---|---|---|
| 0.00–0.40 | Hook enters (fade + 12px rise): **"Every answer shows its work — down to the page."** on the #FDFDFD canvas with the house radial purple wash | Entrance |
| 0.40–2.30 | Hook holds still (1.9s) | ≥1.8s floor (9 words, full sentence) |
| 2.30–2.70 | Hook exits; chat canvas crossfades in: user bubble + assistant answer with the inline citation badge, composer card at the bottom | Pivot |
| 2.70–3.30 | Cursor glides to the badge; badge hover state (`hover:bg-secondary/80`) as cursor arrives | Approach, click affordance |
| 3.30–3.50 | Click → scrim dims (bg-black/80 fade), dialog zooms in (zoom-in-95 + fade, 200ms — the real shadcn `duration-200`) | The one action |
| 3.50–4.90 | Dialog state A holds still (1.4s): title "Quarterly report.pdf" ↗, the retrieved chunk text, the Field/Value metadata table, deactivate section at the bottom | Result holds ≥600ms before any layout change; chunk text is skimmable |
| 4.90–5.20 | PDF preview resolves: the chunk-text zone crossfades (300ms) into "Open the original PDF here." + the embedded PDF opened at page 4; metadata table and deactivate section keep their positions | Reactive second stage of the same click — the money shot |
| 5.20–6.60 | State B holds completely still (1.4s) | ≥600ms hold; PDF page registers |
| 6.60–7.00 | Payoff caption enters (white, centered below the dialog, over the scrim): **"The exact chunk, the exact page — provenance in one click."** | Entrance |
| 7.00–9.40 | Payoff holds still (2.4s); last 600ms fully still = loop resting frame | ≥1.8s floor (10 words) + clean loop |

Motion: power2.out, 150–350ms, no bounce, no glow. Cursor is the standard
macOS-style pointer used in the 07-07/07-08 shorts.

## Reconstruction cues (build the real UI, verbatim)

**Framing.** Chat surface rendered as a centered card ~1120px wide on the
#FDFDFD canvas with the house radial purple wash (matches the 07-07/07-08
shorts). Inside the card the conversation column is `max-w-3xl` (768px,
CHAT_COLUMN — message-column.tsx) centered, composer card pinned at the
bottom. Inter, tracking -0.025em; borders #E7E7EE; radius ~6–8px.

**Conversation (message.tsx):**

- User bubble (right-aligned): `rounded-lg bg-secondary px-4 py-3` (#EDF1F5),
  `text-sm text-foreground`, `max-w-[95%] ml-auto`. Text:
  **"How did Q2 revenue develop?"**
- Assistant message: plain text on the canvas, no bubble
  (`is-assistant`, `text-sm text-foreground`). Text: **"Q2 revenue grew 14%
  quarter-over-quarter, driven by enterprise renewals."** followed inline by
  the citation badge.

**The citation badge (`KnowledgeSourceCitationBadge` trigger):** shadcn Badge
`variant="secondary"` — base `inline-flex items-center rounded-full border
px-2.5 py-0.5 text-xs` with `border-transparent bg-secondary
text-secondary-foreground` (#EDF1F5 pill), plus the component's
`mx-1 cursor-pointer items-center gap-1 font-normal hover:bg-secondary/80 m-1`.
Content: one span `max-w-[200px] truncate capitalize` reading
**"Reports - Quarterly Report.pdf"** (context `reports` with `_`→space, then
CSS-capitalized; item name is the filename) + a second span
`text-muted-foreground` reading **"#4"** (chunk_index+1). Tooltip/title attr:
`Source: Quarterly report.pdf (Chunk 4)`.

**The dialog (DialogContent):** `max-w-[900px] max-h-[80vh] overflow-y-auto`
on the shadcn base — centered, `grid w-full gap-4 border bg-background p-6
shadow-lg sm:rounded-lg`, X close button top-right (`absolute right-4 top-4`,
size-4 icon). Overlay: `fixed inset-0 bg-black/80`. Open animation:
fade + zoom-in-95, 200ms. For the short, size the dialog ~900×820px.

- **Header/title** (`text-lg font-semibold leading-none tracking-tight`):
  **"Quarterly report.pdf"** + `LinkIcon` (size-4) — hover underline; in the
  product it links to `/data/reports?item={itemId}` in a new tab.
- **State A content zone** (`text-sm`): the chunk text rendered as markdown.
  Use: **"Total revenue for Q2 reached $4.2M, up 14% quarter-over-quarter.
  Enterprise renewals contributed $1.1M of the increase, with net revenue
  retention at 118%."**
- **State B content zone** (replaces state A's text — they never show
  together): link line **"Open the original PDF here."** (`text-sm
  text-primary underline`, #7033FF) above the embedded PDF
  (`iframe src="{presignedUrl}#page=4"`, title "PDF viewer", inside a
  `max-h-[500px] overflow-y-auto` wrapper — render ~340px visible). Reconstruct
  the browser PDF viewer minimally: dark toolbar strip (#323639) with the file
  name **"Quarterly report.pdf"** left and page indicator **"4 / 12"** center,
  white page below showing a "Revenue" heading and the same cited paragraph —
  so the eye connects chunk → page.
- **Metadata table** (`w-full border-collapse border border-border text-xs
  text-muted-foreground mt-4`; header cells `px-4 py-2 text-left font-semibold
  border-b border-border bg-muted/50`): headers **"Field" / "Value"**; rows
  (all cells `px-4 py-2`, rows `border-b border-border`):
  1. **Source** — Quarterly report.pdf
  2. **Chunk #** — 4
  3. **Item ID** — 8f3c2a1e-4b6d-4f2a-9c0e-2d7b5a1c9e42
  4. **Item External ID** — reports/quarterly-report.pdf
  5. **Created at** — 7/1/2026, 9:14:03 AM
  6. **Updated at** — 7/1/2026, 9:14:03 AM
- **Deactivate section** (`border-t pt-4 mt-2 space-y-3`, may sit at the
  dialog's bottom edge — keep it visible): warning row `flex items-start gap-2
  text-xs text-muted-foreground` with `AlertTriangle` size-4 in amber-600
  (#D97706-adjacent) and the verbatim text **"Deactivating archives this item
  globally — it will no longer appear in any user's chat or search
  results."**; below it a small destructive button (`bg-destructive`, #E54B50,
  white text, size sm) labeled **"Deactivate this source"**. Do NOT click it
  in the short.

**Composer card** (bottom of the chat card; composer.tsx line 512): `<form
class="relative rounded-lg border bg-card p-2">`, row `flex items-end
gap-1.5`: ＋ attach ghost icon button, textarea placeholder **"Ask me
anything..."** (`bg-transparent px-2 py-2.5 md:text-sm
placeholder:text-muted-foreground`), mic ghost icon button, and the purple
send button — `size-9` icon button, `ArrowUp` size-5 icon, bg #7033FF, white
glyph (the only loud element besides the wash). Below the card:
**"AI can make mistakes. Check important info."** (`py-2 text-center text-xs
text-muted-foreground`).

**Loading nuance:** the real dialog flashes "Loading..." while the chunk query
runs and computes the PDF URL after. For the short, skip the loading flash
(dialog opens directly into state A) but keep the authentic A→B swap.

## Code snippet decision

**Yes — GraphQL.** The dialog's provenance fetch is a real, context-scoped
API surface any developer can call: `GET_CHUNK_BY_ID(context)` from
`frontend/queries/queries.ts:382`. Trimmed to the fields that drive the
dialog (real operation shape, `context` inlined as `reports`):

Anchor line: "The dialog runs the same provenance query you can:"

```graphql
query GetChunkByIdreports($id: ID!) {
  reports_itemsChunkById(id: $id) {
    chunk_content
    chunk_index
    chunk_metadata   # pdf + page drive the PDF-at-page preview
    item_id
    item_name
    item_external_id
  }
}
```

(10 lines; full field list also includes chunk_id, chunk_source, timestamps.)

## Page prose within this feature's section (beyond the video)

- **Deactivate a bad source from where you found it:** the same dialog carries
  "Deactivate this source" → ConfirmDialog (**"Deactivate this source?"** /
  **"This archives \"Quarterly report.pdf\" globally — it will no longer
  appear in any user's chat or search results."** / confirm **"Deactivate"**,
  destructive) → `UPDATE_ITEM(context)` with `archived: true` → toast
  **"Source deactivated"** / **"Quarterly report.pdf has been archived
  globally."** The thumbs-down feedback dialog lists the same cited items with
  per-item Deactivate buttons — that path is RBAC-gated in the UI
  (`canDeactivateSources`, `can(user, { area: "agents", level: "write" })`);
  on the citation dialog the button renders whenever the item is known and the
  archive mutation is enforced server-side by context rights.
- **Web citations too:** internet-search claims get a favicon + title +
  hostname badge (`{title} · {hostname}`); clicking opens the sibling dialog —
  the quoted snippet in a purple-edged blockquote (`border-l-4
  border-primary/30 bg-muted/30`, italic) with a copy button ("Copied to
  clipboard" / "The citation snippet has been copied."), the live page
  embedded, and a Domain/Page metadata table.
- **How badges happen:** the model emits `{item_name, item_id, chunk_id,
  chunk_index, context}` blobs inline; `message-renderer.tsx` rewrites them
  into `<cite-marker-knowledge-source>` elements during markdown rendering —
  citations stay attached to the exact sentence they support, even mid-stream.

## Deviations from the brief (reality wins)

1. **Web citations are not numbered badges with hover cards.** They are
   favicon + title + hostname secondary badges that open a click-dialog
   (same Dialog pattern as knowledge sources). Prose above follows the code.
2. **Chunk text and PDF never display simultaneously.** The PDF preview
   replaces the chunk-text zone once the presigned URL resolves
   (`{preview ? preview : chunk_content}` — response.tsx:484). The short
   shows the real two-stage sequence off one click.
3. **RBAC gating is on the feedback-dialog path, not the citation dialog.**
   In `KnowledgeSourceCitationBadge` the Deactivate button renders whenever
   `itemId` exists; the frontend `can()` gate applies to the feedback dialog's
   deactivate rows, and the mutation is enforced server-side.
4. **No i18n keys for the citation dialog** — all dialog strings are
   hardcoded in `response.tsx`; copy them verbatim from this plan, not from
   `en.json`.
