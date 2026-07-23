# Platform polish — release plan (2026-07-22)

Roundup of four smaller ships:
A) Transcript post-processing re-run — review sheet runs prompts that never ran.
B) Recall recovery — stuck "Processing" meetings self-heal (reconcile loop,
   crash-safe post-processing). PROSE ONLY, no video.
C) Skill upload — drop a .skill file or a whole skill folder; client-side zip,
   frontmatter prefill; .skill export.
D) Formatted copy — chat answers copy/download formatted for email & WhatsApp.

Research: ./research.md (exact strings, menus, converter details — use it).

Hook: A round of polish — the small things that make the daily loop faster.

## Shorts (1920×1080, 7–8s each, output to ../shorts/)

1. **skill-upload** (8s, hero) — skills create dialog, the folder dropzone
   ("Or drop / pick a skill folder" + "Folder must contain a SKILL.md at its
   root" — exact strings) → a folder ghost drags in and drops → brief zip
   progress → Name + Description fields prefill from frontmatter (highlight
   the fill) → Save. Payoff: "A folder in. A versioned skill out."

2. **formatted-copy** (8s) — a finished chat answer with a small table →
   cursor opens the message actions → Copy → split panel: left an email
   compose window pastes rich formatting, right a WhatsApp-style bubble shows
   *bold* / _italic_ / monospace table. Payoff: "Paste-ready for wherever
   it's going."

3. **transcript-rerun** (7s) — transcription review sheet, post-processing
   card with "Not run yet." (exact string) and ghost "Run" button → cursor
   clicks Run → "Running…" → result text fills the card, toast "Prompt
   re-run". Payoff: "Configured later? Run it anyway."

## Code snippets

None. All four are UI/reliability ships; skip per earn-the-spot rule.

## Page prose extras

- B (recall recovery) gets a full prose slice WITHOUT video: webhook ACKs
  before processing, so a crash used to strand meetings in "Processing" —
  now a 60s reconcile loop re-drives stuck jobs from Recall's state, with
  atomic claims and heartbeats; jobs give up cleanly after 24h. Honest
  framing: this is a reliability fix.
- C scope note: the agent-installer/registry side shipped in the
  Connect Your Agent release; this is the web-UI upload/download UX.
- Caps worth a fineprint line: 50 MB / 500 files per skill folder.

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
- House caption style: mimic
  ../../2026-07-13-connect-your-agent/hyperframes/list-skills/index.html.
