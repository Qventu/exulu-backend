# Brand snapshot — Exulu (extracted 2026-05-29)

Source of truth: `frontend/app/globals.css` `:root` block + `frontend/tailwind.config.js`.

## Colors (HSL → hex, light theme)

| Token | HSL (raw) | Hex | Usage |
|---|---|---|---|
| `--background` | `0 0% 99.22%` | `#fdfdfd` | Page background |
| `--foreground` | `0 0% 0%` | `#000000` | Body text |
| `--card` | `0 0% 99.22%` | `#fdfdfd` | Section cards |
| `--popover` | `0 0% 98.82%` | `#fcfcfc` | Tooltips, hover popups |
| `--primary` | `257.94 100% 60%` | `#6633ff` | Headlines, accents, primary buttons |
| `--primary-foreground` | `0 0% 100%` | `#ffffff` | Text on primary |
| `--accent` | `221.38 100% 94.31%` | `#dde6ff` | Soft tinted blocks |
| `--accent-foreground` | `216.32 76% 49%` | `#1e6cdc` | Text on accent |
| `--muted` | `0 0% 96.08%` | `#f5f5f5` | Subtle surfaces |
| `--muted-foreground` | `0 0% 32.16%` | `#525252` | Secondary text / captions |
| `--border` | `240 17.07% 91.96%` | `#e8e8ee` | Card borders, dividers |
| `--destructive` | `358.44 74.76% 59.61%` | `#e84e58` | Errors, destructive actions |

## Speaker palette (used by the audio timeline)

These are the deterministic hues each `SPEAKER_NN` gets. Match in the demo:

```
SPEAKER_00 → hsl(210, 80%, 55%)   blue
SPEAKER_01 → hsl(150, 60%, 45%)   green
SPEAKER_02 → hsl(40, 90%, 55%)    amber
SPEAKER_03 → hsl(0, 70%, 60%)     red
SPEAKER_04 → hsl(280, 60%, 60%)   purple
SPEAKER_05 → hsl(180, 60%, 45%)   teal
SPEAKER_06 → hsl(20, 80%, 55%)    orange
SPEAKER_07 → hsl(330, 65%, 60%)   pink
```

## Typography

| Token | Value |
|---|---|
| `--font-sans` | `'Inter', system-ui, sans-serif` |
| `--font-mono` | `'JetBrains Mono', monospace` |
| `--font-serif` | `'Merriweather', serif` |
| `--tracking-normal` | `-0.025em` |

Headings: Inter 700, tight tracking. Body: Inter 400, regular tracking. Code: JetBrains Mono 400/500.

## Radii & shadows

| Token | Value |
|---|---|
| `--radius` | `0.4rem` (~6.4px) |
| `--shadow-sm` | `0px 2px 3px hsl(0 0% 0% / 0.16), 0px 1px 2px -1px hsl(0 0% 0% / 0.16)` |
| `--shadow-md` | `0px 2px 3px hsl(0 0% 0% / 0.16), 0px 2px 4px -1px hsl(0 0% 0% / 0.16)` |

Buttons, inputs, cards all use `--radius`. Avoid the temptation to round more — the product is restrained.

## Mood

Light, calm, vivid purple accent. Not flashy. Not dark-mode dev tool. The brand reads "trustworthy enterprise tool with one striking accent color."

Demo motion: `power2.out` easings, no bouncy `back.out`. Slow enough to read.
