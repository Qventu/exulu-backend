# Exulu — Brand Design Tokens

Source of truth extracted from `frontend/app/globals.css` (light theme), 2026-07-02. Use exact values; do not invent colors or substitute fonts.

## Palette (light theme — the product is light-first)

| Token | HSL | Hex | Use |
|---|---|---|---|
| Primary (Exulu purple) | `257.94 100% 60%` | `#7033FF` | The ONLY accent — primary action + active/selected state |
| Background | `0 0% 99.2%` | `#FDFDFD` | App canvas / content card |
| Foreground | `0 0% 0%` | `#000000` | Primary text |
| Card | `0 0% 99.2%` | `#FDFDFD` | Section card backgrounds |
| Muted | `0 0% 96.1%` | `#F5F5F5` | Quiet surfaces, badge backgrounds |
| Muted foreground | `0 0% 32.2%` | `#525252` | Secondary text, captions |
| Accent | `221.38 100% 94.3%` | `#DBE9FF` | Soft tinted backgrounds (callout blocks, pills) |
| Accent foreground | `216.32 76% 49%` | `#2264C8` | Text on accent surfaces |
| Border | `240 17.1% 92%` | `#E6E6EE` | Hairlines, card borders, input outlines |
| Success | `142.1 76.2% 36.3%` | `#16A34A` | Green status |
| Destructive | `358.4 74.8% 59.6%` | `#E5484D` | Red / failed states |
| Code surface | `231 15% 18%` | `#282B3A` | Dark code block backgrounds |
| Code foreground | `60 30% 96%` | `#F7F7F0` | Text on dark code surfaces |

## Typography

- Sans: **Inter** (weights 400/500/600/700). Letter-spacing `-0.025em` on headings/body.
- Mono: **JetBrains Mono** (figures, ids, kbd, code).
- Serif: Merriweather (rare).

## Shape & depth

- Radius: `0.4rem` (≈6.4px) — `rounded-md` for nav items/buttons, cards
- Shadows: subtle only — `0px 2px 3px hsl(0 0% 0% / 0.16)`
- Icons: Lucide, `size-4`, `stroke-width: 1`, neutral color (not purple unless active)

## Motion signature

- Calm, quick, purposeful. Entrances 0.4–0.7s, `power3.out` / `expo.out`.
- One accent doing the work — purple reserved for selected/active only.
- No bouncy motion for product/data UI. `power2.out` for calm states.

## What NOT to do

- Don't render info/neutral UI in purple — purple is reserved for the single primary action + active state.
- Don't use dark-mode chrome — the product is light-first.
- Don't invent a new accent or gradient; one purple, semantic status colors only.
- No heavy font weights as decoration (no `font-black` editorial heroes).
