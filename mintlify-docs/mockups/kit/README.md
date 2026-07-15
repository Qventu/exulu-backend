# IMP replica kit

Scoped CSS building blocks that make a HyperFrames composition read as a
screenshot of the real IMP product — warm paper surfaces, hairline borders,
zero border-radius, no shadows, monospace uppercase labels.

Every composition links the kit with root-relative paths and gets its own
synced copy of the shared files (hyperframes lint rejects `../` asset paths,
and the Studio preview server only serves real files inside the project dir —
symlinks 404):

```html
<link rel="stylesheet" href="tokens.css" />
<link rel="stylesheet" href="fonts.css" />
<link rel="stylesheet" href="kit/app-shell.css" />
<link rel="stylesheet" href="kit/data-table.css" />
<!-- plus dialog.css / chat.css / widgets.css / cursor.css as needed -->
<script src="kit/cursor.js"></script>
```

The single source of truth is `mockups/tokens.css`, `mockups/fonts.css`,
`mockups/fonts/`, and `mockups/kit/`. After editing them — or when creating a
new composition directory — refresh every composition's copies from the repo
root:

```bash
npm run sync-kit   # copies tokens/fonts/kit into every mockups/compositions/*/
```

All colors come from `tokens.css` (the product-replica palette; drift-guarded
by `npm run tokens` at the repo root). Every rule is scoped under its
component root class — nothing leaks into bare elements.

## app-shell.css — application frame

| Class | What it is |
| --- | --- |
| `.imp-shell` | 1600×1000 application frame: flex row, `--bg` paper, hairline border. |
| `.imp-sidebar` | 232px left nav column on `--surface` with hairline right border. |
| `.imp-wordmark` | Product wordmark at the top of the sidebar (15px, weight 500). |
| `.imp-sidebar-group` | Mono-uppercase 11px group label (Workspace / Build / Develop / Administration). |
| `.imp-nav-item` | 13px nav row with a 15px stroke icon; add `.active` for the `--surface-2` highlight. |
| `.imp-topbar` | 52px header strip under-lined with a hairline; space-between layout. |
| `.imp-main` | Flex column holding `.imp-topbar` + `.imp-content`. |
| `.imp-content` | Padded main content region (24px 28px). |
| `.imp-badge` | Mono-uppercase chip on `--chip-soft`; optional `<span class="dot">` accent square. |
| `.imp-btn` | Mono-uppercase 12px button base; combine with a variant below. |
| `.imp-btn-ink` | Primary action: `--ink` background, white text. |
| `.imp-btn-ghost` | Secondary action: transparent with hairline border. |

```html
<div class="imp-shell">
  <aside class="imp-sidebar">
    <div class="imp-wordmark">IMP</div>
    <div class="imp-sidebar-group">Workspace</div>
    <div class="imp-nav-item active"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="..."/></svg>Chat</div>
  </aside>
  <div class="imp-main">
    <div class="imp-topbar"><span>Users &amp; access</span><span class="imp-btn imp-btn-ink">+ Invite user</span></div>
    <div class="imp-content">…</div>
  </div>
</div>
```

## data-table.css — lists and tables

| Class | What it is |
| --- | --- |
| `.imp-table` | Table card on `--surface` with hairline border; set columns via `--imp-cols`. |
| `.imp-toolbar` | Filter/actions strip above the header row. |
| `.imp-search` | Muted filter field inside the toolbar. |
| `.imp-table-head` | Mono-uppercase header row on a `--surface-2` band. |
| `.imp-row` | 56px grid data row with hairline separator; states: `.hover`, `.selected`. |
| `.imp-cell-user` | Avatar + name/email stack cell. |
| `.imp-avatar` | 30px square avatar (radius 0); variants `.lime` (chip) and `.soft` (chip-soft). |
| `.imp-user-name` / `.imp-user-mail` | 13px/500 name and 12px `--tx-lo` email lines. |
| `.imp-cell-end` | Right-aligned trailing cell. |
| `.imp-cell-faint` | De-emphasized meta cell (`--tx-faint`). |

```html
<div class="imp-table" style="--imp-cols: 2.4fr 1fr 1fr 1fr;">
  <div class="imp-table-head"><span>User</span><span>Role</span><span>Teams</span><span class="imp-cell-end">Last active</span></div>
  <div class="imp-row">
    <span class="imp-cell-user"><span class="imp-avatar lime">MV</span>
      <span><span class="imp-user-name">Maren Vogel</span><br /><span class="imp-user-mail">maren@example.com</span></span></span>
    <span><span class="imp-badge"><span class="dot"></span>Admin</span></span>
    <span>2 teams</span>
    <span class="imp-cell-end imp-cell-faint">2 min ago</span>
  </div>
</div>
```

## dialog.css — modals

| Class | What it is |
| --- | --- |
| `.imp-dialog-scrim` | Full-bleed `rgba(27,23,20,.35)` overlay that centers its child. |
| `.imp-dialog` | 560px modal panel on `--surface` with hairline border. |
| `.imp-dialog-header` / `.imp-dialog-title` / `.imp-dialog-desc` | Title block (18px/500 + 13px mid description). |
| `.imp-dialog-body` | Stacked form area (16px gaps). |
| `.imp-field` / `.imp-label` | Label + control stack. |
| `.imp-input` | Static 34px input; states: `.empty` (placeholder tone), `.focus` (accent border). |
| `.imp-textarea` | Static multi-line field. |
| `.imp-field-hint` | 12px faint helper line. |
| `.imp-dialog-footer` | Right-aligned button row. |

```html
<div class="imp-dialog-scrim">
  <div class="imp-dialog">
    <div class="imp-dialog-header">
      <div class="imp-dialog-title">Invite user</div>
      <div class="imp-dialog-desc">They will receive an email with a sign-in link.</div>
    </div>
    <div class="imp-dialog-body">
      <div class="imp-field"><div class="imp-label">Email</div><div class="imp-input empty">name@company.com</div></div>
    </div>
    <div class="imp-dialog-footer">
      <span class="imp-btn imp-btn-ghost">Cancel</span>
      <span class="imp-btn imp-btn-ink">Send invite</span>
    </div>
  </div>
</div>
```

## chat.css — chat session

| Class | What it is |
| --- | --- |
| `.imp-chat` | Centered 760px conversation column. |
| `.imp-msg-meta` | Mono-uppercase sender/timestamp line. |
| `.imp-msg-user` | Right-aligned user message block on `--surface-2`. |
| `.imp-msg-agent` | Agent reply as plain document text (styled `p`/`ul`/`code` inside). |
| `.imp-composer` | Bordered input bar; contains icons + input + send. |
| `.imp-composer-input` | Placeholder-tone text; add `.typed` for entered text. |
| `.imp-composer-icon` | 28px muted icon button (attach, mic…). |
| `.imp-composer-send` | 30px ink send button. |

```html
<div class="imp-chat">
  <div class="imp-msg-user">Summarize last week's evals.</div>
  <div class="imp-msg-agent"><p>Three eval suites ran last week…</p></div>
  <div class="imp-composer">
    <span class="imp-composer-input">Message IMP…</span>
    <span class="imp-composer-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="..."/></svg></span>
    <span class="imp-composer-send"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="..."/></svg></span>
  </div>
</div>
```

## widgets.css — cards, command box, toast

| Class | What it is |
| --- | --- |
| `.imp-card` | Stat card on `--surface`; contains label/value/delta. |
| `.imp-card-label` | Mono-uppercase 11px label. |
| `.imp-card-value` | 28px/500 stat value. |
| `.imp-card-delta` | Mono accent delta line; add `.down` for `--destructive`. |
| `.imp-cmdbox` | Dark `--code-bg` command block, mono 12.5px. |
| `.imp-cmd-prompt` | `$` prompt glyph in `--accent-soft`. |
| `.imp-cmd-comment` | Dimmed comment text. |
| `.imp-cmd-copy` | Bordered COPY button. |
| `.imp-toast` | Bottom-right ink panel (absolute — needs a positioned ancestor, e.g. the clip). |
| `.imp-toast-sub` | Muted secondary toast text. |

```html
<div class="imp-card"><span class="imp-card-label">Active users</span><span class="imp-card-value">1,284</span><span class="imp-card-delta">+12% this month</span></div>
<div class="imp-cmdbox"><span><span class="imp-cmd-prompt">$</span>imp evals run --suite onboarding</span><span class="imp-cmd-copy">Copy</span></div>
<div class="imp-toast"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M20 6 9 17l-5-5"/></svg>Invite sent.</div>
```

## cursor.css + cursor.js — simulated cursor

| Class / API | What it is |
| --- | --- |
| `.imp-cursor` | 16px absolute pointer (z-index 50, starts at opacity 0). |
| `.imp-click-ripple` | Accent ring pulsed on click (driven by GSAP, no CSS keyframes). |
| `window.impCursor(tl, opts)` | Adds a deterministic glide (+ optional click) to a paused timeline; returns the end time. |

```html
<div class="imp-cursor" id="cur">
  <div class="imp-click-ripple"></div>
  <svg viewBox="0 0 24 24"><path d="M5.5 3.2 19 11.4l-6.2 1.2-3.1 5.6z"/></svg>
</div>
<script src="../../kit/cursor.js"></script>
<script>
  const tl = gsap.timeline({ paused: true });
  let t = impCursor(tl, { from: [1200, 900], to: [640, 380], at: 1.0, click: true });
  impCursor(tl, { to: [820, 520], at: t + 0.4, click: true, show: false, hide: true });
</script>
```

Options: `from` `[x,y]`, `to` `[x,y]`, `at` seconds, `click` boolean, plus
`duration` (glide, default 0.45), `show`/`hide` (fade in/out), and `cursor`
selector (default `.imp-cursor`) when a composition has several cursors.
