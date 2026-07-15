# Exulu brand — extracted fresh from frontend/app/globals.css (2026-07-08)

Light-theme product UI. The demo must look like the real app, not a stylized promo.

## Palette (light theme, hex converted from the live HSL tokens)

- background: #FDFDFD        (hsl 0 0% 99.2%)
- foreground: #000000
- card / popover: #FCFCFC     (hsl 0 0% 98.8%)
- primary: #7033FF            (hsl 257.94 100% 60%) — vivid purple; buttons, accents
- primary-foreground: #FFFFFF
- secondary: #EDF1F5          (hsl 214.3 24.1% 94.3%)
- muted: #F5F5F5
- muted-foreground: #525252   (hsl 0 0% 32.2%)
- accent: #E2EBFF             (hsl 221.4 100% 94.3%) — soft tinted chips/callouts
- accent-foreground: #1E69DC  (hsl 216.3 76% 49%)
- destructive: #E54B50        (hsl 358.4 74.8% 59.6%)
- border: #E7E7EE             (hsl 240 17% 92%)
- code surface: #22253A       (hsl 231 15% 18%) with foreground #F7F7EF

## Type

- Sans: 'Inter', system-ui, sans-serif (body + headings; tracking -0.025em)
- Mono: 'JetBrains Mono', monospace (code, file contents)

## Shape & depth

- Radius: 0.4rem (~6px) on cards, menus, buttons; small, not pill-shaped
- Shadows: subtle — 0px 2px 3px rgba(0,0,0,0.16), popovers slightly stronger
- Borders: 1px #E7E7EE everywhere; the UI reads as light, calm, bordered

## Motion mood

Product-faithful and measured: power2.out easing, 150–350ms UI transitions,
no bounce, no glow. The purple #7033FF is the only loud element.
