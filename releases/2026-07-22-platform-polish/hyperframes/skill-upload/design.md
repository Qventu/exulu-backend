# Design — WEBSITE CI (releases master page standard)

All shorts in this release use the **website CI**, not the product CI. Reference frame:
`/tmp/relframes/ref-connect-modal.png`. House references:
`../../../2026-07-13-connect-your-agent/hyperframes/list-skills/index.html` (caption cards,
paused GSAP timeline on `window.__timelines`, easing) and
`../../../2026-07-16-bulk-import/hyperframes/files-drop/index.html` (app window on cream,
cursor + ripple, payoff bar).

## Stage

- Canvas 1920×1080. Warm cream `#f8f6f1` background, optional subtle lime radial wash
  `radial-gradient(900px 500px at 50% -10%, rgba(111,154,55,0.07), transparent 70%)`.
- App UI sits in a **centered contained window**: rounded ~10px, 1px border `#e4ddd0`,
  subtle warm shadow (`0 1px 2px rgba(0,0,0,0.04)`, optionally + `0 24px 60px rgba(36,31,26,0.07)`),
  generous margins around it.

## Palette

| Role | Hex |
|---|---|
| Stage / page bg | `#f8f6f1` |
| Surfaces | `#fbfaf7` / `#ffffff` / `#f8f6f1` |
| Muted panels | `#efece4` (also `#faf8f4`, `#f4f2ec` for subtle steps) |
| Text ink | `#241f1a` |
| Text secondary | `#55504a` |
| Text tertiary | `#6b6560` |
| Hairlines / borders | `#e4ddd0` |
| Primary buttons | dark ink `#222f30` (hover/active `#2e3d3e`), label `#f4f5f2` |
| Highlight / success | lime family `#6f9a37` / `#8fbf4d` / `#cef79e` |

**NO purple, NO cool blue-gray.** Canonical remap: `releases/_build/reskin-videos-prep.mjs`
(HEX_MAP — e.g. `#7033ff → #6f9a37`, `#fafafa → #f8f6f1`, `#e7e7ee → #e4ddd0`).

## Typography

- UI: `'Aspekta', system-ui, sans-serif`, `letter-spacing: -0.025em`.
- Mono: `'RobotoMono', monospace`, `letter-spacing: 0`.
- Fonts are embedded as the three base64 `@font-face` rules copied verbatim from
  `releases/_build/ci-video-fonts.css` into this composition's `<style>`.

## Caption cards (house style)

- Hook: mono eyebrow chip (white bg, `#e4ddd0` border, lime dot, letter-spacing 0.12em,
  `#55504a`) + big Aspekta headline (~90px, weight 400, ink) with `em` marked in `#cef79e`
  background highlight.
- Payoff: full-width bottom bar `#222f30`, 108px tall, 38px line in `#f4f5f2`, `em` in `#cef79e`.

## Motion rules

- Product-faithful: `power2.out`, 150–350ms, no bounce. Cursor (black arrow SVG, white
  stroke) for every click, with a lime click ripple `rgba(111,154,55,0.25)`.
- Read-time floors: short phrase ≥1.0s static after entrance; sentence ≥1.8s. ≥600ms breath
  after any click/state change before new captions. Final 1.5–2s of the loop completely still.
- Single paused GSAP timeline registered at `window.__timelines["main"]`.
