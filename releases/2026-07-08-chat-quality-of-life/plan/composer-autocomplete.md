# Feature plan — Composer inline autocomplete (`/` tools & skills, `@` session files)

## Sources of truth

- Spec: `frontend/docs/superpowers/specs/2026-07-07-chat-input-autocomplete-design.md` (commit `ecbdb92`)
- Implementation plan: `frontend/docs/superpowers/plans/2026-07-07-chat-input-autocomplete.md` (`d29c009`)
- Code (commits `5f3a567`, `2c1d10d`, `72b0ca2`, `e564d10`, `f792e5b`, `944ec65`, all 07-07):
  - `frontend/app/(application)/chat/components/composer-autocomplete/`
    (matching.ts, use-composer-autocomplete.ts, autocomplete-menu.tsx, highlight-overlay.tsx)
  - Wired into `frontend/app/(application)/chat/components/composer.tsx` (form card line 512, textarea 535–567)
- On-screen copy: `frontend/messages/en.json` → `chat.composer.autocomplete.*` (verbatim below)

## What shipped

Power-user autocomplete in the chat composer. Typing `/` at a word start opens a
suggestion menu of the tools and skills available to the agent in this session;
typing `@` does the same for files in the session's file sandbox (only when the
agent has `sandbox_enabled`). Selecting inserts the **exact machine name** as
plain text (`/internet_search `, `@report.pdf `) — no side effects, no backend
changes; the agent interprets intent from the text. Recognized tokens render
with a subtle purple pill behind the text via a mirror overlay; editing a token
char-by-char simply drops the highlight when it stops matching. `3/4`,
`user@example.com` and URLs never trigger (word-start rule). Disabled tools show
greyed with a small "off" badge but stay selectable.

## Hook

**Type `/` — every tool and skill your agent has, one keystroke away.**

## Surface area

UI feature (chat composer, route `app/(application)/chat/[agent]/[session]`).
Recipe A: reconstruct the actual screen.

## Reconstruction cues (verbatim from the shipped code)

- **Composer card:** `<form class="relative rounded-lg border bg-card p-2">`. Inside,
  a row `flex items-end gap-1.5`: ＋ attach trigger (ghost icon button), the textarea
  wrapper `relative min-w-0 flex-1`, a mic ghost icon button (`Mic`, size-5,
  muted), and the send button — **the** purple accent: `size-9` icon button,
  `ArrowUp` icon, bg `#7033FF`, white glyph.
- **Textarea:** placeholder `Ask me anything...`, classes
  `max-h-40 w-full resize-none bg-transparent px-2 py-2.5 text-sm placeholder:text-muted-foreground`.
- **Menu:** mounted `absolute inset-x-0 bottom-full z-50 mb-2` inside the form card
  (full card width, floats above it). Listbox:
  `max-h-72 overflow-y-auto rounded-md border bg-popover p-1 text-popover-foreground shadow-md`.
  - Group headers: `px-2 py-1.5 text-xs font-medium text-muted-foreground` —
    exact strings `Tools`, `Skills`, `Session files`.
  - Rows: `flex items-center gap-2 rounded-sm px-2 py-1.5 text-sm`; active row
    `bg-accent text-accent-foreground` (#E2EBFF / #1E69DC). Leading icon `size-4
    text-muted-foreground`: Wrench (tool), Sparkles (skill), File (file).
    Display name is the machine name with `_`→space, CSS-capitalized (files not
    capitalized); description in `ml-2 text-xs text-muted-foreground`.
  - Disabled tool: row `opacity-60` + trailing badge
    `rounded-full border px-1.5 text-[10px] text-muted-foreground` with text `off`.
  - Empty/error strings: `No matches`, `No files in this session yet`,
    `Couldn't load session files`. ARIA list label: `Autocomplete suggestions`.
- **Token highlight:** span `-mx-0.5 rounded bg-primary/10 px-0.5` behind the
  token text (purple pill at 10% alpha, glyphs untouched — the overlay paints
  pills, the textarea paints text).
- **Real tool machine names** (backend `src/templates/tools/`):
  `agentic_context_search`, `internet_search` (display "Internet Search"),
  `image_generation`, `read_session_file`, `email`. Skills are user-defined
  bundles — use a neutral one like `release_notes` (display "release notes").
- Insertion appends a trailing space and returns focus to the textarea; menu
  closes on selection (fix `944ec65`).

## Short A — `composer-slash-autocomplete` (MARQUEE, 1920×1080, 9.5s)

One slice: type `/`, filter, select — the selection is the single user action
(the menu appearing is not an action). No `@` in this short.

| t (s) | What's on screen | Why |
|---|---|---|
| 0.0–0.4 | Hook enters (fade + 12px rise): **"Type / — tools and skills, inline"** | Entrance |
| 0.4–1.9 | Hook holds still (1.5s) | ≥1.4s floor (6 words) |
| 1.9–2.3 | Hook exits; composer card crossfades in, lower third of frame, placeholder "Ask me anything..." | Pivot |
| 2.3–2.8 | Composer sits still | Establish (0.5s) |
| 2.8–4.6 | Type-in (caret visible): `Check the rollout doc /` — when `/` lands (~3.6s) the menu pops above the card: header **Tools** with rows "Agentic context search", "Internet Search", "Image generation", "Read session file"; header **Skills** with "Release notes" | The moment begins; menu appear is reactive |
| 4.6–5.2 | Typing continues: `int` — list live-filters to "Internet Search" as the active row (`bg-accent`) | Live filtering beat |
| 5.2–5.5 | Enter → menu closes; text now reads `Check the rollout doc /internet_search ` with the purple pill highlight under `/internet_search` | The action lands |
| 5.5–6.2 | New state holds completely still (0.7s) | Breath after action |
| 6.2–6.6 | Payoff caption enters (upper area): **"Inserts the real tool name — highlighted inline."** | Entrance |
| 6.6–8.9 | Payoff holds still (2.3s) | ≥1.8s floor (7 words + em-dash reads as a sentence) |
| 8.9–9.5 | Resting frame — everything fully still (0.6s) | Clean loop |

Motion: power2.out, 150–350ms UI transitions, no bounce. Typing cadence
~40–60ms/char with natural jitter; menu appears in ≤200ms fade+4px rise.

## Prose for the page section (beyond the video)

- The `@` flavor: with a sandboxed agent, `@` lists the session's files and
  inserts the file name — reference an uploaded file mid-sentence without
  leaving the keyboard ("No files in this session yet" empty state on fresh
  sessions).
- Tokens are text, not magic: recognized names get the purple pill, edits
  degrade gracefully, `3/4` and `user@example.com` never trigger.
- Disabled tools stay visible (greyed, "off") so you can still reference them.

## Code snippet decision

**No snippet.** Pure UI affordance; the spec pins "no backend changes of any
kind". Selecting a suggestion produces plain message text — there is no new SDK
method, REST route, or GraphQL operation. Verified: nothing autocomplete-related
in `backend/src/index.ts`, `backend/src/exulu/routes.ts`, or
`frontend/queries/queries.ts` (the catalog lookups reuse the existing `tools`
resolver and `skillsPagination`).
