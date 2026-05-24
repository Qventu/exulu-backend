# Follow-up message suggestions

**Date:** 2026-05-24
**Status:** Approved (design)
**Scope:** Backend (`exulu/backend`) + Frontend (`exulu/frontend`)

## Problem

After an assistant reply, users often pause to think about what to ask next. A short list of likely follow-up prompts shortens that pause and guides less-experienced users through productive conversations with an agent.

## Goal

Add an opt-in per-agent "follow-up suggestions" feature. When enabled, after each assistant reply the chat UI shows up to 3 short suggested follow-up prompts. Clicking a suggestion fills the input (it does **not** auto-send), letting the user edit before sending.

## Non-goals

- **No streaming changes.** `generateStream` and the UI message stream are untouched.
- **No per-agent suggestion prompt override.** Phase 1 ships a single fixed prompt.
- **No system-wide suggestion-model override.** Phase 1 always uses the agent's own model. (Reserved for phase 2 as a `default_for_suggestions` flag on the `models` table.)
- **No persistence.** Suggestions live in frontend `useState` only; reloading a session does not restore them.
- **No backend route changes.** The existing `POST /<slug>/:instance` already supports `Stream: "false"` + `outputSchema` + `customInstructions`.
- **No auto-send on click.** Suggestions populate the input; the user presses send.
- **No tool-resolution skipping.** The suggestion call goes through the same tool/skill resolution as a regular sync call. (Phase 2 optimisation: a `suggestionsOnly: true` body flag that skips tool prep.)

## Decisions

| Topic | Decision |
|---|---|
| When to generate | After assistant `onFinish`, with both the user message and the assistant reply in the context. |
| Click behaviour | Fill input only; user presses send. |
| Persistence | Ephemeral. `useState` on the chat component, cleared when a new user message is submitted. |
| Suggestion prompt | Fixed constant, defined frontend-side in `chat.tsx`, sent in `customInstructions`. |
| Model | Always `agent.model` (same as the main chat). |
| Token accounting | Counts toward agent rate limits + statistics, via the existing `generateSync` flow. No special handling. |
| Toggle authority | Frontend short-circuits when disabled — no request is fired. Backend has no awareness of the toggle. |
| Number of suggestions | Capped at 3 via `maxItems: 3` in `outputSchema`. |
| Abort behaviour | New user submit aborts an in-flight suggestion fetch; suggestions also clear on unmount. |

## Architecture

### Data flow

```
Assistant message finishes (useChat status → "ready")
    └── effect in chat.tsx fires (only if agent.suggestions_enabled === true)
            └── fetch POST {backend}{agent.slug}/{agent.id}
                  headers: Stream: "false", Authorization, User, Session
                  body: { message, session, outputSchema, customInstructions }
                    └── routes.ts:543  (existing handler, no changes)
                          └── outputSchema → convertJsonSchemaToZod (existing)
                          └── provider.generateSync({ ..., outputSchema })  (existing)
                                └── generateText({ output: 'object', schema })
                                └── recordAgentTokenUsage (existing)
                                └── updateStatistic (existing)
                  response: { suggestions: string[] }
            └── setSuggestions(response.suggestions.slice(0, 3))
                  └── render 3 buttons above textarea
                        └── click → setInput(suggestion); inputRef.current.focus()
```

### File map

**New files:** none.

**Modified files:**

| File | Change |
|---|---|
| `backend/src/postgres/core-schema.ts` | Add `suggestions_enabled: boolean` to `agentsSchema`. |
| `backend/src/postgres/init-db.ts` | Add a column-existence-gated `ALTER TABLE agents ADD COLUMN suggestions_enabled boolean DEFAULT false` block. |
| `frontend/app/(application)/agents/edit/[id]/form.tsx` | Add `suggestions_enabled` to `agentFormSchema`; add a `<FormField name="suggestions_enabled">` Switch in the feedback/UI section, modeled on the existing `feedback` toggle (form.tsx:1167-1188); thread the value through the update mutation. |
| `frontend/app/(application)/chat/[agent]/[session]/chat.tsx` | Add suggestion state, effect, fetch, abort handling, and render the suggestion button row above the textarea. |
| `frontend/types/models/agent.ts` (or equivalent shared type) | Add optional `suggestions_enabled?: boolean` field. |
| GraphQL queries/mutations for agents (`@/queries/queries` — exact file resolved at impl) | Include `suggestions_enabled` in `GET_AGENT_BY_ID` and `UPDATE_AGENT_BY_ID`. |

No backend route changes. No new endpoint. No new shared types beyond the agent flag.

## Schema change

`backend/src/postgres/core-schema.ts` — extend `agentsSchema.fields`:

```ts
{
  name: "suggestions_enabled",
  type: "boolean",
  default: false,
}
```

`backend/src/postgres/init-db.ts` — add a one-time migration block, gated by `information_schema.columns`, matching the pattern in [[feedback_migrations_in_initdb]]:

```ts
// One-time data migration: add agents.suggestions_enabled column if it doesn't exist.
const hasSuggestionsEnabled = await trx
  .from("information_schema.columns")
  .where({ table_name: "agents", column_name: "suggestions_enabled" })
  .first();
if (!hasSuggestionsEnabled) {
  console.log("[EXULU] Adding agents.suggestions_enabled column.");
  await trx.schema.alterTable("agents", (t) => {
    t.boolean("suggestions_enabled").defaultTo(false);
  });
}
```

No backfill needed — `DEFAULT false` covers existing rows.

## Frontend: agent edit form

In `frontend/app/(application)/agents/edit/[id]/form.tsx`:

1. Extend `agentFormSchema` (line 189):

```ts
suggestions_enabled: z.boolean().optional(),
```

2. Add a `<FormField>` adjacent to the existing `feedback` toggle (form.tsx:1167-1188), copying the same `<FormItem className="flex flex-row items-center justify-between rounded-lg border p-4">` shell:

```tsx
<FormField
  control={agentForm.control}
  name="suggestions_enabled"
  render={({ field }) => (
    <FormItem className="flex flex-row items-center justify-between rounded-lg border p-4">
      <div className="space-y-0.5">
        <FormLabel className="text-base">Enable follow-up suggestions?</FormLabel>
        <FormDescription>
          When enabled, after each assistant reply the chat suggests up to 3 follow-up
          messages the user might want to send. Uses the agent's model. Suggestion
          tokens count toward this agent's rate limits and statistics.
        </FormDescription>
      </div>
      <FormControl>
        <Switch checked={field.value} onCheckedChange={field.onChange} />
      </FormControl>
    </FormItem>
  )}
/>
```

3. Form submit path already spreads form values into the `UPDATE_AGENT_BY_ID` mutation; the only requirement is that the GraphQL mutation and the agent-read query include `suggestions_enabled`.

## Frontend: chat surface

In `frontend/app/(application)/chat/[agent]/[session]/chat.tsx`:

### Constants (top of file)

```ts
const SUGGESTIONS_PROMPT =
  "Based on the conversation so far, suggest up to 3 short follow-up questions or " +
  "messages the user might want to send next. Each suggestion must be written from " +
  "the user's perspective (first person) and be 12 words or fewer. Return only " +
  "the suggestions in the structured output — no preamble, no numbering.";

const SUGGESTIONS_SCHEMA = {
  type: "object",
  properties: {
    suggestions: {
      type: "array",
      items: { type: "string" },
      maxItems: 3,
    },
  },
  required: ["suggestions"],
} as const;
```

### State

```ts
const [suggestions, setSuggestions] = useState<string[]>([]);
const suggestionAbortRef = useRef<AbortController | null>(null);
```

### Effect (runs after each assistant reply)

```ts
useEffect(() => {
  if (!agent.suggestions_enabled) return;
  if (status === "streaming" || status === "submitted") return;
  if (messages.length === 0) return;
  const last = messages[messages.length - 1];
  if (last.role !== "assistant") return;

  // Abort any prior in-flight suggestion fetch (defensive — the submit handler also aborts).
  suggestionAbortRef.current?.abort();
  const ctrl = new AbortController();
  suggestionAbortRef.current = ctrl;

  (async () => {
    try {
      const token = await getToken();
      if (!token) return;
      const session = currentSessionRef.current;
      if (!session) return;

      const res = await fetch(`${configContext?.backend}${agent.slug}/${agent.id}`, {
        method: "POST",
        signal: ctrl.signal,
        headers: {
          "Content-Type": "application/json",
          User: user.id,
          Session: session.id,
          Authorization: `Bearer ${token}`,
          Stream: "false",
        },
        body: JSON.stringify({
          message: last,
          session: session.id,
          outputSchema: SUGGESTIONS_SCHEMA,
          customInstructions: SUGGESTIONS_PROMPT,
        }),
      });
      if (!res.ok) return; // silent failure — feature is best-effort
      const data = await res.json();
      const arr = Array.isArray(data?.suggestions) ? data.suggestions : [];
      setSuggestions(arr.slice(0, 3).map(String));
    } catch (e) {
      // Aborted or network error — silently drop. Suggestions are non-essential.
    }
  })();

  return () => ctrl.abort();
  // Re-run on each new completed assistant message. messages.length is sufficient
  // because the effect is gated on the last message being an assistant in a ready state.
}, [
  status,
  messages.length,
  agent.suggestions_enabled,
  agent.id,
  agent.slug,
  configContext?.backend,
  user.id,
]);
```

### Clearing on new submit

In the existing `onSubmit` handler (chat.tsx:534-546), before `sendMessage(...)`, also:

```ts
suggestionAbortRef.current?.abort();
setSuggestions([]);
```

Same clear in the `onQuestionAnswer` path at chat.tsx:899-905.

### Render

Rendered **inside** the existing `{writeAccess && (` gate at chat.tsx:929 — directly inside that fragment, immediately before the `<form onSubmit={onSubmit}>` element. This ensures read-only viewers never see suggestions (no input to populate anyway). Only visible when there are suggestions and we are not currently streaming/submitting:

```tsx
{suggestions.length > 0 && status !== "streaming" && status !== "submitted" && (
  <div className="w-[850px] mx-auto flex flex-wrap gap-2 mb-2 px-1">
    {suggestions.map((s, i) => (
      <Button
        key={i}
        type="button"
        variant="outline"
        size="sm"
        className="h-auto py-1.5 px-3 text-xs text-left whitespace-normal"
        onClick={() => {
          setInput(s);
          inputRef.current?.focus();
        }}
      >
        {s}
      </Button>
    ))}
  </div>
)}
```

### Behaviour summary

- Toggle off → zero network traffic. Effect early-returns on first line.
- New assistant message arrives → effect re-runs, fetch fires, previous fetch (if any) is aborted, previous suggestions stay visible until the new ones replace them.
- User starts typing or submits → `onSubmit` aborts in-flight fetch and clears displayed suggestions.
- Suggestion click → input populated, textarea focused, suggestions remain visible until the user actually submits (lets the user pick a different one if they change their mind).
- Fetch fails (network, auth, model error, schema mismatch) → silent. No error toast, no console.error in production. Suggestions just don't appear.

## Backend: zero changes

Confirmed by inspection of `routes.ts:684-694` (outputSchema branch) and `routes.ts:888-932` (`generateSync` branch with outputSchema):

- `req.body.outputSchema` is parsed (string or object) and converted to a Zod schema via `convertJsonSchemaToZod`.
- `req.body.customInstructions` is appended to `agent.instructions` before being passed as `instructions` to `generateSync`.
- `generateSync` handles structured output via `generateText({ output: 'object', schema })` at provider.ts:283-558.
- Token usage is recorded via the existing `onTokenUsage` callback (routes.ts:920-928) which calls `recordAgentTokenUsage`.
- Statistics are emitted via the `statistics` arg (routes.ts:916-919) which `generateSync` already wires into `updateStatistic`.

No backend code needs to be written for phase 1.

## Security and abuse

- The suggestion endpoint is the same authenticated, RBAC-gated, rate-limited endpoint the chat already uses. No new attack surface.
- The fixed `customInstructions` prompt is shipped from the frontend. A motivated user could already craft an arbitrary `customInstructions` body when calling the chat API directly — this feature does not widen that surface.
- Suggestions count against the per-agent rate limit (`agent.rate_limits`) and the API-key scope check (routes.ts:606-610). A misconfigured agent or pathological model could double agent traffic; this is acceptable for an opt-in feature.

## Failure modes

| Failure | User-visible behaviour |
|---|---|
| Model returns malformed JSON despite the schema | Backend throws; frontend `res.ok === false`; suggestions silently absent. |
| Rate limit exceeded on suggestion call | Backend returns 429; frontend `res.ok === false`; suggestions silently absent. The next user turn is unaffected. |
| User refreshes the page | Suggestions disappear (ephemeral). |
| Agent's `model` is unset or unresolvable | Backend returns 400 (routes.ts:698-720); frontend silently drops the suggestion. The main chat path also surfaces this error on the next normal send. |
| Suggestion call still in-flight when user submits next message | Aborted in `onSubmit`; suggestions cleared. |
| Slow suggestion call | Stale suggestions remain hidden because `status === "streaming"` gates rendering; once the next reply finishes, the new fetch supersedes the old one (which has already been aborted). |

## Testing

Manual. No new unit tests — the backend path is exercised by existing chat tests, and the frontend behaviour is best validated visually.

### Manual test checklist

1. **Toggle off (default).** New agents have `suggestions_enabled = false`. Chat shows no suggestion row. Network tab shows no extra POST after assistant replies.
2. **Toggle on.** Enable the toggle in the agent edit form, save, refresh chat. Send a message → assistant replies → within ~1–2s a row of up to 3 buttons appears above the textarea.
3. **Click suggestion.** Click a button → textarea populated with the suggestion text → focus moves to textarea → suggestions remain visible. Edit and send normally.
4. **New send clears suggestions.** With suggestions visible, type and submit a new message. Suggestion row clears immediately, in-flight fetch (if any) is aborted (visible in devtools network panel).
5. **Multiple turns.** Run a 3-turn conversation. Each assistant message produces a fresh set; old ones are replaced.
6. **Abort on unmount.** Navigate away while a suggestion fetch is in flight. Network request shows as cancelled. No console errors.
7. **Toggle off mid-session.** Disable the toggle in another tab, refresh chat tab, confirm new replies no longer produce suggestions.
8. **Rate limit.** Configure tight `agent.rate_limits`, exhaust them. Suggestions silently fail; main chat shows normal rate-limit error.
9. **Model error.** Temporarily break the agent's model config. Suggestions silently fail; main chat path surfaces a clear error.
10. **Schema enforcement.** Suggestions array always contains at most 3 items, even when the model returns more.
11. **Empty suggestions.** If the model returns `{ suggestions: [] }`, the row is not rendered.
12. **Read-only agent.** A user with read-only RBAC on an agent never sees suggestions — the suggestion row sits inside the `writeAccess` gate alongside the textarea.
13. **Token accounting.** With suggestions on, confirm `agent_token_usage` and the agent's statistics counters increment for both the main reply and the suggestion call.

### Out-of-scope edge cases

- Internationalisation of the fixed prompt — phase 1 ships English only. The model usually mirrors the conversation language regardless.
- Adaptive `maxItems` — always 3.
- Tool-call only replies (assistant message ends with a tool call needing approval) — effect still fires; if the resulting suggestion text is awkward, future tuning of the prompt handles it.

## Rollout

- Single PR adds the schema field, init-db migration, agent form toggle, GraphQL field, and chat.tsx wiring.
- Default `suggestions_enabled = false` → zero behaviour change for existing agents in existing deployments.
- Enable per agent in the edit form. No env var, no deploy gate, no license check.
- No data migration risk.

## Phase 2 (not in this spec)

Documented here only to bound phase 1 scope:

- `default_for_suggestions: boolean` on `models` table for a system-wide cheaper/faster suggestion model.
- `suggestionsOnly: true` body flag on the agent-run route to skip tool/skill resolution for suggestion calls.
- Persistence of suggestions as message metadata so they survive reload.
- Per-agent override of the suggestion prompt.
- Auto-send variant behind a per-user or per-agent preference.
