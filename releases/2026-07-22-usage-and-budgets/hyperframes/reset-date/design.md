# Exulu release shorts — WEBSITE CI (2026-07-22, supersedes the product-CI design.md)

The releases master page standardized on the WEBSITE CI, not the product CI.
Every short is a warm, editorial stage with the app UI reconstructed inside a
contained window. Reference frame: the connect-modal short (cream stage,
centered app window, generous margins).

## Stage

- Canvas 1920×1080, warm cream `#f8f6f1` background (optional faint lime
  radial wash `rgba(111,154,55,0.07)` at top).
- App UI lives in a centered contained window: rounded ~10px, 1px border
  `#e4ddd0`, subtle warm shadow (`0 24px 60px rgba(36,31,26,0.10), 0 2px 8px
  rgba(36,31,26,0.06)`), generous margins around it.

## Palette

- Surfaces: `#fbfaf7` (cards/window) / `#f8f6f1` (stage); muted panels `#efece4`.
- Text: ink `#241f1a`, secondary `#55504a`, tertiary `#6b6560`,
  placeholder/disabled `#b7b1a6`.
- Hairlines/borders: `#e4ddd0` (softer inner dividers `#efece4`).
- Primary buttons: dark ink `#222f30` (hover `#2e3d3e`), text `#f4f5f2`.
- Charts / progress / success: lime family `#6f9a37` / `#8fbf4d` / `#cef79e`.
- Warning states: amber (`#d97706`-family). Red ONLY for over-budget.
- NO purple, NO cool blue-gray anywhere.

## Type

- UI + headings: 'Aspekta' (400/500), tracking -0.025em.
- Numbers / code / mono: 'RobotoMono', tracking 0, tabular by nature.
- Both embedded as base64 @font-face (copied from _build/ci-video-fonts.css).

## House caption style

- Hook: centered on cream — mono eyebrow chip (white, 1px `#e4ddd0` border,
  letter-spacing 0.12em, lime dot) + 84–90px Aspekta headline, key phrase
  highlighted with a `#cef79e` background `<em>`.
- Payoff: full-width dark bar (`#222f30`) rising from the bottom edge, 34–38px
  line, key phrase in `#cef79e`.

## Motion

- Product-faithful: power2.out, 150–350ms, no bounce. Chart draw ~900ms,
  power2.inOut (SVG path reveal, deterministic hardcoded data).
- Read-time floors: short phrase ≥1.0s static after entrance; sentence ≥1.8s.
  ≥600ms breath after any click/state change. Final 1.5–2s completely still.
- A rendered cursor (black arrow, white outline, lime click ripple) for every
  click.
- Single paused GSAP timeline registered on `window.__timelines["main"]`.
