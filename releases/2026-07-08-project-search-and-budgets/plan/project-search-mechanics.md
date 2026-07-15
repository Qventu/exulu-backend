# Prose section plan — Project retrieval mechanics (no video)

Companion prose to `plan/project-search.md` — the backend behavior that a UI short
cannot show. Renders on the page as prose (plus one snippet) inside or directly
below the project-search feature section. Infra/dev-facing → no video.

## Sources of truth

- Spec: `docs/superpowers/specs/2026-07-07-project-agentic-retrieval-design.md`
  (§3 backend design, §5 behavior deltas, §7 adjacent fixes)
- Code: `ee/agentic-retrieval/pipeline/project-scope.ts` (`resolveProjectScope`,
  `ProjectScope`, `ResolvedProjectScope` — pins vs scoped sources),
  `ee/agentic-retrieval/pipeline/config.ts` (`project_search` default-true parse),
  `ee/agentic-retrieval/pipeline/index.ts:148` (config descriptor),
  `src/templates/tools/convert-exulu-tools-to-ai-sdk-tools.ts` (both injection
  modes), commits `12a7f74`, `042c439`, `4ccd2cf`, `553ce20`, `473f003`
- Frontend contract: `config-schema.ts` `serializeWizardConfig` — 13-entry
  contract, `{ name: "project_search", variable: "true"|"false", type: "boolean" }`

## Benefit-language draft (2–3 paragraphs for the page)

**Paragraph 1 — one pipeline, no side door.** Until now, project items were
searched by a legacy side-channel tool: one flat hybrid search per context, limit
10, no reranking, no query expansion, and a separate approval prompt. That tool is
gone. Project knowledge now travels through the same 4-phase pipeline as
everything else — query understanding, multi-query search, reranking, memory
override — so a pinned spec in a project is found with the same accuracy as any
knowledge base the agent owns.

**Paragraph 2 — add, never narrow.** The invariant behind the design: attaching a
project may ADD scope but never narrows what an agent already searches. Items
living in sources the agent already searches become rerank *pins* — a relevance
boost, not a filter. Items in contexts outside the agent's configuration are added
as *item-scoped sources*, searched with a hard filter to exactly the project's
items (a bare context entry means the whole context — which, incidentally, used to
silently return nothing and now works). Project-referenced sources are always
routed as main sources: attaching a project is itself a relevance signal. Agents
without any knowledge search configured get a scoped pipeline instance injected
automatically — zero setup.

**Paragraph 3 — instructions live, one switch to opt out.** Project custom
instructions used to be stored but never reached the model; they now feed the
pipeline's routing instructions — gated at execute time on the new `project_search`
option, so switching it off in the wizard genuinely turns the whole behavior off
for that agent (default is on; existing agents need no config change).

## Code snippet decision

**Yes — the stored tool-config contract** (house precedent: the 07-07 page's
"What the wizard writes (agent tool config)"). The developer surface is the
13-entry `agentic_context_search` config; show the two entries this release adds
or repurposes, in the exact serialized shape from `serializeWizardConfig`:

Anchor line: "What the wizard writes (agentic_context_search tool config — the
two entries this release touches, of 13):"

```json
[
  { "name": "project_search", "variable": "true", "type": "boolean" },
  { "name": "max_steps",      "variable": "3",    "type": "number"  }
]
```

(`project_search` — default true, execute-time gate. `max_steps` — now the
knowledge-search call budget, see the step-budgets section.)

## Notes for the page builder

- Do NOT dramatize server internals (no pipeline diagrams needed — the 07-07 page
  already established the 4-phase pipeline visually; link/reference that section
  instead).
- Worth a compact "what changed under the hood" bullet list: legacy tool deleted ·
  pins vs scoped sources · always-main routing · whole-context entries fixed ·
  project instructions live · approval prompt gone (pipeline tool needs no
  approval).
- EE note, one line: project retrieval now requires the agentic-retrieval
  license (EE) — the legacy non-EE path was removed with the tool.
