# Research — Public Agents / Guest Access (shipped 2026-07-20/21)

Sources:
- Design spec: `frontend/docs/superpowers/specs/2026-07-16-public-agents-design.md`
- Implementation plans: `frontend/docs/superpowers/plans/2026-07-20-public-agents-backend.md` (1135 lines), `frontend/docs/superpowers/plans/2026-07-20-public-agents-frontend.md` (2490 lines)
- Backend branch `develop` (merge `cc689ab feat(public-agents): merge guest access feature branch`)
- Frontend `main` working tree (merge `ef3c00e feat(public-agents): merge public guest agent access` + follow-ups `f33d1aa`, `4ec7bd5`, `7052237`, …)

Absolute repo roots below: `backend/` = `/Users/daniel.claessen/Desktop/Projects/exulu/backend`, `frontend/` = `/Users/daniel.claessen/Desktop/Projects/exulu/frontend`.

---

## What shipped & why it matters

Agents built on Exulu can now be shared with people **outside the organization**. Any editor with write access to an agent flips on "Enable guest access" in the agent editor, and the agent appears at `<domain>/public/agents` — a clean, brand-themed public area with no internal app shell. If exactly one agent is published, visitors land straight in its chat; if several are, they get a selection grid with avatar, name, description and an access-mode badge. The editor hands you the public link with a one-click Copy button. Nothing about the agent's internals leaks: the public endpoints return a hard-whitelisted projection (id, name, description, avatar, welcome message, auth mode, cover flag) — never instructions, tools, or model (`backend/src/exulu/public-agents.ts:16-40`, "The ONLY projection public endpoints may return").

Each agent gets one of **three access modes** (spec §1): **Public** — "Anyone with the link can chat. No sign-in."; **Password** — "Visitors must enter a shared password." (a bcrypt-hashed shared secret, verified server-side, remembered per-agent in an httpOnly cookie); **Login** — "Visitors must sign in or register with their email." Login mode brings real self-registration for external users: email + password or OTP code, on a branded sign-in page whose right-hand cover image is customizable per agent. Self-registered visitors become real `type='external'` users with a seeded rights-less `external` role — they get persistent chat sessions and a history rail, but are fenced out of the internal app entirely (any attempt redirects to `/public/agents`) and are exempt from the workforce email-domain allowlist.

It is **safe by default**. Anonymous guest traffic is rate-limited per IP (10 messages/minute, 60/hour → HTTP 429) and size-capped (8,000 chars per message, 32,000 total, max 100 text parts → HTTP 413) *before* any LLM call and even before the password check — so failed password guesses burn limiter budget instead of becoming a bcrypt oracle (`backend/src/exulu/routes.ts:886-899`). Guest passwords are stored only as bcrypt hashes and the hash column is flagged `hidden` so it can never surface through GraphQL or REST. Every public endpoint re-checks `guest_access` per request, so unpublishing an agent takes effect immediately. Anonymous chats create no server-side sessions at all — transcripts live only in the visitor's browser (localStorage, last 50 messages). And the editor actively nags you to set a spend cap: "Strongly recommended: set an overall budget for this agent before exposing it publicly."

---

## UI reconstruction cues

All public pages use the product theme (backend `GET /theme` CSS variables injected into `:root`/`.dark`), fonts via `fontVariables`, body `flex min-h-dvh flex-col bg-background font-sans antialiased` (`frontend/app/public/agents/layout.tsx:72-77`).

### 1. Agent selection page — `/public/agents`
- Server page: `frontend/app/public/agents/page.tsx` — 0 agents → `<PublicNote kind="empty" />`; backend unreachable → `kind="misconfigured"`; exactly 1 agent → `redirect('/public/agents/{id}')`; >1 → grid.
- Grid: `frontend/app/public/agents/components/public-agents-grid.tsx`
  - `<main className="mx-auto w-full max-w-4xl grow px-4 py-12">`
  - `<h1 className="text-2xl font-semibold">` → **"Choose an agent"**; sub `<p className="text-sm text-muted-foreground">` → **"Select an agent to start chatting."**
  - Card grid: `mt-8 grid gap-4 sm:grid-cols-2`; each card is a `<Link>` wrapping shadcn `<Card className="h-full transition-colors group-hover:border-primary/50 …">` with `<CardContent className="flex items-start gap-4 p-4">`.
  - Avatar fallback: `flex size-12 shrink-0 items-center justify-center rounded-full bg-muted text-lg font-medium` containing `agent.name.charAt(0)` (S3 avatar can't be presigned unauthenticated — initial-letter avatar by design, lines 37-43).
  - Name `truncate font-medium`; description `line-clamp-2 text-sm text-muted-foreground`.
  - Access badge (only when mode ≠ public): `<Badge variant="outline">` with lucide `Lock` (`size-3`) for **"Password protected"** or lucide `UserRound` for **"Login required"** (icon-only, label via `aria-label`/`title`).
- Terminal states: `frontend/app/public/agents/components/centered-note.tsx` — `flex min-h-dvh items-center justify-center p-8` > `max-w-sm space-y-2 text-center` > `<h1 className="text-lg font-semibold">` + `<p className="text-sm text-muted-foreground">`. Copy (messages/en.json `publicAgents.*`): empty = "No agents available" / "There are currently no published agents."; notFound = "Agent not found" / "This agent does not exist or is no longer available."; misconfigured = "Something went wrong" / "The server is not reachable. Try again later."; unavailable = "This agent is no longer available" / "It may have been unpublished."

### 2. Per-agent gate page — `/public/agents/[id]`
- Server gate: `frontend/app/public/agents/[id]/page.tsx:93-129` + pure decision fn `frontend/lib/public-agents/gate.ts:14-26` (`decideGate(mode, hasPasswordCookie, isAuthenticated)` → `"chat-anonymous" | "password-gate" | "auth-redirect" | "chat-authenticated"`). Password cookie is re-verified against the backend on EVERY load, so rotated passwords / unpublished agents kick visitors back to the gate (page.tsx:100-105).
- Password gate: `frontend/app/public/agents/[id]/guest-password-gate.tsx`
  - Wrapper `flex min-h-dvh items-center justify-center p-8`; `<form className="w-full max-w-sm space-y-3">`.
  - `<h1 className="text-lg font-semibold">` → **"This agent is password protected"**
  - Error `<p className="text-sm text-destructive">` → **"Incorrect password. Try again."**
  - `<Input type="password" placeholder="Password" autoFocus />`
  - `<Button type="submit" className="w-full">` → **"Continue"** (pending: **"Checking…"**).
  - Submit calls server action `setGuestPassword` (`frontend/app/public/agents/[id]/actions.ts`) which sets httpOnly cookie `guest_pw_{id}` scoped to `/public/agents/{id}`, then redirects to the chat.

### 3. Login / registration page — `/public/agents/[id]/auth`
- Server page: `frontend/app/public/agents/[id]/auth/page.tsx` — only `guest_auth_mode === "regular"` agents get this page; cover = `${BACKEND}/public-agents/{id}/cover` when `guest_has_cover`, else `${BACKEND}/cover.jpg`; wraps in shared `AuthShell` with `termsHref={process.env.TERMS_URL}`.
- Frame: `frontend/app/(authentication)/components/auth-shell.tsx` — `flex min-h-dvh flex-col`; `<main className="grid grow lg:grid-cols-2">`; left column `flex items-center justify-center px-4 py-8 lg:py-12` > `w-full max-w-[350px] flex-col gap-8` with the `<Brand />` wordmark; right pane `hidden bg-muted lg:block` full-bleed `<img className="size-full object-cover">` (the per-agent cover image); footer `flex min-h-14 items-center justify-between gap-4 border-t px-4` with © year, terms link, EN/DE locale switcher.
- Form: `frontend/app/public/agents/[id]/auth/public-auth.tsx`
  - `<h1 className="text-2xl font-semibold">` → **"Sign in to chat with {agent}"** (register tab: **"Create an account"**).
  - Labels: **"Email"**, **"Password"**; register hint `text-xs text-muted-foreground` → **"At least 8 characters"** (minLength 8).
  - Submit `<Button className="w-full">`: OTP mode → **"Continue"**; else **"Sign in"** / **"Register"**.
  - Tab switch link (`text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground`): **"New here? Create an account"** / **"Already have an account? Sign in"**.
  - When SMTP missing: `text-xs text-muted-foreground` → **"Registration is currently unavailable."** Error copy: **"Something went wrong. Try again."**
  - Register/OTP flow → `POST /api/public-auth/ensure-user` then `signIn("email")` → shared `OtpStep` 6-digit code screen (reused from `/login`).

### 4. Guest chat — `/public/agents/[id]` (both modes)
- Screen: `frontend/app/public/agents/[id]/components/public-chat-screen.tsx`
  - Reuses the internal `MessageColumn` + `Composer` verbatim (imports from `app/(application)/chat/components/`), with `<Composer controller={controller} guestMode />` — guestMode hides the ＋ menu (prompts/knowledge/capabilities are internal surfaces, line 180-182).
  - Header (lines 139-173): `flex h-12 shrink-0 items-center gap-3 border-b bg-background px-4` — agent avatar `size-7 rounded-full object-cover`, name `min-w-0 truncate text-sm font-medium`, right side `ml-auto flex items-center gap-1` with ghost `sm` buttons: **"Clear conversation"** and (authenticated only) lucide `LogOut` icon + **"Sign out"** (`hidden sm:inline` label). Authenticated mobile: lucide `PanelLeft` ghost icon button (`lg:hidden`, aria-label **"History"**) opens the history Sheet.
  - Anonymous layout: standalone `flex h-dvh min-h-0 flex-col`, no rail. Authenticated: `flex min-h-0 min-w-0 flex-1 flex-col` beside a docked history rail.
  - Body: `MessageColumn` owns scroll (flex-1), Composer in `shrink-0` wrapper — mirrors internal session-screen.
- History rail (logged-in guests): `frontend/app/public/agents/[id]/components/public-chat-shell.tsx` — reuses the internal `HistoryRail` with public paths (`/public/agents/{id}?session={sid}`), `hideAgentSwitcher`, host `flex h-dvh min-h-0 w-full overflow-hidden`; rail collapse persisted under localStorage key `publicChat.historyRail.collapsed`; docked ≥`lg` (1024px), Sheet below.
- Controller: `frontend/app/public/agents/[id]/components/use-public-chat-session.ts` — anonymous mode posts FULL history to the proxy and persists transcripts to localStorage (`frontend/lib/public-agents/transcript-store.ts`, key `exulu_public_chat_{agentId}`, last 50 messages); authenticated mode lazily creates a server session and posts only the last message + `Session` header. Error toasts (`publicAgents.chat`): 429 → **"You're sending messages too quickly. Please wait a moment."**; 413 → **"Your message is too long."**; 404/403 mid-chat → **"This agent is no longer available"**; else **"Sending failed. Try again."** Client-side input cap `GUEST_MAX_INPUT = 8000` (line 70).
- SSE proxy: `frontend/app/public/agents/[id]/chat/route.ts` — same-origin POST; a "credential translator, not a gate": regular mode attaches `Authorization: Bearer <session JWT>` server-side, password mode reads the `guest_pw_{id}` cookie into an `x-guest-password` header; pipes the backend event-stream through.

### 5. Agent editor — Guest access section
- `frontend/app/(application)/agents/edit/[id]/sections/guest-access.tsx` (registered in editor-view.tsx between Access and Safety; section id `guest-access`, `scroll-mt-20 space-y-4`, card `space-y-6 rounded-lg border p-4`).
- Section heading `<h2 className="text-lg font-medium">` → **"Guest access"**; description → **"Publish this agent to external users at /public/agents."**
- Master `<Switch id="guest-access-toggle">` labeled **"Enable guest access"** with warning `text-xs text-muted-foreground` → **"When enabled, this agent's name, description and avatar are publicly listed on the /public/agents page."**
- When enabled, a `RadioGroup` labeled **"Access mode"** with three options (label + `text-xs text-muted-foreground` hint):
  - **"Public"** — "Anyone with the link can chat. No sign-in." (value `public`)
  - **"Password"** — "Visitors must enter a shared password." (value `password`)
  - **"Login"** — "Visitors must sign in or register with their email." (value `regular`)
- Password mode: `<Input id="guest-password" type="password">` labeled **"Password"**, placeholder **"Enter a password"**; when one is stored: **"A password is set. Leave blank to keep it."**
- Login mode without SMTP: `<Alert>` → **"Email (SMTP) is not configured — external users won't be able to register. Login mode requires SMTP for sign-up codes."**
- **"Public link"**: read-only `<Input className="font-mono text-xs">` with `{origin}/public/agents/{agent.id}` + outline `sm` button lucide `Copy` → **"Copy"** (flips to lucide `Check` for 2s, toast **"Link copied"**).
- **"Login page image"** ("Shown on the right side of the sign-in page for this agent.") — Uppy file picker (`.jpg .jpeg .png .webp`, limit 1), ghost button **"Remove image"**.
- **"Budget"** block: destructive `<Alert>` when no `max_budget` → **"Strongly recommended: set an overall budget for this agent before exposing it publicly."**; `BudgetBar` + inline `BudgetEditor` behind outline button **"Set budget"**; without rights: **"You don't have budget-management rights. Ask a budget admin to set a budget for this agent."**
- Save path: `frontend/app/(application)/agents/edit/[id]/hooks.ts` sends `guest_access`, `guest_auth_mode`, `guest_password` (plaintext, only when non-empty), `guest_cover_image` on the agent update mutation; plaintext is cleared client-side after save.

---

## Developer surfaces

### Public REST endpoints (unauthenticated, backend `src/exulu/routes.ts`)
All under "---- Public agents (spec 2026-07-16-public-agents §3.3) ----" (`routes.ts:5232`). Every handler re-queries `WHERE guest_access = true AND active = true` (`getGuestAgentById`, routes.ts:5254-5262) so unpublishing is immediate; non-UUID ids 404 fast.

| Method + path | File:line | Response |
| --- | --- | --- |
| `GET /public-agents` | `routes.ts:5264-5285` | `200` JSON array of `PublicAgentView` |
| `GET /public-agents/:id/meta` | `routes.ts:5287-5294` | `200` one `PublicAgentView`; `404 {"detail":"Not found."}` |
| `GET /public-agents/:id/cover` | `routes.ts:5296-5325` | image bytes from S3 (`image/png`/`image/webp`/`image/jpeg` by extension, `Cache-Control: public, max-age=300`, `X-Content-Type-Options: nosniff`); `404 {"detail":"Not found."}` / `{"detail":"Cover not found."}` |
| `POST /public-agents/:id/verify-password` | `routes.ts:5327-5351` | body `{"password": "..."}` → `204` on match; `401 {"detail":"Incorrect password."}`; `404` when not password mode; `429 {"detail":"Too many requests. Try again later."}` (rate-limited BEFORE DB/bcrypt, routes.ts:5330-5335) |

`PublicAgentView` shape (`backend/src/exulu/public-agents.ts:5-14`):
```ts
{ id, name, description, image, welcomemessage, slug,
  guest_auth_mode: "public" | "password" | "regular",
  guest_has_cover: boolean }
```
`slug` is the agent-run route prefix (LiteLLM mode: `"/agents/litellm/run"`, `routes.ts:5241`), so the chat POST target is `{BACKEND}{slug}/{id}`.

### Guest gate on the agent run route — `POST {slug}/:instance`
- Handler registered at `routes.ts:832-833` (`registerAgentRunRoute`). Guest logic `routes.ts:886-931`:
  - anonymous → `guestRateLimitExceeded(ip)` → `429 {"detail":"Too many requests. Try again later."}`; `guestMessageTooLong(body)` → `413 {"detail":"Message too long."}` — deliberately BEFORE the password gate ("prevents bcrypt oracle", routes.ts:887-888);
  - `evaluateGuestChatAccess(agent, user?.id, req.headers["x-guest-password"])` → `401 {"detail":"Password required." | "Incorrect password." | "Authentication required."}`;
  - `guestGate.allowed` short-circuits `checkRecordAccess` (routes.ts:923-924) — run-only access.
- Decision logic: `backend/src/exulu/public-agents.ts:55-89` (`evaluateGuestChatAccess`). Key semantics: when `guest_access=true` the guest mode GOVERNS anonymous access even over legacy `rights_mode=public` (fix `4262d88`); any authenticated user may run a guest-enabled agent; legacy `rights_mode=public` anonymous path preserved for non-published agents.

### Rate limits & caps — `backend/src/exulu/guest-rate-limit.ts`
- In-process fixed-window per-IP limiter, two windows (lines 1-77): `EXULU_GUEST_RATE_PER_MINUTE` default **10**/min, `EXULU_GUEST_RATE_PER_HOUR` default **60**/hour.
- Message caps (lines 102-122): `EXULU_GUEST_MAX_MESSAGE_CHARS` default **8000** per text part; `EXULU_GUEST_MAX_TOTAL_CHARS` default **32000** across the payload; `MAX_PART_COUNT = 100`.
- IP map capped at **10,000** entries with stale-prune (≥1h unseen) + oldest-first eviction (lines 58-75).
- `extractClientIp` (lines 132-145): honors last `x-forwarded-for` hop only when `EXULU_TRUST_PROXY=true`, else raw socket address.

### Data model, GraphQL & auth
- Columns on `agents` (`backend/src/postgres/core-schema.ts:290-313`): `guest_access` boolean default false; `guest_auth_mode` text default `"regular"` (`'public' | 'password' | 'regular'`); `guest_password_hash` text `hidden: true` ("NEVER exposed via GraphQL/REST"); `guest_cover_image` text (S3 key of login-page image).
- `external` role seed: `backend/src/postgres/init-exulu-db.ts:405-414` — "All permission areas null: external (self-registered) users can chat with guest-enabled agents but hold no platform rights."
- Password hashing: `backend/src/exulu/shared-artifacts.ts:69-75` — `hashSharePassword` = `bcrypt.hash(password, 10)`, `verifySharePassword` = `bcrypt.compare`.
- Mutation transform: `backend/src/graphql/utilities/agent-guest-fields.ts` — plaintext `guest_password` input → bcrypt hash; client-supplied `guest_password_hash` discarded; switching mode away from `password` clears the hash.
- Frontend self-registration: `POST /api/public-auth/ensure-user` (`frontend/app/api/public-auth/ensure-user/route.ts`) — requires `EMAIL_SERVER_HOST` (else 503 "Registration is unavailable."); per-IP **5/minute** (`frontend/lib/public-auth/rate-limit.ts:2-3`); creates `type='external'` rows with the seeded external role; byte-identical `{ ok: true }` response (no email enumeration); "last-unverified-registrant-wins" pre-hijack fix; bcrypt cost 12.
- External fencing: `frontend/app/(application)/layout.tsx:43-45` — `if ((user as any).type === "external") return redirect("/public/agents");`.
- Domain-allowlist exemption: `frontend/lib/auth/domain-allowlist.ts:7-22` — `ALLOWED_EMAIL_DOMAINS` skipped when `existingUserType === "external"`.

---

## Demo-worthy moments

1. **Publish an agent in 30 seconds** — Admin opens Agents → edit → "Guest access" section → flips "Enable guest access" → picks Access mode "Public" ("Anyone with the link can chat. No sign-in.") → the "Public link" field shows `https://…/public/agents/{id}` → clicks "Copy" (icon flips to a check, toast "Link copied") → pastes the link to a customer. Beat to include: the red budget alert "Strongly recommended: set an overall budget…" and the one-click "Set budget" editor right below.
2. **Anonymous visitor journey** — Visitor opens `/public/agents` → "Choose an agent" grid (cards with letter-avatars, "Password protected" lock badge on one) → clicks a public agent → lands straight in a clean h-dvh chat: agent avatar + name in a slim header, welcome message, composer → chats with streaming responses → refreshes the page → the transcript is still there (localStorage, no account, no server session) → "Clear conversation" wipes it.
3. **Password gate** — Visitor clicks the lock-badged agent → centered card "This agent is password protected" → wrong entry → red "Incorrect password. Try again." → correct password → "Checking…" → chat opens; the cookie is httpOnly and re-verified every load, so when the admin rotates the password the visitor is bounced straight back to the gate.
4. **External user with real history** — Agent in Login mode → visitor hits `/public/agents/{id}/auth`: branded two-column sign-in with the agent's custom cover image on the right, headline "Sign in to chat with {agent}" → "New here? Create an account" → email + password ("At least 8 characters") → 6-digit OTP code from email → chat with a docked session history rail, "New chat", resumable sessions via `?session=`, and "Sign out". Kicker: that same external user trying to open the internal app gets bounced to `/public/agents`.
5. *(Safety b-roll)* Rapid-fire messages → toast "You're sending messages too quickly. Please wait a moment." (per-IP 10/min, 60/h); giant paste → "Your message is too long." (8k chars).

---

## Flags / requirements

- **No global on/off flag for the public area** — `/public/agents` routes always exist; the area is empty ("No agents available") until at least one agent has `guest_access=true`. Publication is per-agent via the editor switch.
- **Config flag shipped with the route group**: `public_auth.otp_available = !!process.env.EMAIL_SERVER_HOST` in the public + authentication layouts' ConfigContext (`frontend/app/public/agents/layout.tsx:41-43`, `frontend/components/shell/config-context.tsx:16-18`). Gates OTP flows and the register tab; without SMTP the auth page is login-only and the editor shows the SMTP hint.
- **Env vars**:
  - `BACKEND` — public backend base URL; all public pages/proxy fetch `${BACKEND}/public-agents…` (misconfigured → "Something went wrong" page).
  - `AUTH_MODE` — `otp` vs password; the public auth page follows it (spec §2 "Auth method").
  - `EMAIL_SERVER_HOST` (+ SMTP suite) — required for external registration; without it `POST /api/public-auth/ensure-user` returns 503.
  - `EXULU_GUEST_RATE_PER_MINUTE` (default 10), `EXULU_GUEST_RATE_PER_HOUR` (default 60), `EXULU_GUEST_MAX_MESSAGE_CHARS` (default 8000), `EXULU_GUEST_MAX_TOTAL_CHARS` (default 32000) — guest limiter tuning (`backend/src/exulu/guest-rate-limit.ts:11-18`); part count hard-capped at 100.
  - `EXULU_TRUST_PROXY=true` — trust the last `x-forwarded-for` hop for the limiter's client IP.
  - `TERMS_URL` — terms link in the public auth page footer; `ALLOWED_EMAIL_DOMAINS` — workforce allowlist, externals exempt.
- **The `external` role**: seeded on boot (`backend/src/postgres/init-exulu-db.ts:405-414`), all permission areas null; users created with `type='external'` + this role. Registration fails 503 if the seed is missing ("external role missing — backend seed not run?").
- **Rate-limit numbers (summary)**: guest chat 10/min + 60/h per IP → 429; message caps 8,000 per part / 32,000 total / 100 parts → 413; verify-password shares the same limiter; ensure-user registration 5/min per IP → 429; anonymous transcripts capped at 50 messages in localStorage.
- **Known limitation** (spec §10 note in controller): guest chat has no tool-approval surface — agents published to guests must not rely on approval-gated tools.
