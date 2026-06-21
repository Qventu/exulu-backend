# Exulu brand — extracted from frontend/app/globals.css (light theme), 2026-06-10

Light product UI. Clean, near-white surfaces, vivid purple primary, subtle borders
and shadows, small radius. Videos must look like screenshots of the real product.

## Colors

| Token | Hex | Source HSL |
|---|---|---|
| background | #FDFDFD | 0 0% 99.2% |
| foreground | #000000 | 0 0% 0% |
| card | #FDFDFD | 0 0% 99.2% |
| primary | #7033FF | 257.94 100% 60% |
| primary-foreground | #FFFFFF | 0 0% 100% |
| secondary | #EDF0F4 | 214.3 24.1% 94.3% |
| muted | #F5F5F5 | 0 0% 96.1% |
| muted-foreground | #525252 | 0 0% 32.2% |
| accent | #E2EBFF | 221.4 100% 94.3% |
| accent-foreground | #1E69DC | 216.3 76% 49% |
| destructive | #E54B4F | 358.4 74.8% 59.6% |
| border | #E7E7EE | 240 17.1% 92% |
| input (border) | #EBEBEB | 0 0% 92.2% |
| sidebar | #F5F8FB | 210 42.9% 97.3% |
| success / chart-green | #4AC885 | 148.1 53.4% 53.7% |

## Typography

- Sans: 'Inter', system-ui, sans-serif — all UI text. Letter-spacing -0.025em.
- Mono: 'JetBrains Mono', monospace — code, badges with technical values.
- Serif ('Merriweather') exists but is rarely used; avoid in these videos.

## Shape & depth

- Radius: 0.4rem (≈6px) on cards, buttons, inputs. Round-full only for check badges/avatars.
- Borders: 1px solid #E7E7EE on cards and inputs.
- Shadows: very subtle — `0px 2px 3px rgba(0,0,0,0.16), 0px 1px 2px -1px rgba(0,0,0,0.16)`.
- Buttons: primary = #7033FF bg, white text, radius 0.4rem, h ~36px, font-medium 14px.
  Outline variant = white bg, #E7E7EE border, black text. Ghost = transparent.

## Motion mood

Product-demo crisp: short eases (power2/power3.out), 300–500ms moves, no bounce,
no flashy gradients. Captions in Inter, near-black on light, or white-on-purple chips.
Backdrop for shorts: #F5F8FB → #FDFDFD soft gradient, never dark.
