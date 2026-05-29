# Personal system prompt

**Date:** 2026-05-29
**Status:** Approved (design)
**Scope:** Backend (`exulu/backend`) + Frontend (`exulu/frontend`)

## Problem

Users have stable preferences they want the assistant to honor across every conversation — their role, communication style, language, response-length preference, domain context. Today these have to be re-stated in each chat or baked into individual agent instructions. Neither scales: the first is repetitive, the second couples per-user preferences to shared agents.

## Goal

Add a per-user, free-form **personal system prompt** field. When set, it is injected into the system message of every LLM call this user makes, on top of whatever agent instructions are in play.

A new `/settings` page in the frontend lets the user view and edit their personal prompt. The setting also becomes the foundation for future user-scoped preferences.

## Non-goals

- **No per-agent override.** The personal prompt always applies. Users who want different behaviour per agent should rely on agent instructions.
- **No prompt templating / variables.** Plain text only.
- **No length limit at app or DB layer.** Postgres `TEXT` is unbounded; we deliberately do not enforce a max.
- **No scaffolded settings sections.** This pass ships a minimal `/settings` page with a single textarea. Future settings categories can be added incrementally.
- **No coupling to `privacy.systemPromptPersonalization`.** That org-level flag governs *implicit* identity leakage (name/email auto-injected). The personal prompt is *explicit* user authorship and is always applied when set.
- **No migration of existing text.** Nothing to backfill; new field, empty by default.
- **No exposure in admin UIs.** The existing `/users` admin page is not extended to edit other users' personal prompts.

## Decisions

| Topic | Decision |
|---|---|
| Field name | `personal_system_prompt` |
| Storage | `longText` (postgres `TEXT`) on the `users` table |
| Default | Empty / null |
| Length cap | None (DB or app layer) |
| Position in system message | After the agent's instructions, before `genericContext` |
| Gating | Always applied when non-empty; not gated by `privacy.systemPromptPersonalization` |
| Empty-string handling | Whitespace-only values treated as absent (`.trim()` check before injection) |
| Migration | Standard `addMissingFields` path in `src/postgres/init-db.ts` (column-existence check) |
| GraphQL exposure | Auto-exposed via existing codegen from `core-schema.ts` |
| Mutation | Reuse existing `UPDATE_USER_BY_ID`, extended with the new variable |
| Frontend route | `/settings` under the `(application)` segment |
| Sidebar | Add a "Settings" link to `MainNavProvider` |
| Source of current value on frontend | `UserContext` (already provides the authenticated user object) |

## Architecture

### Data flow

```
User opens /settings
    └── reads user.personal_system_prompt from UserContext into a local textarea
            └── user edits, clicks Save
                  └── Apollo useMutation(UPDATE_USER_BY_ID, { personal_system_prompt })
                        └── GraphQL resolver writes to users.personal_system_prompt
                              └── UserContext refetches / updates

Later, user sends a chat message
    └── route handler calls provider.generateStream / generateSync with `user`
            └── system prompt assembly:
                  system  = instructions || default
                  if (user.personal_system_prompt?.trim())
                      system += "\n\nUser preferences:\n" + trimmed
                  system += "\n\n" + genericContext
            └── LLM call
```

### File map

**Modified files:**

| File | Change |
|---|---|
| `backend/src/postgres/core-schema.ts` | Add `{ name: "personal_system_prompt", type: "longText" }` to `usersSchema.fields`. `addMissingFields` on next boot creates the column. |
| `backend/src/exulu/provider.ts` | In both `generateSync` (around line 443-446) and `generateStream` (around line 953-956): inject the personal prompt immediately after the `system = instructions \|\| default` line and before the `system += "\n\n" + genericContext` line. See snippet below. |
| `frontend/queries/queries.ts` | Extend `UPDATE_USER_BY_ID` mutation to accept `$personal_system_prompt: String`, pass it through `input`, and return it in the response. Extend `GET_USER` (or whichever query feeds `UserContext`) to include `personal_system_prompt`. |
| Sidebar nav (file holding `MainNavProvider`'s nav config) | Add a "Settings" link pointing to `/settings`. Exact file path resolved during the implementation-plan step by reading the current nav definition. |

**New files:**

| File | Purpose |
|---|---|
| `frontend/app/(application)/settings/page.tsx` | The settings page: heading, a `<Textarea>` bound to `personal_system_prompt`, a Save button wired to `UPDATE_USER_BY_ID`, success/error toast feedback. Reads initial value from `UserContext`. |

### Provider snippet (canonical)

The same insertion in both `generateSync` and `generateStream`:

```ts
let system =
  instructions ||
  "You are a helpful assistant. ...";

if (user?.personal_system_prompt?.trim()) {
  system += "\n\nUser preferences:\n" + user.personal_system_prompt.trim();
}

system += "\n\n" + genericContext;
```

The personal prompt sits between the agent's instructions and the generic date/identity context. This keeps the agent's directives most prominent, treats the personal prompt as user-authored guidance, and leaves date/identity context closest to the message stream (where it's most useful for grounding).

### Why "after instructions, before genericContext"

- **Before instructions**: a strongly-worded personal prompt could override agent behaviour in surprising ways.
- **Inside the personalization block**: would couple the explicit personal prompt to the `privacy.systemPromptPersonalization` privacy gate, which governs implicit identity leakage — a different consent model.
- **After genericContext**: would put date/identity context above the user's own preferences, which is the wrong priority.

After instructions and before genericContext keeps agent intent dominant, makes the personal prompt distinct from identity metadata, and keeps date/time at the end where models tend to weight recent context heavily.

## Error handling

- **Empty/whitespace-only personal prompt**: skip injection entirely (the `.trim()` check). Saving an all-whitespace value is allowed but has no effect on prompts.
- **User object missing**: `user?.personal_system_prompt` short-circuits — no crash, no injection.
- **Save failure on frontend**: surface the Apollo error via the existing toast pattern used in `/users` page mutations.
- **No migration race**: `addMissingFields` is idempotent; column added on boot before any code reads it.

## Testing

- **Manual**: set a personal prompt, send a message to an agent, inspect the system message in provider logs to verify it's present in both `generateSync` and `generateStream` paths.
- **Manual (negative)**: clear the field, confirm the `User preferences:` line no longer appears.
- **Manual**: confirm the existing `personalizationInformation` block (name/email) is still gated by `privacy.systemPromptPersonalization` and is independent of the new field.
- **UAT** (optional): use `/uat-testing` against the new `/settings` page once the feature branch is up.

## Open questions

None. Field naming, placement, gating, page scope, and storage are all decided.

## Future work (not in this spec)

- Per-agent toggle to ignore the personal prompt for sensitive agents.
- Settings page sections (Profile, AI preferences, Notifications, …).
- Showing the effective system prompt to the user in a debug/preview view.
- Length warnings or token-cost hints in the editor.
