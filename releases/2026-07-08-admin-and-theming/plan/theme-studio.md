# Feature plan — Theme Studio (live-preview platform theming)

Part of `releases/2026-07-08-admin-and-theming/`.

## Sources of truth

- UI: `frontend/app/(application)/configuration/components/theme-studio.tsx`
  (page shell, header, publish/reset/import overlays),
  `components/theme-editor.tsx` (left pane: tabs, filters, grouped token rows),
  `components/theme-preview.tsx` (right pane: sticky sampler card)
- Token manifest + resolution:
  `frontend/app/(application)/configuration/theme-defaults.ts`
  (`THEME_TOKENS` with per-mode defaults, `swatchColor`, `countModifiedTokens`,
  `resolveTheme`, `buildThemeCss`)
- Data layer: `frontend/app/(application)/configuration/hooks.ts`
  (`useThemeConfig`, `applyThemeToDocument` — publish applies live, no reload)
  + local `queries.ts` (`GetThemeConfiguration` / `CreateThemeConfiguration` /
  `UpdateThemeConfiguration` on the generic `platform_configurations` CRUD)
- On-screen copy: `frontend/messages/en.json` → `configuration.*`,
  `navigation.configuration` ("Theme"), `navigation.userMenu.themeLight/Dark`
  ("Light"/"Dark"), `common.delete/active/search` (verbatim below)
- Token consumption contract: `frontend/tailwind.config.js` wraps every color
  token as `hsl(var(--token))`; values are BARE HSL TRIPLETS
  (e.g. `--primary: 257.9412 100% 60%`), NOT hex

## What shipped

Super-admin **/configuration** page ("Theme" in the nav) — a two-pane theme
studio for white-labeling the whole platform:

- **Left pane (editor):** every CSS design token from the manifest, grouped
  under quiet headings (Surfaces, Text, Brand, Semantic, Charts, Sidebar,
  Shape & typography, + Custom for imported extras), behind Light/Dark tabs
  with per-mode modified-count badges. A search input ("Filter variables…"),
  a "Modified only" switch, and per row: color swatch · mono token name
  (+ modified dot) · inline value input · per-token reset. Every keystroke
  writes through to the draft.
- **Right pane (preview):** a sticky sampler card — button variants, a card
  with badges, an input, a mini chat exchange, a 10-color chart ramp — whose
  wrapper carries the full resolved draft as inline CSS custom properties.
  It re-renders on EVERY KEYSTROKE, with its own Light/Dark sun/moon toggle
  that never touches the admin's own app theme.
- **Publish:** ConfirmDialog "Publish this theme?" summarizing
  "N light / M dark overrides — this applies to every user."; on confirm the
  config row is upserted and `applyThemeToDocument` swaps a runtime `<style>`
  tag — live for the admin without a reload.
- **Import CSS:** dialog parses pasted `:root` / `.dark` blocks and merges the
  detected variables into the draft. Export CSS / raw JSON+CSS view / "Reset
  to defaults…" (reset publishes the stock theme immediately) live in the
  header overflow menu.

## Hook

**Your platform, your brand — previewed live.**

(On-screen H1: "Your platform, your brand — **previewed live**." with the em
phrase in #7033FF.)

## Surface area

Pure UI/admin feature. The persistence is the generic `platform_configurations`
CRUD (a JSON `config_value` blob keyed `theme_config`) — not a designed
developer surface, so no code snippet. Publish, import, and reset are page
prose within this feature's section.

## Short — `theme-studio` (1920×1080, 8.2s)

One slice, ONE user action: editing the `--primary` token value — drag-select
the hue component, type `210` — and the preview's primary button, badge and
user chat bubble recolor live with each keystroke.

**Why not "type a hex" (brief deviation):** the app consumes every color token
as `hsl(var(--token))` (tailwind.config.js), so a hex value would render the
sampler's primary elements invalid, not recolored. Editing only the hue keeps
EVERY intermediate keystroke a valid color — the preview genuinely sweeps
red → orange → blue, which is the strongest honest demo of per-keystroke
re-rendering.

### The keystroke → color map (builder contract, all real behavior)

`--primary` starts at `257.9412 100% 60%` (the brand purple). The hue
`257.9412` is drag-selected, then three keystrokes replace it:

| Keystroke | Input value | Live color (swatch + primary sampler elements) |
|---|---|---|
| `2` | `2 100% 60%` | red — hsl(2 100% 60%) ≈ #FF3A33 |
| `1` | `21 100% 60%` | orange — hsl(21 100% 60%) ≈ #FF7A33 |
| `0` | `210 100% 60%` | blue — hsl(210 100% 60%) = #3399FF |

Elements that recolor (150ms color tween each — the sampler has
`transition-colors duration-150` everywhere): the row swatch, the **Primary**
button fill, the **Active** badge fill, the right-aligned user chat bubble
fill. NOTHING else changes color: Secondary/Outline/Delete buttons, the other
badges, the agent bubble, the input, and the chart ramp all stay put (the
ramp reads separate `--chart-*` tokens — `--chart-2` stays purple; this
independence is authentic, do not recolor it).

On the FIRST keystroke (value now differs from the default), four real
reactions appear together: a 1.5px×1.5px→`size-1.5` purple dot next to the
mono name `--primary`, a mono badge **1** inside the "Light" tab trigger, the
per-row reset icon (RotateCcw) fades in at the row end (cursor is hovering the
row), and in the page header the hint **"Unsaved changes"** (purple dot + xs
muted text, fade+zoom-in 150ms) appears while the **"Publish theme"** button
goes from disabled (50% opacity) to enabled solid #7033FF. These are inside
the editor chrome (NOT the scoped preview), so they stay app-purple #7033FF
throughout — only the sampler recolors.

### Demo arc (timed beats)

| t (s) | On screen | Why |
|---|---|---|
| 0.00–0.40 | Hook enters: pill "Admin & Theming" (#E2EBFF bg, #1E69DC text), H1 "Your platform, your brand — **previewed live**." (em phrase #7033FF) | Entrance |
| 0.40–1.90 | Hook holds static (1.5s) | ≥1.4s floor for 7 words |
| 1.90–2.40 | Hook crossfades out; Theme studio card fades in: page header ("Theme" + description + ⋯ + disabled "Publish theme"), left editor scrolled to the Brand group, right Preview card | Pivot |
| 2.40–3.10 | Cursor glides to the `--primary` value input (row under the "Brand" heading) | Approach |
| 3.10–3.50 | Click-drag selects the hue `257.9412` (native blue selection highlight; input gains its 2px black focus ring, offset 2px) | The grab |
| 3.50–3.80 | Keystroke `2` → value `2 100% 60%`: swatch + Primary button + Active badge + user bubble tween to red; modified dot, "Light" tab badge **1**, reset icon, "Unsaved changes" + enabled "Publish theme" all appear | Action, part 1 |
| 3.80–4.10 | Keystroke `1` → `21 100% 60%` — same four elements tween to orange | Action, part 2 |
| 4.10–4.40 | Keystroke `0` → `210 100% 60%` — settle on blue #3399FF | Action lands |
| 4.40–5.50 | Hold the recolored state still (1.1s), cursor idle just below the input, focus ring stays | ≥600ms post-action hold |
| 5.50–5.90 | Payoff caption enters (lower third): "Every keystroke re-renders the preview. Publish when it's right." | Entrance |
| 5.90–8.20 | Payoff holds still (2.3s); last 600ms completely still = loop resting frame | ≥1.8s full-sentence floor + clean loop |

### Reconstruction cues (build the real UI, verbatim)

Canvas 1920×1080, bg #FDFDFD + house radial purple wash. The studio renders as
a centered card ~1120px wide (~800px tall, radius ~6px, 1px #E7E7EE border,
subtle shadow) matching the 07-07/07-08 shorts' framing. Inter everywhere,
tracking -0.025em; token names/values in JetBrains Mono. Cursor + motion
conventions identical (power2.out, 150–350ms, no bounce).

**Page header** (top of card, `PageHeader` primitive):
- H1 **"Theme"** (`text-2xl font-semibold tracking-tight`)
- Description **"White-label IMP for your organization — changes apply to
  every user."** (`text-sm text-muted-foreground` #525252) — yes, "IMP" is
  the real string, copy it verbatim.
- Right action cluster: [after first keystroke: purple `size-1.5` dot +
  **"Unsaved changes"** in xs muted text] · a "⋯" ghost icon button (size-8)
  · primary button **"Publish theme"** (#7033FF, white text; starts disabled
  at 50% opacity, enables on first keystroke).

**Layout below the header:** two-column grid, `gap-6`, right column fixed
**360px** (`lg:grid-cols-[minmax(0,1fr)_360px]`), left column ~710px.

**Left pane — editor** (in flow, no card around it):
- Tabs (`h-10 w-fit`, `bg-muted` #F5F5F5 pill, `p-1`, radius 6px): triggers
  **"Light"** (active: `bg-background` + subtle shadow) and **"Dark"**
  (inactive: muted-foreground text). After the first keystroke the Light
  trigger gains a secondary Badge **1** (`px-1.5 font-mono text-[10px]`,
  bg #EDF1F5).
- Filter row (`gap-3`, horizontal): search input `h-9 max-w-xs text-sm`,
  placeholder **"Filter variables…"**; then an (off) Switch + label
  **"Modified only"** (`text-sm font-normal`).
- Token list, scrolled so the **Brand** group is centered. Visible top-to-
  bottom (crop above/below at the card edges):
  - tail of the Text group: its last row `--code-surface-foreground`, swatch
    near-white hsl(60 30% 96%), value `60 30% 96%`
  - group heading **"Brand"** (`text-sm font-medium text-muted-foreground`)
  - row `--primary` — THE row: 16px purple swatch (hsl(257.9412 100% 60%) =
    #7033FF, `rounded-sm border`), mono name `--primary` (text-xs, 220px
    column), value input `h-8 font-mono text-xs` containing
    `257.9412 100% 60%`, empty 32px reset slot at row end
  - row `--primary-foreground` — white swatch (border visible), value
    `0 0% 100%`
  - row `--ring` — black swatch, value `0 0% 0%`
  - group heading **"Semantic"** + first row `--destructive` (red swatch
    hsl(358.4416 74.7573% 59.6078%), value `358.4416 74.7573% 59.6078%`),
    cropped at the card bottom
- Row grid at desktop: `[16px_220px_minmax(0,1fr)_auto]`, `gap-x-2`, rows
  `gap-1` apart, each `rounded-md px-1 py-1`.
- Input focus style (shadcn default): `ring-2` in `--ring` = **black** (light
  mode), `ring-offset-2` — NOT purple. Selection highlight: native (Chrome
  #B4D7FF-ish behind the selected `257.9412`).
- Reset affordance (appears after keystroke 1): ghost icon button, RotateCcw
  icon `size-4`, in the 32px slot — fades in 150ms (it's hover-revealed on
  fine pointers and the cursor is on the row).

**Right pane — Preview card** (the page's only Card: `bg-card` #FCFCFC,
border #E7E7EE, radius ~8px, subtle shadow; sticky look, top-aligned):
- Card header row: title **"Preview"** (`text-lg`) left; right, a ToggleGroup
  pill (`bg-muted p-0.5 rounded-md`) with two `size-8` items — Sun icon
  (active: `bg-background` + shadow) and Moon icon (inactive).
- Sampler wrapper (this is the ONLY region that recolors): `rounded-lg border
  bg-background p-4`, contents `gap-4` vertical:
  1. Buttons row (`gap-2`, size sm): **"Primary"** (filled — starts #7033FF,
     sweeps red→orange→#3399FF), **"Secondary"** (bg #EDF1F5, dark text),
     **"Outline"** (white, border), **"Delete"** (filled #E54B50 — static).
  2. Inner card (`rounded-md border bg-card p-3`): **"Card title"**
     (`text-sm font-medium`), **"A short supporting description."**
     (`text-xs text-muted-foreground`), badge row `gap-1.5`: **"Active"**
     (default badge = primary fill — recolors with the keystrokes),
     **"Secondary"** (bg #EDF1F5), **"Outline"** (bordered).
  3. Input, `h-9`, placeholder **"Search"** — static.
  4. Mini chat: right-aligned bubble **"Summarize this document for me."**
     (`rounded-lg px-3 py-2 text-sm`, primary fill + white text — recolors),
     then left-aligned bubble **"Here's a summary of the key points…"**
     (`bg-muted`, dark text — static).
  5. **"Chart colors"** (`text-xs text-muted-foreground`) over a `gap-1` row
     of 10 equal `h-6 rounded-sm` swatches — light-mode values, left to
     right: hsl(148.0952 53.3898% 53.7255%), hsl(257.9412 100% 60%),
     hsl(24.8571 98.1308% 58.0392%), hsl(217.0787 76.7241% 54.5098%),
     hsl(0 0% 45.4902%), hsl(173 80% 40%), hsl(330 81% 60%),
     hsl(45 93% 47%), hsl(292 84% 61%), hsl(84 81% 44%). ALL static — the
     ramp does not follow `--primary`.

**Payoff caption** (lower third, over the canvas below the card): "Every
keystroke re-renders the preview. Publish when it's right." — Inter, dark
text on the canvas, no box needed; keep entrance to a 150–350ms fade/rise.

## Code snippet decision

**None — pure UI.** The theme persists through the generic
`platform_configurations` CRUD (`platform_configurationsUpdateOneById` with a
JSON `config_value` blob under `config_key: "theme_config"`,
`frontend/app/(application)/configuration/queries.ts`). That is internal
plumbing, not a designed developer surface — it doesn't earn the spot. The
admin-facing "API" here is CSS itself (Import/Export CSS), which the page
prose covers.

## Page prose within this feature's section (beyond the video)

- **Publish is a seen decision:** the confirm dialog title **"Publish this
  theme?"** with **"{lightCount} light / {darkCount} dark overrides — this
  applies to every user."** — the same `countModifiedTokens` numbers as the
  editor's tab badges, so what you confirm is what you just saw. On success:
  **"Theme published — It's live for you now — other users get it the next
  time they load the app."** The publish swaps a runtime `<style>` tag
  (`applyThemeToDocument`) — no reload for the publishing admin.
- **Import CSS:** header menu → **"Import CSS…"** opens **"Import theme
  CSS"**: "Paste a full CSS theme with :root and .dark blocks. Detected
  variables merge into your draft — nothing changes for users until you
  publish." Live detection line: "{lightCount} light · {darkCount} dark
  variables detected"; unreadable lines are listed and skipped, never
  blocking. Imported non-manifest variables stay visible and editable in a
  trailing "Custom" group.
- **Export & raw view:** "Export CSS" copies the PUBLISHED theme as a
  `:root`/`.dark` stylesheet; "Show raw configuration" reveals the stored
  JSON and generated CSS with one-click copy — always the live values, never
  the unpublished draft.
- **Reset with teeth:** "Reset to defaults…" is a destructive confirm —
  **"Removes all overrides ({count}) and immediately publishes the stock
  theme to every user."** — no local-only half-reset.
- **Guardrails, never gates:** color-typed tokens get an advisory warning
  under the input when a value doesn't parse ("Not a recognized color value —
  it will be published exactly as typed.") — publishing as-typed stays
  possible.
