# Feature plan — Decoupled step budgets (turn budget vs retrieval calls)

Addendum to `releases/2026-07-07-agentic-retrieval/` (part 2 of that release).

## Sources of truth

- Spec: `docs/superpowers/specs/2026-07-08-step-budget-decoupling-design.md`
- Backend commits: `b0a9c44` (`resolveTurnStepBudget` + `max_tool_steps` agents
  column + `resolveRetrievalCallBudget` rename), `69d8c2b` (`retrievalBudgetGuard`
  via activeTools), `30dbeea` (wired at 3 provider + 2 gateway sites),
  `a2f5e16` (final-step hardening — see `plan/final-step-hardening.md`)
- Backend code: `src/exulu/resolve-max-steps.ts` (all helpers live here;
  `DEFAULT_MAX_STEPS = 10`), `src/postgres/core-schema.ts:286` (column)
- Frontend commits: `acd63d9` (field in Chat Experience), `6194121`/`7a75167`
  (clamped 0–50, Float GraphQL variable), `186a956` (input displays fallback 10),
  `f0f0066` (wizard `max_steps` relabeled as knowledge-search call budget)
- UI: `frontend/app/(application)/agents/edit/[id]/sections/chat-experience.tsx`,
  `components/primitives/setting-row.tsx`,
  `components/knowledge-search/steps/behavior-step.tsx` (relabel)
- On-screen copy: `frontend/messages/en.json` → `agents.editor.chatExperience.*`
  and `agents.editor.knowledge.wizard.behavior.maxSteps*` (verbatim below)
- GraphQL: `UPDATE_AGENT_EDITOR` in
  `frontend/app/(application)/agents/edit/[id]/queries.ts` (`agentsUpdateOneById`,
  `$max_tool_steps: Float`)

## What shipped

The turn-level tool budget and the retrieval-call budget are now two separate knobs:

- **`max_tool_steps`** — new `agents` column (auto-provisioned, no migration) +
  number field in the agent editor's **Chat experience** section. Caps ALL tool
  steps per message (bash, files, knowledge search, integrations). 0/null =
  platform default (10). Resolved by `resolveTurnStepBudget(maxStepCount, agent)`.
- **Wizard `max_steps`** — same stored config entry, new meaning: caps ONLY
  agentic-retrieval CALLS per message. Enforced by `retrievalBudgetGuard`, which
  silently drops the search tool from `activeTools` once spent; every other tool
  keeps running. 0 = no search-specific cap. Relabeled in the wizard as
  **"Max knowledge searches per message"**.

Before: the wizard's `max_steps` bled into the whole turn's budget — a retrieval cap
of 3 meant the agent got 3 steps for *everything* (the "Newton" production failure:
two bash calls, then a forced final answer). Now: up to 10 tool steps per message,
of which at most N may be knowledge searches.

## Hook

**Retrieval calls no longer eat the turn budget — cap them separately, right on the
agent.**

## Surface area

UI feature (agent-editor number field) + backend budget resolution + a real
developer surface (GraphQL mutation field). One short on the Chat Experience field;
the wizard relabel and guard mechanics are page prose within this feature's section.

## Short — `max-tool-steps` (1920×1080, 9.5s)

One slice, ONE user action: set the budget in the "Max tool steps per message"
field (click focuses, value 10 → 16).

### Demo arc (timed beats)

| t (s) | On screen | Why |
|---|---|---|
| 0.00–0.40 | Hook enters: pill "Agentic Retrieval — part 2" (#E2EBFF/#1E69DC), H1 "Two budgets, **decoupled**." (em word #7033FF) — no sub-line | Entrance |
| 0.40–1.55 | Hook holds static (1.15s) | ≥1.0s floor for 3-word phrase |
| 1.55–2.00 | Hook crossfades out, Chat experience section card fades in; "Max tool steps per message" row visible, input shows **10** | Pivot |
| 2.00–2.70 | Cursor glides to the number input | Approach |
| 2.70–2.95 | Click → input gets focus ring (2px #7033FF) | Focus |
| 2.95–3.45 | Value types: 10 clears, **16** types in (two quick keystrokes) | The one action (click + type-in = setting the value) |
| 3.45–4.15 | Hold the new state still (700ms), focus ring stays | Breath after action |
| 4.15–4.55 | Soft highlight sweep (#E2EBFF wash) enters over the description span "applies to every tool (bash, files, knowledge search, integrations)" | Real product copy carries the message |
| 4.55–6.40 | Highlight holds, everything else still (1.85s) | ≥1.8s full-sentence read floor |
| 6.40–6.70 | Highlight fades out | Clear stage |
| 6.70–7.30 | Breath (600ms), card fully still | Breath before payoff |
| 7.30–7.70 | Payoff caption enters (lower third): "Knowledge searches no longer eat the turn budget." | Entrance |
| 7.70–9.50 | Payoff holds still (1.8s); last 600ms fully still = loop resting frame | ≥1.8s floor + clean loop |

### Reconstruction cues (build the real UI, verbatim)

**Chat experience section** (`chat-experience.tsx`; real editor column is
`max-w-3xl space-y-12` with a 200px SectionNav on the left — for the short, render
the section as a centered card ~1120px wide on the #FDFDFD canvas, matching the
07-07 shorts' framing):

- Section header: h2 **"Chat experience"** (`text-lg font-medium`) + description
  **"How the agent shows up inside chat."** (`text-sm text-muted-foreground`
  #525252)
- SettingRow pattern (`setting-row.tsx`): `flex ... sm:flex-row sm:items-start
  sm:justify-between sm:gap-4 rounded-lg border p-4` (border #E7E7EE, radius
  ~8px), label `text-sm font-medium`, description `text-sm text-muted-foreground`,
  control right-aligned. Rows stack with `space-y-3`.
- Rows to show (real order; the welcome-message textarea row may be cropped above
  the fold — keep at least three switch rows above the star row for authenticity):
  1. **"Follow-up suggestions"** — "After each reply, suggest up to 3 messages the
     user might send next. Uses the agent's model; tokens count toward limits."
     Switch ON (#7033FF)
  2. **"Feedback collection"** — "Allow users to send feedback during chat."
     Switch ON
  3. **"Set as default agent"** — "Loads this agent by default on the chat page."
     Switch OFF (#E7E7EE track)
  4. **"File sandbox"** — "Give this agent a file sandbox with
     readFile/writeFile/bash tools — needed for skills and file generation. Off by
     default for knowledge agents." Switch ON
  5. **The row (star of the short)** — label **"Max tool steps per message"**,
     description **"Caps how many tool/reasoning steps this agent may take on one
     message — applies to every tool (bash, files, knowledge search, integrations).
     0 = platform default (10)."** Control: number input `w-24` (~96px), value
     **10**, right-aligned in the row; min 0 / max 50.

Canvas 1920×1080, bg #FDFDFD + house radial purple wash. Inter, tracking -0.025em;
input value may render in Inter (it is a plain shadcn Input). Cursor + motion
conventions identical to the 07-07 shorts (power2.out, 150–350ms, no bounce).

## Code snippet decision

**Yes — GraphQL.** `max_tool_steps` is a real API surface: a new field on the
`agents` GraphQL type and update input, used by the editor's own mutation. Excerpt
of the actual operation (trimmed to the new field), from
`frontend/app/(application)/agents/edit/[id]/queries.ts`:

Anchor line: "The budget is a plain agent field — set it via GraphQL:"

```graphql
mutation UpdateAgentEditor($id: ID!, $max_tool_steps: Float) {
  agentsUpdateOneById(
    input: { max_tool_steps: $max_tool_steps }
    id: $id
  ) {
    item {
      id
      name
      max_tool_steps
    }
  }
}
```

(11 lines, real operation name, real field names; `0` or `null` = platform
default of 10.)

## Page prose within this feature's section (beyond the video)

- The wizard relabel: Behavior step → Advanced tuning →
  **"Max knowledge searches per message"** with hint **"Caps how many knowledge
  searches the assistant may run for one message. Once spent, the search tool is
  disabled for the rest of the turn. 0 = no search-specific cap (the overall
  tool-step budget still applies)."** (`f0f0066`; same wording in the backend
  config description, `30dbeea`). Storage contract unchanged — existing configs
  keep working, they just stop capping the whole turn.
- Guard behavior: once the search budget is spent, `retrievalBudgetGuard` removes
  only the retrieval tool from `activeTools` — silently, re-asserted every step;
  all other tools keep running until the turn budget (`resolveTurnStepBudget`)
  is reached. Wired at all three provider sites and both OpenAI-gateway sites
  (`30dbeea`), so API traffic gets the same behavior as chat.
