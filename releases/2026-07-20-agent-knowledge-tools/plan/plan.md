# Agent knowledge tools — release plan (2026-07-20)

Two features, one theme: agents don't just answer from your knowledge — they
maintain it, and when you hand them a document they look at the actual page.

A) KB write tools: per-context create/update item tools
   (create_<ctx>_item / update_<ctx>_item), enabled per knowledge base in the
   agent editor's Tools section, guarded by row-level write access.
B) Sandbox document vision: parse_document page markers +
   view_document_page renders a page to an image the model actually sees.

Research: ./research.md (exact tool ids, config shape, UI strings — use it).

Hook: Your agents don't just read your knowledge anymore. They keep it current.

## Shorts (1920×1080, 7–9s each, output to ../shorts/)

1. **enable-kb-editor** (8s) — agent editor → Tools section → "Knowledge base
   editor" entry in the default category. Cursor enables it → config sheet
   opens: per-KB rows with labeled Create / Update switches → flip "Create"
   on a "Decisions" KB. Payoff: "Write access, per knowledge base, per agent."

2. **create-item** (9s, hero) — chat. User message "Log that decision in the
   decisions KB." → agent starts tool call chip create_decisions_item →
   approval card "Run create decisions item?" with Allow once / Allow for this
   chat / Deny → cursor clicks Allow once → chip completes → result line
   (item created, embeddings queued). Payoff: "Approved by you. Written by
   the agent."

3. **view-document-page** (9s) — chat. "What's on page 3 of the Q3 report?"
   → parse_document chip returns "--- page 3 ---" marker context →
   view_document_page chip → a rendered page thumbnail (chart page) appears
   in the tool result → agent's reply references the actual chart. Payoff:
   "They don't guess at the text layer. They look at the page."

## Code snippets

One snippet: the kb-editor tool config as stored on the agent
(knowledge_base_editor entry: knowledge_bases JSON + skip_approval), labeled
"Agent tool config" — from research.md verbatim. Optionally the two tool ids
inline in prose (create_<ctx>_item / update_<ctx>_item).

## Page prose extras

- Guardrails: row-level write gate (agent capability never exceeds the user's
  rights), reserved keys and hidden fields blocked, guests blocked.
- Vision: image-only PDFs self-route to page rendering; non-vision models get
  a deterministic refusal instead of a hallucinated answer.

## Build rules (apply to every short)

- Follow the hyperframes skill; register paused timeline on window.__timelines.
- Read-time floors: short phrase ≥1.0s static hold AFTER entrance; sentence
  ≥1.8s. Breath ≥600ms after any click/state change before new captions.
  Final 1.5–2s of each loop completely still.
- Render a cursor for every click. Product-faithful motion: power2.out,
  150–350ms, no bounce.
- UI reconstruction uses the exact strings/tailwind classes in research.md.
  Brand tokens: copy design.md from
  ../../2026-07-13-connect-your-agent/hyperframes/connect-modal/design.md.
- House caption style: mimic the hook/payoff caption cards of
  ../../2026-07-13-connect-your-agent/hyperframes/list-skills/index.html.
