# Exulu — brand for release shorts

Derived from `frontend/app/globals.css` (light theme `:root`) and `frontend/tailwind.config.js`.
**Pulled fresh on 2026-05-28** — re-extract before any future release run.

## Palette (light theme — default for product releases)

| Token | HSL | Hex | Use |
|---|---|---|---|
| background | `0 0% 99.22%` | `#fdfdfd` | Page / scene background |
| foreground | `0 0% 0%` | `#000000` | Body text |
| card | `0 0% 99.22%` | `#fdfdfd` | Input / surface fill |
| primary | `257.94 100% 60%` | `#5c33ff` | Accent words, mic highlight on hover, hook word color |
| primary-foreground | `0 0% 100%` | `#ffffff` | Text on primary fills |
| accent | `221.38 100% 94.31%` | `#dfe7ff` | Soft tint backgrounds, callout pills |
| accent-foreground | `216.32 76% 49.02%` | `#1e6cdd` | Pill text, link emphasis |
| muted | `0 0% 96.08%` | `#f5f5f5` | Quiet surfaces |
| muted-foreground | `0 0% 32.16%` | `#525252` | Captions, placeholders, idle mic icon |
| border | `240 17.07% 91.96%` | `#e6e6ec` | Card borders, dividers |
| destructive (recording red) | `358.44 74.76% 59.61%` | `#df514a` | Red mic Square when recording |
| **Tailwind `text-red-500` (literal)** | — | `#ef4444` | The actual red used by `text-red-500` in the chat code — use *this* for the recording Square, not `--destructive` |

## Typography

| Role | Family | Weights used | Tracking |
|---|---|---|---|
| Sans / UI / headings | **Inter** | 400, 500, 600, 700 | `-0.025em` body, `-0.04em` hero |
| Mono / code | **JetBrains Mono** | 400, 500 | normal |
| Serif (rarely used) | Merriweather | 400 | normal |

## Geometry

- `--radius`: `0.4rem` (~6.4px) on all surfaces — small, calm
- Shadows: subtle, max two stacked, `0 2px 3px hsl(0 0 0 / 0.16)` (see `--shadow` in globals)
- Spacing rhythm: 4px / 8px / 16px / 24px / 48px (no funky in-between values)

## Motion constraints for this release

- **Easing:** `power2.out` for entrances, `power2.in` for exits. No `back.out`, no bouncy overshoot — the product reads as professional, not playful.
- **No flashy transitions.** Brand has subtle shadow and small radius; matching motion is restrained.
- **Hold the resting frame** for ~1.5s at the end of every short so the loop reads as intentional.

## Don'ts

- Don't introduce a second primary color. The product is monochrome + purple.
- Don't darken the background. Keep it `#fdfdfd`.
- Don't use Roboto, Arial, or generic system sans — Inter is the product.
- Don't render code in a serif font. JetBrains Mono only.
