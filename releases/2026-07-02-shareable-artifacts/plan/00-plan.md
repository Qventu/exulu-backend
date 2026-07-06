# Release Plan — Shareable Artifact Links (2026-07-02)

## Feature summary

Agents can create files (HTML pages, PDFs, Word docs, spreadsheets). This release lets
users turn any of those files into a shareable link — right from the chat file panel. The
link can be public (anyone with the URL), password-protected, or scoped to logged-in
Exulu users. HTML artifacts render inline in the browser; everything else downloads
automatically.

## Hook line (page hero)

> "Every file your agent creates — shareable in two clicks."

## Slices

### Slice 1 — Share from chat (UI Recipe A)

**Surface:** `components/artifacts/share-artifact-dialog.tsx` + `file-row.tsx`

**Demo arc (8s):**

| t | Screen | Why |
|---|---|---|
| 0.0 – 0.4 | Hook text fades in: "Share any agent file" | Entrance |
| 0.4 – 1.6 | Hook holds (1.2s) | Read time |
| 1.6 – 2.0 | Hook fades; file panel appears showing a file row (`report.html`) | Pivot |
| 2.0 – 2.6 | Cursor glides to the share icon on the file row | Approach |
| 2.6 – 2.9 | Click → dialog opens (ShareArtifactDialog, `create` view) | Action |
| 2.9 – 3.5 | Hold dialog open (600ms breath) | Breath |
| 3.5 – 4.2 | Cursor clicks "Public" access mode button | Selection |
| 4.2 – 4.5 | Hold (300ms), then cursor moves to "Create link" | Setup |
| 4.5 – 4.8 | Click "Create link" → dialog transitions to success view | Action |
| 4.8 – 5.5 | Hold success view with URL visible (700ms breath) | Breath |
| 5.5 – 5.9 | Payoff caption fades in: "Copied. Share anywhere." | Entrance |
| 5.9 – 7.5 | Payoff holds (1.6s) | Read time + loop rest |
| 7.5 – 8.0 | Still resting frame | Loop hold |

**Key UI elements to reconstruct:**
- File row: `rounded-md border px-3 py-2` — muted bg, file name in mono `text-sm`, share icon `h-7 w-7` ghost button
- Dialog: `max-w-md` modal, three access-mode buttons (`Public`, `Password`, `Logged-in users`), outline variant deselected, default variant selected (purple: `hsl(257.94, 100%, 60%)`)
- Success: URL in a readonly monospace Input + copy button → Check icon on success
- Colors: primary `#7033FF`, border `#E6E6EE`, card bg `#FDFDFD`, muted-foreground `#525252`

---

### Slice 2 — HTML renders live (UI Recipe A)

**Surface:** `app/artifacts/[artifact_name]/page.tsx` → `<iframe srcDoc>` sandboxed

**Demo arc (7s):**

| t | Screen | Why |
|---|---|---|
| 0.0 – 0.4 | Hook fades in: "HTML artifacts render inline" | Entrance |
| 0.4 – 1.6 | Hook holds (1.2s) | Read time |
| 1.6 – 2.0 | Hook exits; browser address bar fades in showing `/artifacts/report` | Pivot |
| 2.0 – 3.0 | A clean rendered HTML page fills the frame (a simple chart or styled doc) | The reveal |
| 3.0 – 3.6 | Hold the rendered page (600ms breath) | Breath |
| 3.6 – 4.0 | "Sandboxed. No login needed." caption fades in | Entrance |
| 4.0 – 5.5 | Caption holds (1.5s) | Read time |
| 5.5 – 7.0 | Still resting frame | Loop hold |

**Key UI elements:**
- Browser-chrome strip at top (light grey, address bar with lock icon + `/artifacts/report`)
- The rendered HTML: a clean, styled page — e.g. a bar chart or nicely formatted report
- No Exulu nav visible — the artifact page is intentionally chrome-free

---

### Slice 3 — REST API (Recipe B)

**Surface:** `POST /shared-artifacts` route

**Demo arc (8s):**

| t | Screen | Why |
|---|---|---|
| 0.0 – 0.4 | Hook fades in: "From the API" | Entrance |
| 0.4 – 1.4 | Hook holds (1.0s) | Read time |
| 1.4 – 1.8 | Hook exits; dark terminal surface fades in | Pivot |
| 1.8 – 4.5 | curl command types in character-by-character | Demo |
| 4.5 – 5.0 | Response `{ "name": "q4-report" }` appears below | Payoff moment |
| 5.0 – 5.6 | Hold (600ms breath) | Breath |
| 5.6 – 6.0 | Payoff caption: "Three access modes. One endpoint." | Entrance |
| 6.0 – 7.5 | Caption holds (1.5s) | Read time |
| 7.5 – 8.0 | Still resting frame | Loop hold |

**Snippet:**
```bash
curl -X POST https://your-backend/shared-artifacts \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "s3key": "uploads/q4-report.html",
    "name": "q4-report",
    "auth_mode": "public",
    "expires_at": "2026-08-01T00:00:00Z"
  }'
# → { "name": "q4-report" }
```

---

## Release page structure

1. Hero: "Every file your agent creates — shareable in two clicks."
2. Feature section: "Shareable Artifact Links"
   - Slice 1 video + prose (the dialog flow)
   - Slice 2 video + prose (HTML renders inline)
   - Snippet (REST API, earn-the-spot: yes — there is a developer-facing endpoint)
3. Footer → docs
