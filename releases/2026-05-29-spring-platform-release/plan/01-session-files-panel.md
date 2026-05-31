# 01 — Session files panel

**Spec:** `docs/superpowers/specs/2026-05-18-session-files-panel-design.md`
**Slot:** First / marquee — most visible daily UX upgrade.

## Hook
**Every chat session now has its own workspace.** See, upload, preview, and delete the files that belong to a conversation — without leaving the chat.

## Surface area
Pure UI feature with REST routes underneath. The demo *is* the panel.
- Frontend: `frontend/components/session-files/session-files-panel.tsx` (and `file-row.tsx`, `upload-zone.tsx`, `preview-pane.tsx`)
- Backend (referenced in copy, not shown): `GET /sessions/:sessionId/files`, `POST /sessions/:sessionId/files/upload-sign`, `DELETE /sessions/:sessionId/files/:key`, `GET /sessions/:sessionId/file/preview-pdf`

## Code snippet
**No.** Pure UI feature. The value lands by seeing the panel slide open; a curl snippet would dilute it.

## Demo arc (1 slice, ~9s, 1920x1080 + 1080x1920)

1. Establish: chat page in its normal state. Assistant message bubble visible at top. Chat header shows a folder icon button with a small "3" badge.
2. Cursor moves to the folder icon, clicks. The right-side panel slides in (~340px wide). Panel header reads "Session files" with a small scope notice below: *"Files in this session aren't shared with other sessions, projects, or knowledge bases."*
3. Three file rows render in the panel: `meeting-notes.md`, `Q3_strategy.docx`, `screenshot.png`. Each has a type icon, name, size, relative time.
4. Cursor drags a new file (`contract.pdf`) onto the upload zone at the bottom. The dropzone highlights with the brand accent. File row appears at the top of the list with a brief progress sweep.
5. **Hold the final state still (~1.5s).**
6. Payoff caption fades in over the panel: **"Drop a file. Ask the agent. Done."**

### Pacing budget (must respect read-time floors)
- 0.0–0.4: hook fades in
- 0.4–1.6: hook holds (1.2s) — "Session files, in chat"
- 1.6–2.0: pivot to chat UI
- 2.0–2.6: cursor to folder icon
- 2.6–2.9: click → panel slides in
- 2.9–3.5: **breath** (600ms hold of opened panel)
- 3.5–5.0: file rows render in stagger
- 5.0–5.8: cursor drags file into dropzone → upload sweep
- 5.8–6.4: **breath** after upload lands
- 6.4–6.8: payoff fades in
- 6.8–9.0: payoff holds (2.2s) and rests

## Visual brand notes
- Chat surface: reconstruct minimal chat header + an assistant bubble. Don't overdo the chat content — the panel is the star.
- Panel background: `--card`. Border: `--border`. File-row hover: light `--accent` tint.
- Folder icon button: ghost button, primary color when badge > 0.
- Cursor: simulated, slightly larger for 1080x1920.
