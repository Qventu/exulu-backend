# Feature plan — Project knowledge through the agentic pipeline

Addendum to `releases/2026-07-07-agentic-retrieval/` (this package's page frames both
features as "part 2" of that release — same brand chrome, same wizard surface).

## Sources of truth

- Spec: `docs/superpowers/specs/2026-07-07-project-agentic-retrieval-design.md`
- Backend commits: `e753130` (project_search config option, default on),
  `12a7f74` (project scope resolution: pins vs scoped sources, `project-scope.ts`),
  `3c8cbf7` (item-scoped project sources in searchContexts),
  `042c439` (projectScope option — pins, scoped sources, always-main routing),
  `4ccd2cf` (convert routes project items through the pipeline),
  `553ce20` (legacy `project-retrieval-tool.ts` deleted),
  `473f003` (execute-time gate: project instructions only when `project_search` is on)
- Frontend commits: `7e5a5e5` (toggle in wizard Behavior step),
  `1ee2080` (13-entry config contract in `config-schema.ts`)
- UI: `frontend/app/(application)/agents/edit/[id]/components/knowledge-search/`
  (`wizard.tsx`, `steps/behavior-step.tsx`, `config-schema.ts`)
- On-screen copy: `frontend/messages/en.json` →
  `agents.editor.knowledge.wizard.*` (all strings below are verbatim)
- Brand tokens: `releases/2026-07-08-project-search-and-budgets/hyperframes-design.md`

## What shipped

Project items (pins and whole-context sources attached to a chat's project) now route
through the same 4-phase agentic retrieval pipeline (understand → search → rerank →
memory override) instead of the legacy per-project side-channel tool
(`context_search_in_knowledge_items_added_to_project_<id>`, deleted). Two modes:

- **Agent without the search tool:** a pipeline instance is auto-injected, scoped to
  the project — no admin setup.
- **Agent with the search tool:** the project becomes an **additional source** inside
  the one configured pipeline. Items in already-enabled sources become rerank **pins**
  (boost, never a filter); contexts the agent doesn't search get added as
  **item-scoped sources**. A project may ADD scope but never NARROWS the agent's reach.

New wizard control: `project_search` (option 13 of the config contract, default **on**)
— a switch on the Behavior step. Project instructions
(`projects.custom_instructions`) now actually reach retrieval, gated at execute time
on this switch.

## Hook

**Attach a project — its pins and sources flow through the full 4-phase retrieval
pipeline, not a side door.**

## Surface area

UI feature (wizard switch) + backend pipeline mechanics. The demo-able moment is the
Behavior-step toggle; the mechanics are prose (see
`plan/project-search-mechanics.md`). One short.

## Short — `project-search-toggle` (1920×1080, 9.45s)

One slice, ONE user action: flip the "Search attached project items" switch on.

### Demo arc (timed beats)

| t (s) | On screen | Why |
|---|---|---|
| 0.00–0.40 | Hook enters: pill "Agentic Retrieval — part 2" (#E2EBFF bg, #1E69DC text), H1 "Project knowledge, now **agentic**" (em word in #7033FF), sub "Pins and sources join the pipeline" | Entrance |
| 0.40–1.85 | Hook holds static (1.45s) | ≥1.4s floor for 4-word headline + sub fragment |
| 1.85–2.30 | Hook crossfades out, wizard sheet fades/slides in — Behavior step, toggle OFF | Pivot |
| 2.30–3.00 | Cursor glides to the "Search attached project items" switch | Approach |
| 3.00–3.25 | Click → switch flips on: thumb slides right (translate-x 20px), track #E7E7EE → #7033FF | The one action |
| 3.25–3.95 | Hold the new state still (700ms) | Breath after action |
| 3.95–4.35 | Soft highlight sweep enters over the row's hint sentence (accent #E2EBFF wash behind the text, left→right) | Direct attention to real product copy |
| 4.35–6.25 | Hint holds highlighted, everything else still (1.9s) | Full-sentence read floor (≥1.8s) |
| 6.25–6.55 | Highlight fades out | Clear stage |
| 6.55–7.15 | Breath (600ms), sheet fully still | Breath before payoff |
| 7.15–7.55 | Payoff caption enters (lower third, below the sheet): "Pins and sources, through the full 4-phase pipeline." | Entrance |
| 7.55–9.45 | Payoff holds still (1.9s); last 600ms fully still = loop resting frame | ≥1.8s full-sentence floor + clean loop |

### Reconstruction cues (build the real UI, verbatim)

**Wizard sheet** (right-side Sheet, `sm:max-w-2xl`; in the 07-07 shorts rendered as a
centered card ~1120×920, bg #FCFCFC, border 1px #E7E7EE, radius 14px, shadow
`0 2px 3px rgba(0,0,0,0.08), 0 24px 60px -24px rgba(0,0,0,0.18)` — mirror
`releases/2026-07-07-agentic-retrieval/hyperframes/compositions/behavior.html`
exactly for continuity):

- Title: **"Configure knowledge search"**
- Step description (behavior): **"Tune how results are ranked and how many are returned."**
- Step pills: `Sources  Routing  Vocabulary  Memory  Behavior  Review` — Behavior
  active (bg #7033FF, white text, pill radius 999px), earlier pills done
  (bg #F0F0F3, text #1A1A1A), Review upcoming (bg #F0F0F3, text #8A8A93)

**Behavior step body**, in real order (`behavior-step.tsx`), enough rows visible to
establish context — the project-search row sits between the slider and the textarea:

1. "Reranker" (label `text-sm font-medium`) + hint "A reranker re-scores search
   results for relevance. Strongly recommended — without one, results are ordered by
   raw search score." + select box
2. "Results to hand the assistant" + number input, value 5
3. "Backup-source trigger: 95%" + slider at 95% (fill #7033FF, white handle with
   2.5px #7033FF border)
4. **The row (star of the short)** — `flex items-start justify-between gap-3
   rounded-md border p-3` (border #E7E7EE):
   - Label (`text-xs font-medium`): **"Search attached project items"**
   - Hint (`text-xs text-muted-foreground` #525252): **"When a chat belongs to a
     project, the assistant automatically searches the items pinned to that
     project."**
   - Switch right-aligned: track `h-6 w-11 rounded-full`, unchecked bg = input gray
     (#E7E7EE), checked bg #7033FF; thumb `h-5 w-5 rounded-full` white,
     translate-x 0 → 20px on check
5. "Extra instructions (optional)" + textarea placeholder "Free-text guidance for the
   retrieval pipeline."
6. Accordion trigger "Advanced tuning" (collapsed)

Footer buttons: "Back" (ghost) / "Continue" (primary #7033FF) — Behavior is not the
last step.

Canvas: 1920×1080, bg #FDFDFD with the house radial purple wash
(`radial-gradient(900px 500px at 50% -10%, rgba(112,51,255,0.07), transparent 70%)`).
Inter for all UI text, tracking -0.025em. Cursor: the same simulated cursor as the
07-07 shorts. Motion: power2.out, 150–350ms, no bounce.

## Code snippet decision

**No snippet on this slice** — the toggle is pure UI. The developer-facing surface
(the 13-entry tool-config contract) gets its snippet in the companion prose section
(`plan/project-search-mechanics.md`), house precedent: 07-07's "What the wizard
writes (agent tool config)".
