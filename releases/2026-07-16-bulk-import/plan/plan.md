# Bulk import — release plan (2026-07-16)

Feature: import up to 100 items into any knowledge base in one go — drop a pile
of files or a CSV, review in a generated grid, import with live progress.
v1.1 adds batch access: imported items arrive already shared.

Research: ./research.md (exact strings, classes, file:line refs — use it, don't guess).

Hook: Fifty PDFs. One drop. One click.

## Shorts (1920×1080, 7–9s each, output to ../shorts/)

1. **files-drop** (9s, hero) — start mid-wizard: file rows staged, header
   "50 files ready to import". Hook caption: "Drop 50 files on a knowledge base."
   Cursor clicks "Import 50 items" → row badges cascade Pending → Uploading →
   Saving → Done with progress bar → green summary "50 created, 0 updated,
   0 failed" (hold). Payoff caption: "An afternoon of clicking, gone."
   ONE user action (the click). Cascade is the demo; summary is the resting frame.

2. **csv-mapping** (8s) — chip "products.csv — 40 rows" → "Map columns" table
   with sample values, "Import as" dropdowns pre-matched (brief highlight
   sweep down the matched column) → cut to review grid showing mixed
   Create / Update badges. Payoff: "Headers matched for you — id rows update,
   the rest create." No click needed; this is a guided reveal.

3. **batch-access** (7s) — review step, footer shows "Access: Private" lock
   button. Cursor clicks → "Visibility & sharing" popover → selects Teams →
   popover closes, Access column values flip to "Teams" (Update rows keep "—").
   Payoff: "Imported items arrive already shared."

## Code snippets

None. Pure UI feature; the GraphQL it uses is internal. Skip per earn-the-spot rule.

## Page prose extras (no video)

- Fix-in-grid: red cells with inline errors, "38 of 40 rows ready", button
  adapts to "Import 38 valid rows"; post-run "Retry failed rows" +
  "Download error report".
- Limits: ≤100 rows per batch, CSV (no XLSX yet); files flow requires the
  context to have file uploads configured.

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
