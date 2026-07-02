# Release Page A — "Exulu, made calm" (frontend redesign)

Folder: `releases/2026-06-22-new-exulu-redesign/`
Source: redesign merged to frontend `main` 2026-06-20 (`cb3cb68`); see `frontend/design/IMPLEMENTATION_PLAN.md`.

## Release framing
- **Title:** Exulu, made calm.
- **Tagline:** One workspace that shows you only what your role needs — and gets you there in a single click.
- **Hero paragraph:** Exulu grew feature by feature into the most capable, sovereign AI platform in its class. This release makes all of that power feel like one thing: a calm command center that adapts to who just logged in, works the same on a phone as on a 1440-px display, and is honest about what the AI is doing under the hood. Nothing was removed — everything just found its place.
- **Tone:** Calm. Capable. Honest. (philosophy.md)

## Brand tokens (from frontend/app/globals.css + tailwind.config.js — light theme)
- Primary purple: `hsl(257.94 100% 60%)` (dark `257.67 100% 68%`) — the only accent, primary action + active state
- Background: `hsl(0 0% 99.2%)`; Card: `hsl(0 0% 99.2%)`
- Sidebar surface: `hsl(210 42.9% 97.3%)`; Sidebar active fill: `hsl(240 4.8% 95.9%)`
- Muted: `hsl(0 0% 96.1%)`; Muted-foreground: `hsl(0 0% 32.2%)`; Border: `hsl(240 17% 92%)`
- Semantic: success `hsl(142 76% 36%)`, warning `hsl(32 95% 44%)`, info `hsl(221 83% 53%)`, destructive `hsl(358 75% 60%)`
- Font sans: Inter (400/500/600/700); mono: JetBrains Mono; Radius: 0.4rem; Tracking: -0.025em

## Shorts (16:9, 7–9s each, one slice each)

### 1. The Spine — navigation that knows your role  ← PROOF-FIRST HERO
- **Hook:** Calm, role-aware navigation — a pure end-user sees a 4-item chat app, an admin sees a grouped command center, and the purple indicator slides to show where you are.
- **Arc:** (1) app shell at rest, purple Spine indicator next to active "Chat"; (2) click "Knowledge" → 3px purple bar slides vertically to the new item (layoutId spring, ~200ms), row gains `bg-sidebar-accent`; (3) admin tree (Workspace · Build · Develop · Administration) crossfades to the P1 end-user view — just Chat · Projects · Transcripts, no group headers. Caption: "Same shell. RBAC-composed."
- **Reconstruct:** chrome "L" = top bar (`h-12 bg-sidebar`, no bottom border) + sidebar share one surface; content in inset card `rounded-tl-2xl border-l border-t border-sidebar-border bg-background`. Nav item `h-8 rounded-md px-2 text-sm`; inactive `text-sidebar-foreground/70`, active `bg-sidebar-accent font-medium text-foreground`. Spine: `absolute -left-2 h-4 w-[3px] rounded-full bg-primary`. Group headers `text-[11px] uppercase tracking-wider text-muted-foreground/70`. Icons lucide `size-4 stroke-[1]`. Top bar right: ⌘K search pill `h-8 w-56 rounded-md border border-input`, avatar.
- **Snippet:** none (pure UI).

### 2. Mobile, for real
- **Hook:** 13 screens used to render nothing on a phone. Now every surface passes at 390px — chat full-screen, tables become cards, nav one tap away.
- **Arc:** 390px Today dashboard (triage-first) → tap hamburger → nav drawer slides in from left (300ms + scrim) → tap Chat → full-screen chat with bottom-pinned composer.
- **Reconstruct:** `components/shell/mobile-topbar.tsx` (`h-12 border-b bg-background`, hamburger + truncated page label + avatar); drawer = AppSidebar as left Sheet `w-[18rem]`, items `h-11` (44px). Home reorder: `(home)/components/home-dashboard.tsx` (`order-*`, Vitals `grid-cols-2 md:grid-cols-4`).
- **Snippet:** none.

### 3. One design system (before / after)
- **Hook:** Three font weights replaced one chaotic scale, "informational" stopped rendering purple, and 53 files of hand-picked greens/reds became real semantic tokens — in both themes.
- **Arc:** BEFORE `text-4xl font-black tracking-tighter` editorial hero + purple "info" badge + clashing raw greens/reds → wipe → AFTER calm scale (`text-2xl font-semibold` → `text-lg` → `text-base`), blue `--info`, unified `--success/--warning/--info`; quick light↔dark swap.
- **Reconstruct:** token values as on-screen proof (`--info: 221 83% 53%`, type scale). Source: `globals.css:33–153`, `tailwind.config.js`.
- **Snippet:** none (show token values as design-data overlay).

### 4. Role-composed Home (Today)
- **Hook:** Your homepage is built from your role — triage first: what needs attention, what to resume, the numbers that matter.
- **Arc:** Today page assembles region by region (Needs attention → Resume → Vitals 2×2), reordered per persona.
- **Reconstruct:** `(home)/components/home-dashboard.tsx`; StatCards `components/primitives/stat-card.tsx`; Vitals `grid grid-cols-2 gap-4 md:grid-cols-4`.
- **Snippet:** none.

## Outputs
- `shorts/the-spine.mp4` (+ others when batched) — 1920×1080
- `index.html` — hero + 4 sections (embedded video, 2–3 paragraphs each), footer CTA
- `hyperframes/` — source project
