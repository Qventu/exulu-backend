# Feature plan — Agentic Retrieval, revamped (guided config)

## Sources of truth

- Spec: `docs/superpowers/specs/2026-07-03-agentic-retrieval-pipeline-design.md`
- UI: `frontend/app/(application)/agents/edit/[id]/components/knowledge-search/`
  (summary-card.tsx, wizard.tsx, steps/*.tsx, config-schema.ts)
- All on-screen copy: `frontend/messages/en.json` → `agents.editor.knowledge.*`
  (labels below are verbatim from the shipped product)

## What shipped

The `agentic_context_search` tool was rebuilt as a deterministic 4-phase pipeline
(understand → search → rerank → memory override), and its configuration moved from
a flat key-value list to a guided, plain-language wizard in the agent editor:

- **Summary card** in the Knowledge section: digest line
  ("4 knowledge bases · 3 routing rules · memory on · reranker: …") + per-area
  edit buttons (Knowledge bases / Routing / Vocabulary / Behavior).
- **Wizard** (right-side sheet, 6 steps): Sources → Routing → Vocabulary →
  Memory → Behavior → Review. Every control has a one-line explanation + example.

## Config areas to explain on the page (all verbatim from the UI)

1. **Sources** — per-KB enable + "What's in it?" kind:
   Documents & manuals (multi-query + expansion, up to 100 passages, ±7 neighbors),
   Conversations & tickets (name/keyword prefilter, up to 20),
   Structured records (direct keyword search, up to 20);
   optional "When should the assistant look here?" instructions.
2. **Routing** — plain-language rules: label, description, "Search these first",
   "Also check when the first search looks weak". No rules = search everything.
3. **Vocabulary** — Glossary (term → meaning); Names & codes identifier sets
   (approximate for product names, exact for standards/codes → pins matching files);
   "Describe your documents" style hint (feeds HyDE); advanced query rewrites.
4. **Memory** — 4 toggles: use memory during retrieval; let verified memory
   override documents (strictly gated); follow file hints in memory; expand
   queries with memory & glossary.
5. **Behavior** — reranker (recommended), results-to-hand-the-assistant (top-K),
   backup-source trigger % (fallbackThreshold), extra instructions; advanced:
   pinned-file boost, identifier-match boost, page window, max query variations,
   utility model, managed context, require chosen KBs, debug logging, max steps.

## Shorts (all 1920×1080, ~9.4–9.8s, one slice each)

- **A `wizard-open` (marquee)** — agent editor summary card → cursor clicks
  "Routing" → wizard sheet slides in. Hook: "Agentic Retrieval, revamped".
  Payoff: "Six steps. Plain language. No JSON."
- **B `sources`** — Sources step; open kind dropdown; click "Conversations &
  tickets"; hint text swaps. Payoff: "Each source, searched the way its content wants."
- **C `routing`** — Routing step; a rule composes itself (label, description,
  main chips, fallback chips). Payoff: "The right sources first."
- **D `vocabulary`** — Vocabulary step; glossary rows + two identifier sets
  (approximate vs exact). Payoff: "Your domain language becomes retrieval accuracy."
- **E `behavior`** — Behavior step; cursor drags the backup-trigger slider
  85% → 95%, label counts up. Payoff: "Production-grade tuning, no code."

Memory step: prose-only on the page (toggles are the least visual surface).

## Code snippet

The feature's developer surface is the config JSON stored on the agent. Show a
compact excerpt of the `routing` + `vocabulary` json config values (shapes from
the spec §3.2) labeled "What the wizard writes (agent tool config)".
