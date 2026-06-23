# Exulu — Brand Design Tokens

Source of truth extracted from `frontend/app/globals.css` + `frontend/tailwind.config.js` (light theme), 2026-06-22. Use exact values; do not invent colors or substitute fonts.

## Palette (light theme — the product is light-first)

| Token | HSL | Hex | Use |
|---|---|---|---|
| Primary (Exulu purple) | `257.94 100% 60%` | `#7033FF` | The ONLY accent — primary action + active/selected state |
| Primary (dark variant) | `257.67 100% 68%` | `#9061FF` | purple in dark mode |
| Background | `0 0% 99.2%` | `#FDFDFD` | app canvas / content card |
| Foreground | `0 0% 0%` | `#000000` | primary text |
| Sidebar surface | `210 42.9% 97.3%` | `#F5F8FB` | chrome: top bar + sidebar share this |
| Sidebar foreground | `240 5.3% 26.1%` | `#3F3F46` | nav item text |
| Sidebar active fill | `240 4.8% 95.9%` | `#F4F4F5` | selected nav row |
| Sidebar border | `220 13% 91%` | `#E5E7EB` | hairline between chrome and content |
| Muted | `0 0% 96.1%` | `#F5F5F5` | quiet surfaces |
| Muted-foreground | `0 0% 32.2%` | `#525252` | secondary text, group headers |
| Border | `240 17% 92%` | `#E6E6EE` | hairlines |
| Input border | `0 0% 92.2%` | `#EBEBEB` | field outlines (⌘K pill) |
| Success | `142 76% 36%` | `#16A34A` | green status |
| Warning | `32 95% 44%` | `#DB8500` | amber status |
| Info | `221 83% 53%` | `#2563EB` | blue status (NEW — info is no longer purple) |
| Destructive | `358 75% 60%` | `#E5484D` | red / failed |

## Typography
- Sans: **Inter** (weights 400/500/600/700). Letter-spacing `-0.025em` on headings/body.
- Mono: **JetBrains Mono** (figures, ids, kbd, code).
- Serif: Merriweather (rare).
- Type scale (redesign): page `text-2xl/600` → section `text-lg` → card `text-base/600` → body `text-sm/400` → caption `text-xs/500 muted`.

## Shape & depth
- Radius: `0.4rem` (≈6.4px) default; `rounded-md` for nav items/buttons; content card top-left `rounded-tl-2xl`.
- Shadows: subtle only — `0px 2px 3px hsl(0 0% 0% / 0.16)`. No heavy/colored glows.
- Icons: lucide, `size-4`, `stroke-width: 1`, neutral color (not purple).

## Motion signature
- Calm, quick, purposeful. Entrances 0.4–0.7s, `power3.out` / `expo.out`.
- The "Spine": a 3px purple bar that slides between active nav items (~200ms, ease-in-out).
- Light, deliberate — one accent doing the work. No "purple confetti".

## What NOT to do
- Don't render "info"/neutral UI in purple — purple is reserved for the single primary action + active state.
- Don't use heavy font weights as decoration (no `font-black` editorial heroes).
- Don't use dark-mode chrome — the product is light-first.
- Don't invent a new accent or gradient; one purple, semantic status colors only.
