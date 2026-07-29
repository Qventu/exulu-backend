# Manual `/compact` trigger — design

Date: 2026-07-26
Status: Design approved, ready for implementation
Scope: Frontend only (Exulu web). No backend changes.

## Goal

Give users a way to manually trigger conversation compaction from the chat UI, alongside the existing automatic trigger (context window near max) surfaced through `ContextBanner`. Two entry points:

1. **Composer slash command:** `/compact [optional steer]` typed in the chat input.
2. **AttachMenu (`+`) entry:** a "Compact conversation" item that opens `ContextBanner` in a new *manual mode* with the steer input pre-opened.

Both entry points reuse the already-wired `controller.compactConversation(steer?)` from `app/(application)/chat/hooks.ts`, which POSTs to the backend's `POST {agent.slug.replace(/\/run$/, "/compact")}/:agentId` route implemented in `backend/src/exulu/routes.ts:1330` via `compactSession` in `backend/src/exulu/compact-session.ts`.

## Non-goals

- No backend changes. The compaction endpoint, streaming lock (409), model override, `steer` support, and `COMPACTION_INSUFFICIENT` (422) semantics are all in place.
- No confirmation dialog. Both triggers are explicit user actions; the existing "Conversation compacted" divider + meter drop is enough visual confirmation.
- No general slash-command framework. We ship exactly one command in v1; the `kind: "command"` suggestion type keeps the door open without any framework build-out.
- No changes to auto-compaction, `contextGuard` in-flight microcompaction, or the warn/block banner behavior itself.

---

## Section 1 — Slash command

### Suggestion model

The composer's inline autocomplete (`app/(application)/chat/components/composer-autocomplete/`) already supports `kind: "tool" | "skill" | "file"`. Add a fourth kind:

```ts
kind: "tool" | "skill" | "file" | "command"
```

Static command registry (v1):

```ts
const COMMANDS: Suggestion[] = [
  {
    id: "cmd:compact",
    kind: "command",
    name: "compact",
    displayName: "compact",
    description: "Summarize earlier messages to free context",
  },
];
```

### Menu rendering

- Command rows render at the **top** of the `/` menu with a subtle divider separating them from tools/skills.
- Icon: `Archive` (same as the ContextBanner's compact button).
- Guest mode: commands are omitted (the composer already hides `AttachMenu` in guest mode, and the compact endpoint is not accessible for guests).

### Trigger keep-alive

Currently `slashEnabled = tools.length > 0 || skills.length > 0`. Extend to include commands so `/` is available even on agents with zero tools and skills:

```ts
const slashEnabled = tools.length + skills.length + commands.length > 0;
```

### Filter tweak (`matching.ts`)

`filterSuggestions` uses case-insensitive substring matching. That drops commands as soon as the user types args: query `compact focus on X` doesn't substring-match "compact" alone, so the row disappears, `isAutoHidden` fires, and the menu closes.

Add one rule at the top of `filterSuggestions`:

- For entries with `kind === "command"`, if the trimmed lowercased query starts with `<name>` followed by whitespace or end-of-string, always include the row and rank it first.
- Everything else keeps existing behavior.

Args are ignored for suggestion display — they're preserved verbatim in `trigger.query` for the executor.

### Two execution paths

**Path A — menu selection** (Enter/Tab/click on the compact row):

- `applySuggestion` grows a branch for `kind: "command"`. Instead of inserting text, it calls `onExecuteCommand(command, args)` where `args = trigger.query` with the leading command name stripped and trimmed. Empty query → no steer.
- Menu closes via the existing sticky-escape mechanism (`setEscapedKey`).

**Path B — submit interception**:

- `Composer.submit()` first calls a pure helper `parseCompactInput(input): { isCompact: true, steer?: string } | { isCompact: false }` living in `matching.ts` (pure module, node-testable — same rule as the rest of the autocomplete logic).
- The helper matches trimmed input against `^\/compact(?:\s+([\s\S]*))?$` and returns `{ isCompact: true, steer }` with the captured group trimmed (or `undefined` when empty).
- Match → call the executor with `steer`, clear the input, do **not** call `controller.sendUserMessage`.
- No match → existing send path.

Both paths funnel through a single executor:

```ts
async function executeCompactCommand(steer?: string) {
  const cleaned = steer?.trim() || undefined;
  const ok = await controller.compactConversation(cleaned);
  if (ok) toast.success(t("chat.commands.compact.successToast"));
}
```

Failure surfaces via the existing `setError` path inside `compactConversation` (which already handles `COMPACTION_INSUFFICIENT` → `t("context.insufficientError")`).

### Gating

Same rules as the ContextBanner path:

- No-op when `session.id === "new"`, `status === "streaming" || "submitted"`, or `compacting === true` — `compactConversation` already short-circuits these; UI just doesn't fire the toast on a false return.
- On `COMPACTION_INSUFFICIENT`, existing error surface fires; the composer input is cleared (unlike normal send failures we don't try to restore it, since `/compact` isn't user prose worth preserving).

### Ownership

Command registry is a module constant inside `use-composer-autocomplete.ts` (v1). If we ever grow a second command, promote it to its own module — but not before.

---

## Section 2 — AttachMenu (`+`) entry + ContextBanner manual mode

### AttachMenu entry

Add a fifth `MenuEntry` in `attach-menu.tsx`, placed after "Skills & tools":

- Icon: `Archive`
- Label: "Compact conversation" (`t("chat.attach.compact")`)
- Description: "Summarize earlier messages to free context" (`t("chat.attach.compactDescription")`)
- Disabled subtitle swap (`t("chat.attach.compactDisabled")`) when disabled — follows the existing "Session files" pattern

**Disabled when:**
- Session is `new` (nothing to compact yet)
- `status === "streaming" || "submitted"` (would 409)
- `compacting === true` (already running)

On select: `select(() => onCompactRequest())`. `onCompactRequest` is a new required prop wired from `composer.tsx`.

### Composer wiring

New composer-local state:

```ts
const [manualCompactOpen, setManualCompactOpen] = useState(false);
```

Pass through:

```tsx
<AttachMenu
  ...existing...
  onCompactRequest={() => setManualCompactOpen(true)}
/>
<ContextBanner
  controller={controller}
  manualOpen={manualCompactOpen}
  onCloseManual={() => setManualCompactOpen(false)}
/>
```

### ContextBanner extension

New optional props on `ContextBanner`:

- `manualOpen?: boolean` (default false)
- `onCloseManual?: () => void`

**Render condition:**

```ts
if ((contextState === "ok" && !manualOpen) || !session || session.id === "new") return null;
```

**Copy modes:**

- Warn / blocked (existing): unchanged. Amber tones, `TriangleAlert`, existing i18n keys.
- **Manual** (`manualOpen && contextState === "ok"`): neutral tones. Border `border-border`, background `bg-muted/30`, `Archive` icon (not `TriangleAlert`), title `t("chat.context.manualTitle")` = "Compact conversation", body `t("chat.context.manualBody")` = "Summarize earlier messages into a checkpoint to free context. Older messages stay in your history; the model will only see the summary."
- Manual mode opens the steer input by default (skip the "Add focus" toggle click).
- Close button (`X`, aria `t("chat.context.manualClose")`) always visible in manual mode; calls `onCloseManual`.

**Precedence:** if `contextState !== "ok"` AND `manualOpen` are both true, warn/blocked copy wins. The close (`X`) still only clears `manualOpen`; the warn state is dismissed by its own logic.

**On successful compact:** existing behavior (checkpoint appended → meter drops → "Conversation compacted" divider renders in `message-renderer.tsx`). Additionally clear `manualOpen` via `onCloseManual` inside the banner's existing `onCompact` handler.

---

## Files changed (frontend only)

- `app/(application)/chat/components/composer-autocomplete/matching.ts` — command-prefix filter rule; type update.
- `app/(application)/chat/components/composer-autocomplete/use-composer-autocomplete.ts` — inject `COMMANDS`; `applySuggestion` branch for `kind: "command"`; expose `onExecuteCommand` prop.
- `app/(application)/chat/components/composer-autocomplete/autocomplete-menu.tsx` — render command rows with divider + `Archive` icon.
- `app/(application)/chat/components/composer.tsx` — submit-time regex interception; `manualCompactOpen` state; `executeCompactCommand` helper; wire `AttachMenu.onCompactRequest`; pass banner props.
- `app/(application)/chat/components/attach-menu.tsx` — new `onCompactRequest` prop; new "Compact conversation" `MenuEntry`; disabled logic.
- `app/(application)/chat/components/context-banner.tsx` — accept `manualOpen` / `onCloseManual`; manual-mode branch (neutral tones, `Archive` icon, close button, steer open by default).
- `messages/en.json`, `messages/de.json` — new keys: `chat.commands.compact.label`, `.description`, `.successToast`; `chat.attach.compact`, `.compactDescription`, `.compactDisabled`; `chat.context.manualTitle`, `.manualBody`, `.manualClose`.
- `app/(application)/chat/components/composer-autocomplete/matching.test.ts` — filter-rule tests; `parseCompactInput` regex tests.

## Files unchanged

- `backend/src/exulu/compact-session.ts`
- `backend/src/exulu/routes.ts` (compact route)
- `backend/src/exulu/context-guard.ts` / `context-budget.ts`
- `app/(application)/chat/hooks.ts` — `compactConversation` is already the right shape.

## Testing

**Unit** (`matching.test.ts`)
- Command-name prefix rule: `filterSuggestions([compactCmd], "compact")` → compact returned first; same for `"compact "`, `"compact focus on X"`; not for `"compactx"` (must be word-boundary followed by whitespace or end).
- `parseCompactInput`:
  - `"/compact"` → `{ isCompact: true, steer: undefined }`
  - `"/compact "` → `{ isCompact: true, steer: undefined }`
  - `"/compact focus on X"` → `{ isCompact: true, steer: "focus on X" }`
  - `"hey /compact"` → `{ isCompact: false }`
  - `"/compactx"` → `{ isCompact: false }`

**Manual smoke** (agent with tools + skills, non-guest)
- Type `/` in composer → menu shows `compact` at top with divider, tools/skills below.
- Type `/compact` + Enter → runs, no steer, success toast + divider appears.
- Type `/compact focus on the deploy` + Enter → runs with steer, divider shows summary reflecting focus.
- Type `/` and select `compact` from menu with mouse click → runs, no steer.
- With session at 85% context: banner shows warn state; `/compact` also works — same result.
- With session `new`: `/compact` no-ops (silently); menu still shows the row (discoverability > strict enforcement — the executor gates).
- While streaming: `/compact` no-ops.
- Click `+` → "Compact conversation" entry → banner opens in manual mode (neutral, steer input open, X visible).
- Enter steer in banner → click Compact → runs; banner closes.
- Click X on manual banner → banner closes without running.
- Agent with zero tools + skills: `/` menu still appears with just the compact command.
- Guest mode (`/public/agents/[id]`): no `+` menu, no `/` command surfacing.

## Alternatives considered (rejected)

- **Confirmation dialog before compacting.** Matches the ContextBanner's zero-friction one-click flow; user's explicit action is signal enough.
- **Two overlays (dedicated compact sheet vs banner).** Adds surface area, inconsistent copy with the auto-compact path.
- **Generic slash-command registry** (`/clear`, `/help`, `/reset`, etc.). Premature — v1 ships exactly one command. The `kind: "command"` type is the extension point when a second one lands.
- **Menu selection opens the banner steer input instead of running.** Rejected on user preference: menu selection executes immediately, trailing text is the steer channel.
