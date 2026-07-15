# Prose section plan — Large uploads become retrievable corpora (no video)

## Sources of truth

- Spec: `docs/superpowers/specs/2026-07-07-context-window-management-design.md` §2
  ("Document uploads get the same treatment") + the Problem section (the 89-document
  incident)
- Backend: `guardExtractedFileText` in `src/exulu/tool-output-offload.ts`, wired into
  `processFilePartsInMessages` in `src/exulu/provider.ts` (`b79f7cf`); system-prompt
  paging hint in `src/exulu/provider.ts` (~line 1088)

## Why prose, not video

Visually it is the same beat as the tool-output short (a truncation notice + a
`read_session_file` page-back) — a second video would demo the identical mechanism.
Prose next to the offload short carries it, anchored by the incident story.

## What shipped (raw material for 2–3 paragraphs)

- **The incident, fixed at the source.** The design spec opens with a real failure: a user
  uploaded 89 `.odt` service reports, every subsequent turn re-sent ~1.3M input tokens of
  extracted document text, and requests eventually died with raw provider errors. Text
  extracted from uploads now goes through the same cap as tool outputs
  (`min(25K, max(4K, 10% of contextWindow))` tokens, at the extraction point).
- **Preview + pointer, not megabytes.** Oversized extractions keep the first ~4,000
  characters inline followed by a notice (verbatim shape):
  `[Document "<filename>" truncated: ~184,000 tokens. The full extracted text is saved as
  session file "<name>" — read specific parts with read_session_file (offset/limit).]`
  The full text is stored as a session file and shows up in the Session files side panel,
  same as any upload.
- **The model knows what to do.** The system prompt now explains the convention: oversized
  outputs and large documents are truncated in the conversation, the full content lives in
  a named session file, and the agent should page through it with `read_session_file`
  instead of asking the user to re-upload. Big uploads become a corpus the agent queries
  on demand — instead of ballast it re-reads on every turn.

Benefit angle: upload as many and as large documents as you like; each turn only pays for
the parts the agent actually needs right now, and nothing you uploaded is ever lost.

## Code snippet decision

**No snippet.** No new SDK method, route, or GraphQL operation — the developer-visible
shapes (`read_session_file` input/result, truncated-output JSON) are already shown in the
tool-output-offload section; repeating them here would be padding. The bracketed notice
string above can be typeset inline as the section's visual anchor.
