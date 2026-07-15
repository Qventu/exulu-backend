# Feature plan — Per-agent file sandbox toggle (SHORT)

## Sources of truth

- Backend: `agents.sandbox_enabled` boolean, default false — commit `af3f3a2`
  (`src/postgres/core-schema.ts`, gating in
  `src/templates/tools/convert-exulu-tools-to-ai-sdk-tools.ts`)
- Frontend toggle: `frontend/app/(application)/agents/edit/[id]/sections/chat-experience.tsx`
  (commit `e8f394d`); row primitive `frontend/components/primitives/setting-row.tsx`
- Frontend attach gating: `frontend/app/(application)/chat/components/attach-menu.tsx`
  (commit `3461667`)
- Strings: `frontend/messages/en.json` → `agents.editor.chatExperience.*`,
  `chat.attach.*` (all verbatim below)

## What shipped

Each agent's sandbox file tools (`readFile` / `writeFile` / `bash`) are now
opt-in via a per-agent flag. Knowledge-only agents no longer get a sandbox —
and stop making spurious shell calls. The flag surfaces in the agent editor's
**Chat experience** section as a switch, and the chat composer's ＋ menu reacts:
when the sandbox is off, the "Session files" entry is disabled with an inline
reason.

## Hook

**"Per-agent file sandbox"** — file tools only for the agents that need them.

## Surface area

UI feature (recipe A), two connected surfaces: agent editor switch → composer
attach menu. One user action (the switch flip); the menu reaction is the payoff.

## Reconstruction cues (exact, from the shipped code)

Editor panel (left):
- Section heading `text-lg font-medium`: **"Chat experience"**; sub
  `text-sm text-muted-foreground`: **"How the agent shows up inside chat."**
- SettingRow: `flex rounded-lg border p-4 justify-between` — label
  `text-sm font-medium`: **"File sandbox"**; description `text-sm text-muted-foreground`:
  **"Give this agent a file sandbox with readFile/writeFile/bash tools — needed
  for skills and file generation. Off by default for knowledge agents."**;
  shadcn `Switch` right-aligned (off: grey track; on: `#7033FF` track, knob slides right).
- Sibling row above for authenticity: "Feedback collection" / "Allow users to
  send feedback during chat." with its own switch.

Attach menu panel (right) — the composer ＋ popover, entries top to bottom
(each: icon `size-4` muted + `text-sm` label + `text-xs text-muted-foreground`
description, `rounded-md px-2 py-2.5`):
1. Brain — **"Add knowledge"** / "Pin contexts or items for this chat"
2. FileText — **"Insert prompt"** / "Use a template from the library"
3. FolderOpen — **"Session files"** — disabled state: `opacity-50`,
   description **"Unavailable — the file sandbox is off for this agent."**;
   enabled state: full opacity, description **"View and upload files for this
   session"**
4. Wrench — **"Skills & tools"** / "Choose what the agent may use"

Stage: both panels as bordered cards (`#E7E7EE`, radius 6px) side by side on
`#FDFDFD`, so cause (switch) and effect (menu entry) are simultaneously visible
— no scene cut needed.

## Demo arc — `file-sandbox-toggle.mp4`, 1920×1080, 8.5s, ONE action (flip switch)

| t (s) | What's on screen | Rule honored |
|---|---|---|
| 0.0–0.4 | Hook "Per-agent file sandbox" fades in | entrance |
| 0.4–1.8 | Hook holds still (1.4s) | ≥1.4s 4-word fragment floor |
| 1.8–2.4 | Crossfade to two-panel stage: editor row (switch OFF) left, attach menu right with "Session files" greyed + "Unavailable — the file sandbox is off for this agent." | establish |
| 2.4–3.2 | Cursor glides to the switch | approach |
| 3.2–3.5 | Click → switch slides ON, track turns `#7033FF` | the action |
| 3.5–4.1 | Hold still (600ms) | breath after action |
| 4.1–4.6 | Right panel reacts: "Session files" un-dims to full opacity, description swaps to "View and upload files for this session" | the payoff state |
| 4.6–5.5 | Hold the new state still (900ms) | breath after state change |
| 5.5–5.9 | Payoff "Knowledge agents stay lean. File agents opt in." fades in | entrance |
| 5.9–7.9 | Payoff holds still (2.0s) | ≥1.8s full-sentence floor |
| 7.9–8.5 | Fully still resting frame | loop rest |

## Code snippet — NOT EARNED

Pure UI/config affordance. `sandbox_enabled` is a column + editor switch; no new
SDK method, route, or GraphQL operation worth screenshotting. Prose mentions the
flag name for admins; no code block.
