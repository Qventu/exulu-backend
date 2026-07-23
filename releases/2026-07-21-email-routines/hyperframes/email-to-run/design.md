# Exulu release shorts — WEBSITE CI (canon since the 2026-07 reskin)

The releases master page standardized on the website CI, not the product CI.
Every short uses this system. Reference frames: the reskinned
`2026-07-13-connect-your-agent/hyperframes/list-skills` and the freshly built
`2026-07-16-bulk-import/hyperframes/files-drop`.

## Stage

- Warm cream stage: `#f8f6f1` full-bleed background.
- The app UI sits in a **centered contained window**: rounded ~10px,
  1px border `#e4ddd0`, subtle warm shadow
  (`0 24px 60px rgba(36, 31, 26, 0.10), 0 1px 2px rgba(36, 31, 26, 0.05)`),
  generous margins on all sides.

## Palette

- Surfaces: `#fbfaf7` (window), `#f8f6f1` (stage/wells), muted panels `#efece4`,
  subtle header strip `#faf8f4`.
- Text: ink `#241f1a`, secondary `#55504a`, tertiary `#6b6560`,
  faint/placeholder `#9b948d` / `#b7b1a6`.
- Hairlines / borders: `#e4ddd0` (inner row dividers may use `#efece4`).
- Primary buttons: dark ink `#222f30` with `#f4f5f2` text (hover `#2e3d3e`).
- Highlight / signal — the lime family: `#6f9a37` (strong), `#8fbf4d` (mid),
  `#cef79e` (soft fill; hook `em` highlight, done badges), tint `#eef3e2`.
- "Needs attention" amber: text `#b45309`, fill `rgba(180, 83, 9, 0.12)`,
  border `rgba(180, 83, 9, 0.4)`.
- Dark caption/payoff bar: `#222f30` with `#f4f5f2` text and `#cef79e` em.
- **NO purple, NO cool blue-gray.** Cool grays remap to the warm ramp above.

## Type

- UI + headings: `'Aspekta', system-ui, sans-serif`, tracking `-0.025em`.
  Weights 400/500 only.
- Mono (addresses, patterns, variables, code): `'RobotoMono', monospace`,
  tracking 0.
- Both are embedded as base64 `@font-face` rules copied from
  `releases/_build/ci-video-fonts.css` — deterministic, no network fonts.

## Shape & depth

- App window: radius 10px. Inner controls (inputs, buttons, cards): radius 0
  (the website CI is square). Badges/chips: pill `border-radius: 999px`.
- Borders 1px `#e4ddd0`; shadows stay subtle (`0 1px 2px rgba(0,0,0,0.04)`).

## Motion mood

Product-faithful and measured: `power2.out`, 150–350ms, no bounce, no glow.
Rendered cursor for every click (black arrow + soft lime ripple).
Pacing floors: short phrase ≥1.0s static hold after entrance, sentence ≥1.8s;
≥600ms breath after any click/state change before new captions;
final 1.5–2s of each loop completely still.
