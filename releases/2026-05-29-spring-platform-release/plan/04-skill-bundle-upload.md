# 04 — Skill bundle upload

**Spec:** `docs/superpowers/specs/2026-05-18-skill-bundle-upload-design.md`
**Slot:** Fourth — power-user productivity win for skill authors.

## Hook
**Drop a `.zip`, get a skill.** Upload a complete skill bundle from the Skills page — extracted server-side, ready to use.

## Surface area
UI feature with backend extraction. Demo arc: skills list → New Skill modal → switch to upload mode → drop zip → land on the editor.
- Frontend: `frontend/app/(application)/skills/page.tsx` — New Skill modal gets a mode toggle.
- Backend: `POST /skills/:skillId/upload-sign` and `POST /skills/:skillId/init-from-upload`.

## Code snippet
**No.** The compelling thing is the modal interaction and the immediate redirect. A REST snippet would land flat for the audience of skill authors who live in the UI.

## Demo arc (1 slice, ~9s, 1920x1080 + 1080x1920)

1. Establish: Skills list page with a few existing skill cards. A "+ New Skill" button top-right.
2. Cursor clicks "+ New Skill". Modal opens, centered.
3. At the top of the modal, two pill buttons: **"Create blank"** (selected) | **"Create from upload"**. Cursor clicks the second pill.
4. The modal body morphs: name field and description above, an Uppy-style dashed dropzone below — *"Drop a .zip or .md here"*.
5. A file `docx-skill.zip` drags into the dropzone. The dropzone glows with `--accent`. Filename appears beneath as a small chip.
6. Cursor clicks **Create**. A brief progress bar sweep across the dropzone.
7. **Hold 600ms.**
8. Cut to the skills editor for the newly-created skill — file tree shows `SKILL.md`, `scripts/`, `references/`, etc.
9. Payoff caption fades in: **"Zero clicks per file."**

### Pacing budget
- 0.0–0.4: hook fades in
- 0.4–1.6: hook holds (1.2s) — "Skills, by the bundle"
- 1.6–2.0: pivot
- 2.0–2.4: click "+ New Skill", modal opens
- 2.4–3.0: cursor to second pill, click
- 3.0–3.6: **breath** (600ms) as upload mode reveals dropzone
- 3.6–4.4: file drags in, chip appears
- 4.4–4.9: cursor to Create, click, progress sweep
- 4.9–5.6: **breath** (700ms)
- 5.6–6.6: cut to editor, file tree fades in in stagger
- 6.6–7.0: payoff fades in
- 7.0–9.0: payoff holds (2.0s, last 600ms still)

## Visual brand notes
- Skills list cards: reconstruct from real skills page — small card with title, tag pills, mtime.
- Modal: shadcn Dialog, `max-w-md`, white card, `--border` outline, small shadow.
- Pill toggle: shadcn segmented control feel.
- Dropzone: dashed border in `--border`, hover/drag state in `--accent`.
- Editor view at the end: very brief — file tree on left only, just enough to read "SKILL.md" and a couple of paths.
