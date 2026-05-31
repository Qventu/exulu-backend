# Exulu — Brand tokens for hyperframes (2026-05-29 snapshot)

Pulled directly from `frontend/app/globals.css` `:root` block. Light theme — the Exulu product is light by default; do not invert.

## Palette (HSL → hex)

| Role | CSS var | HSL | Hex |
|---|---|---|---|
| Background | `--background` | `hsl(0, 0%, 99.22%)` | `#FDFDFD` |
| Foreground (body text) | `--foreground` | `hsl(0, 0%, 0%)` | `#000000` |
| Card surface | `--card` | `hsl(0, 0%, 99.22%)` | `#FDFDFD` |
| Popover | `--popover` | `hsl(0, 0%, 98.82%)` | `#FCFCFC` |
| **Primary** (headlines, accents, buttons) | `--primary` | `hsl(258, 100%, 60%)` | `#7033FF` |
| Primary foreground | `--primary-foreground` | `hsl(0, 0%, 100%)` | `#FFFFFF` |
| Secondary | `--secondary` | `hsl(214, 24%, 94%)` | `#EDF0F4` |
| Muted | `--muted` | `hsl(0, 0%, 96.08%)` | `#F5F5F5` |
| Muted foreground (captions, secondary text) | `--muted-foreground` | `hsl(0, 0%, 32.16%)` | `#525252` |
| Accent (soft tinted backgrounds) | `--accent` | `hsl(221, 100%, 94.31%)` | `#E2EBFF` |
| Accent foreground | `--accent-foreground` | `hsl(216, 76%, 49.02%)` | `#1E6ADC` |
| Destructive | `--destructive` | `hsl(358, 75%, 59.61%)` | `#E45F62` |
| Border / dividers | `--border` | `hsl(240, 17%, 92%)` | `#E7E7EE` |
| Input | `--input` | `hsl(0, 0%, 92.16%)` | `#EBEBEB` |
| Ring (focus) | `--ring` | `hsl(0, 0%, 0%)` | `#000000` |

### Code chrome (use for terminal / editor panels in the shorts)

| Role | Hex |
|---|---|
| Editor background (dark) | `#0A0A0A` |
| Editor foreground | `#F5F5F5` |
| Editor keyword (use primary tint) | `#A98AFF` |
| Editor string | `#E2EBFF` |
| Editor comment | `#888888` |

## Typography

- **Sans (body, headings):** `Inter`, system-ui, sans-serif — weights 400/500/600/700
- **Mono (code):** `JetBrains Mono`, monospace — weights 400/500
- **Serif:** `Merriweather` — not used in the shorts; mentioned for completeness
- **Tracking:** `-0.025em` (slightly tight) — apply to display text

## Geometry & motion

- **Radius:** `0.4rem` ≈ `6.4px` for cards, buttons, inputs. Pills use full radius.
- **Shadow ladder (subtle, never heavy):**
  - `sm`: `0px 2px 3px 0px rgba(0,0,0,0.16), 0px 1px 2px -1px rgba(0,0,0,0.16)`
  - `md`: `0px 2px 3px 0px rgba(0,0,0,0.16), 0px 2px 4px -1px rgba(0,0,0,0.16)`
- **Easing defaults:** `power2.out` for entrances, `power2.inOut` for transitions. **Never** `back.out` — the product is calm; bouncy easing feels off-brand.
- **Motion budget per scene:** small movements (8–24px translations), short durations (250–450ms for entrances). Captions hold per read-time floors in the animation-recipes reference.

## House style for shorts

- Light backgrounds. Foreground text in `#000000`, captions in `#525252`.
- Headline captions use the primary `#7033FF` for the emphasized word, foreground black for the rest.
- Pills, badges, and chips use `--accent` background (`#E2EBFF`) with `--accent-foreground` text (`#1E6ADC`).
- Simulated cursor: standard arrow pointer, ~24×24px for 1920x1080, ~36×36px for 1080x1920.
- No gradients on the page chrome. The brand is solid color + subtle shadow, not glassmorphism.
- Avoid emojis.
