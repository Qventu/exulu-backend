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
- **No coupling into `generateSync`.** The dedicated route uses `generateObject` directly rather than threading structured-output through the agent-run path.
- **No per-agent suggestion prompt override.** Phase 1 ships a single fixed prompt, owned by the backend.
- **No system-wide suggestion-model override.** Phase 1 always uses the agent's own model. (Reserved for phase 2 as a `default_for_suggestions` flag on the `models` table.)
- **No persistence.** Suggestions live in frontend `useState` only; reloading a session does not restore them. No session is loaded or written by the suggestions route.
- **No auto-send on click.** Suggestions populate the input; the user presses send.
- **No tool/skill resolution.** The dedicated route calls `generateObject` without tools — suggestion generation is structured-output only.

## Decisions

| Topic | Decision |
|---|---|
| When to generate | After assistant `onFinish`, with both the user message and the assistant reply in the context. |
| Click behaviour | Fill input only; user presses send. |
| Persistence | Ephemeral. `useState` on the chat component, cleared when a new user message is submitted. The suggestions route is stateless — no session loaded or written. |
| Suggestion prompt | Fixed constant, owned by the backend (`src/exulu/suggestions.ts`). |
| Model | Always `agent.model` (same as the main chat). |
| Backend integration | Dedicated route `POST /agents/suggestions/:agentId` that calls `generateObject` directly. Not coupled into `generateSync`/`generateStream`. |
| Token accounting | Counts toward agent rate limits + statistics via the same `recordAgentTokenUsage` + `updateStatistic` helpers as the agent-run route. |
| Toggle authority | Frontend short-circuits when disabled (no request fired). Backend route also rejects requests for agents that don't have it enabled. |
| Number of suggestions | Capped at 3 via `.max(3)` in the Zod schema; backend additionally slices to 3 defensively. |
| Abort behaviour | New user submit aborts an in-flight suggestion fetch; suggestions also clear on unmount. |

## Architecture

### Data flow

```
Assistant message finishes (useChat status → "ready")
    └── effect in chat.tsx fires (only if agent.suggestions_enabled === true)
            └── fetch POST {backend}/agents/suggestions/{agent.id}
                  headers: Authorization, User
                  body: { messages: [lastUser, lastAssistant] }
                    └── routes.ts handler:
                          - load agent, check suggestions_enabled
                          - authenticate, RBAC read access, API key scope
                          - pre-check rate limits
                          - resolveModel(agent.model)
                          - generateSuggestions({ languageModel, messages, agentInstructions })
                                └── generateObject({ schema: { suggestions: string[].max(3) } })
                          - updateStatistic + recordAgentTokenUsage
                  response: { suggestions: string[] }
            └── setSuggestions(response.suggestions.slice(0, 3))
                  └── render 3 buttons above textarea
                        └── click → setInput(suggestion); inputRef.current.focus()
```

### File map

**New files:**

| File | Purpose |
|---|---|
| `backend/src/exulu/suggestions.ts` | `generateSuggestions()` helper: owns the fixed system prompt and the Zod schema; calls `generateObject` directly. |

**Modified files:**

| File | Change |
|---|---|
| `backend/src/postgres/core-schema.ts` | Add `suggestions_enabled: boolean` to `agentsSchema`. Existing `addMissingFields` infra adds the column on next boot. |
| `backend/src/exulu/routes.ts` | Register `POST /agents/suggestions/:agentId`. Mirrors the auth / RBAC / rate-limit / stats wiring used by the agent-run route. |
| `frontend/app/(application)/agents/edit/[id]/form.tsx` | Add `suggestions_enabled` to `agentFormSchema`; add a `<FormField name="suggestions_enabled">` Switch in the feedback/UI section, modeled on the existing `feedback` toggle (form.tsx:1167-1188); thread the value through the update mutation. |
| `frontend/app/(application)/chat/[agent]/[session]/chat.tsx` | Add suggestion state, effect, fetch, abort handling, and render the suggestion button row above the textarea. |
| `frontend/types/models/agent.ts` (or equivalent shared type) | Add optional `suggestions_enabled?: boolean` field. |
| GraphQL queries/mutations for agents (`@/queries/queries` — exact file resolved at impl) | Include `suggestions_enabled` in `GET_AGENT_BY_ID` and `UPDATE_AGENT_BY_ID`. |

## Schema change

`backend/src/postgres/core-schema.ts` — extend `agentsSchema.fields`:

```ts
{
  name: "suggestions_enabled",
  type: "boolean",
  default: false,
}
```

No explicit migration block is needed — the existing `addMissingFields` mechanism in `init-db.ts:35-62` iterates `agentsSchema.fields` on boot and adds any missing columns via `hasColumn` + `alterTable` + `mapType`. Adding the field to the schema alone is sufficient. `DEFAULT false` covers existing rows.

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

## Backend: suggestions helper + route

### `backend/src/exulu/suggestions.ts` (new file)

Owns the fixed system prompt and the Zod schema. Exposes a single `generateSuggestions()` function that takes a resolved `LanguageModel`, the messages array, and optional agent instructions. Internally calls `generateObject` with `temperature: 0`, the schema `z.object({ suggestions: z.array(z.string()).max(3) })`, and the system prompt concatenated with the agent's instructions (so suggestions stay topical to the agent's purpose).

Returns `{ suggestions: string[]; usage: { inputTokens, outputTokens } }`.

`generateObject` (not `generateText` + `Output.object`) is used because it enforces JSON mode at the provider level — avoids the `AI_NoObjectGeneratedError: could not parse the response` failure mode that occurs when models wrap output in markdown or add preamble text.

### `POST /agents/suggestions/:agentId` (in `routes.ts`)

Registered in the main routes-setup function, alongside (but separate from) the per-provider agent-run handlers. Steps:

1. Load agent by id. 404 if missing.
2. Reject with 400 if `agent.suggestions_enabled !== true` (defence-in-depth — frontend short-circuits too).
3. Authenticate the request. Allow unauthenticated only when `agent.rights_mode === "public"`.
4. API key scope check.
5. RBAC: require `read` access on the agent.
6. Rate-limit pre-check via `preCheckAgentRateLimit` using `agent.rate_limits` (when entitled).
7. Validate `req.body.messages` is a non-empty array of UIMessages.
8. Resolve `agent.model` via `resolveModel` (same path as agent-run; surfaces forbidden/missing-model errors as 403/400).
9. Call `generateSuggestions({ languageModel, messages, agentInstructions: agent.instructions })`.
10. Emit stats (`updateStatistic` for count + token usage) and record rate-limit consumption (`recordAgentTokenUsage`).
11. Return `{ suggestions: string[] }` with status 200.

On any thrown error from `generateSuggestions`, log it and return 500 with a generic detail. The frontend treats this as a silent failure.

## Frontend: chat surface

In `frontend/app/(application)/chat/[agent]/[session]/chat.tsx`:

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
  const lastAssistant = messages[messages.length - 1];
  if (lastAssistant.role !== "assistant") return;
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  if (!lastUser) return;

  // Abort any prior in-flight suggestion fetch (defensive — the submit handler also aborts).
  suggestionAbortRef.current?.abort();
  const ctrl = new AbortController();
  suggestionAbortRef.current = ctrl;

  (async () => {
    try {
      const token = await getToken();
      if (!token) return;

      const res = await fetch(`${configContext?.backend}/agents/suggestions/${agent.id}`, {
        method: "POST",
        signal: ctrl.signal,
        headers: {
          "Content-Type": "application/json",
          User: user.id,
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          messages: [lastUser, lastAssistant],
        }),
      });
      if (!res.ok) return; // silent failure — feature is best-effort
      const data = await res.json();
      const arr = Array.isArray(data?.suggestions) ? data.suggestions : [];
      setSuggestions(arr.slice(0, 3).map(String));
    } catch {
      // Aborted or network error — silently drop. Suggestions are non-essential.
    }
  })();

  return () => ctrl.abort();
}, [
  status,
  messages.length,
  agent.suggestions_enabled,
  agent.id,
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

## Security and abuse

- The dedicated route uses the same authentication, RBAC (`read` access on the agent), API-key scope check, and rate-limit pre-check as the agent-run route. No new attack surface.
- The fixed suggestion prompt lives backend-side — clients cannot inject arbitrary system instructions into the suggestions pipeline.
- Suggestions count against the per-agent rate limit (`agent.rate_limits`). A misconfigured agent or pathological model could double agent traffic; this is acceptable for an opt-in feature.

## Failure modes

| Failure | User-visible behaviour |
|---|---|
| Model fails to produce schema-valid JSON | `generateObject` retries up to 3 times; if all retries fail it throws, route returns 500, frontend `res.ok === false`, suggestions silently absent. |
| Rate limit exceeded on suggestion call | Backend returns 429; frontend `res.ok === false`; suggestions silently absent. The next user turn is unaffected. |
| User refreshes the page | Suggestions disappear (ephemeral). |
| Agent's `model` is unset or unresolvable | Backend returns 400/403; frontend silently drops the suggestion. The main chat path also surfaces this error on the next normal send. |
| Agent's `suggestions_enabled` flipped off after frontend cached it | Backend returns 400 with "Suggestions are not enabled for this agent"; frontend silently drops. |
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
