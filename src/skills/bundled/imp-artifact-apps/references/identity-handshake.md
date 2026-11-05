# The agent-panel channel (identity v1 + host/panel v2)

The artifact runs on an opaque origin and cannot create a session, read a
cookie, or reach the parent's DOM. The IMP page that embeds it
(`ArtifactFrame`) hands it a `MessagePort` carrying **two** protocols, each on
its own version, so a message belongs to exactly one and neither can be
misread as the other:

- **Identity (`v: 1`, `exulu:identity:*`)** — a short-lived grant for the
  person looking at the artifact, and a way to refresh it. Unchanged since the
  first version of this skill; a deployed v1-only artifact keeps working
  untouched.
- **Agent panel (`v: 2`, `exulu:host:*` / `exulu:panel:*` / `exulu:session:*`)**
  — which agent "slots" are assigned to this artifact, how wide its own
  viewport is, when an agent turn made progress, and a request to open a
  panel with a prefilled prompt and attachments.

**Copy `templates/imp-channel.ts` into the app's `src/lib/` and use
`connectImp` rather than writing a handshake by hand.** It implements
everything on this page — one `port.onmessage` dispatcher, set once, so a
host announcement that lands while a `refresh()` is in flight is never
swallowed (the bug the previous hand-rolled client had). The HTML-only
template (`templates/app.html`) inlines the identity half only — if the app
grows past one hand-written file, switch to the Vite build
(`references/build-setup.md`) and bring `imp-channel.ts` with it.

## Messages

| Direction | Message |
|---|---|
| iframe → parent (`window.parent.postMessage`, target `*`) | `{ type: "exulu:identity:request", v: 1 }` |
| parent → iframe (`postMessage` with a transferred `MessagePort` in `event.ports[0]`) | `{ type: "exulu:identity:channel", v: 1 }` |
| parent → iframe (over the port) | `{ type: "exulu:identity:grant", v: 1, token, backendOrigin, user: { email, name } }` |
| parent → iframe (over the port) | `{ type: "exulu:identity:denied", v: 1, reason }` |
| iframe → parent (over the port) | `{ type: "exulu:identity:refresh", v: 1 }` → answered with a grant or a denial |
| parent → iframe (over the port) | `{ type: "exulu:host:info", v: 2, panel: boolean, slots: [{ key, label }] }` |
| parent → iframe (over the port) | `{ type: "exulu:panel:viewport", v: 2, width: number, open: boolean }` |
| parent → iframe (over the port) | `{ type: "exulu:session:progress", v: 2, reason: "tool" \| "turn" }` |
| iframe → parent (over the port) | `{ type: "exulu:panel:open", v: 2, slot, prompt?, items?, files? }` → answered with an ack |
| parent → iframe (over the port) | `{ type: "exulu:panel:open:ack", v: 2, slot, accepted: boolean, reason? }` |

Verify both `type` and `v` on every message — `connectImp` already does this
for you. The identity credential only ever travels over the port, never over
`window.postMessage`: a port is bound to the document that received it, so a
navigation of the frame cannot intercept it.

## Timing rules

1. **Listener first, then ask.** The parent answers at most one
   `exulu:identity:request` per frame load. A reply that arrives before you
   listen is lost for good.
2. **Ask repeatedly** (every ~300 ms) until the channel arrives, with an
   overall timeout of ~10 s. The parent's listener is registered in a client
   effect and does not exist until the IMP page has hydrated, while the
   iframe runs as soon as the page's HTML is parsed. Extra requests cost
   nothing: the parent ignores requests after the first answered one. Stop
   the interval the moment you settle.
3. **Host info and the seeded viewport arrive on the port *before* the
   grant.** The parent queues `exulu:host:info` (and, if a panel is already
   open, `exulu:panel:viewport`) on the port synchronously as part of the same
   handoff that transfers it — both land before the grant, which waits on a
   backend round-trip. `connectImp`'s `connect()` resolves on the grant and
   reads `host.panel`/`host.slots` off these earlier messages; do not
   restructure that expectation (e.g. by resolving before the grant, or by
   re-reading host info later).
4. **One refresh per auth failure, single-flighted.** The identity exchange
   (the initial grant, or a later `refresh()`) is one-at-a-time by contract: a
   second `refresh()` call while one is outstanding replaces the first's
   resolver, which then times out. `connectImp`'s single dispatcher no longer
   makes this a *correctness* hazard for anything else on the channel — a
   viewport change or a progress bump in flight during a refresh still reaches
   `onViewport`/`onProgress` — but concurrent refreshes themselves are still a
   caller bug, so keep single-flighting them.
5. **A second auth failure after a refresh means the session is gone.** Show
   a banner telling the viewer to reload the IMP tab. Do not retry in a loop:
   each answered request costs the parent backend calls, and a dead session
   stays dead.

## What counts as an auth failure

- HTTP `401` from `/graphql` or a REST route.
- HTTP `500` from `/graphql` whose body has an `errors[].message` containing
  `Context creation failed` — this is how Apollo reports a token that no
  longer authenticates; it is the common case for an expired viewer token.

Not an auth failure: HTTP `200` with `errors[]` (a data or rights error on a
row — surface it), `403` on a REST route (rights, not session), `404`, `409`.

## The grant

`token` is the viewer's own JWT for the backend; send it as
`Authorization: Bearer <token>`. `backendOrigin` is where to send requests
(`${backendOrigin}/graphql`, `${backendOrigin}/s3/sign`, …). `user.email` /
`user.name` are for display and for stamping who did something; never use
them as authorisation. `channel.grant` is a snapshot taken when `connectImp`
resolved — it is **not** updated by a later `refresh()`; use the `grant` the
resolved `IdentityResult` carries and keep your own copy current, exactly as
the old client worked.

## The agent panel (v2)

### Slots, never agents

An artifact names a **slot**, never an agent id — agent ids never cross this
channel at all. `host.slots` is an array of `{ key, label }`: `key` is the
stable string an IMP owner typed when assigning the slot (bind your buttons
to it), `label` is the agent's current display name, for a picker when more
than one slot is offered. Treat `key` as opaque and stable; treat `label` as
display-only and possibly stale between renders (it is read live from the
agent's name, not stored with the assignment).

### `host.panel` — hide your own trigger when it's false

A `regular` (logged-in) artifact can render at **two** routes: the in-shell
viewer (where a panel can actually dock or sheet-overlay beside it) and the
published share link (a bare full-screen frame with no panel at all).
Both grant identity; only the first has `host.panel: true`. **Check
`host.panel` before showing any "open the agent" affordance** — on the share
route it is always `false` with `slots: []`, and a button that posted
`exulu:panel:open` there would simply never be acked by anyone. This is also
true when an in-shell artifact simply has no agents assigned: `host.panel` is
`false` and `host.slots` is empty, indistinguishable from the share route by
design — either way, there is nothing to open.

### Host info is announced once — and never again

The parent sends `exulu:host:info` exactly once per frame load, right at the
handshake. If an IMP owner changes the slot assignments while your artifact's
tab stays open, your artifact keeps the view it was handed at connect time
until the next navigation (reload, or the artifact navigating itself) re-runs
the handshake. If you post `exulu:panel:open` for a slot that no longer
exists, you get back `{ accepted: false, reason: "unknown-slot" }` — correct,
but easy to misread as "the panel is broken" rather than "the assignment
changed under you." Treat any `accepted: false` as "tell the user to reload",
not as a bug to retry past.

### Viewport: `width` is YOUR width; `open` is orthogonal

`exulu:panel:viewport` tells the artifact **its own** width in CSS pixels —
not the panel's. Three regimes, all reported through the same number:

- No panel open: your full width.
- Panel docked beside you (≥ the `lg` breakpoint): your squeezed remainder.
- Panel in "sheet" mode (< `lg`, where it overlays rather than sharing the
  row): your full width again, because the panel takes no row space.

`open` is a **separate**, orthogonal fact: whether a panel is currently open
at all. A sheet-mode panel reports `open: true` while `width` is still your
full width — "the panel is open" does not imply "I am narrower." If you
reflow (e.g. collapse from three columns to one), key that decision off
`width` alone; use `open` only for things like dimming your own UI behind an
overlay, not for deciding how much room you have.

A message arrives on every real change — mount, resize, a breakpoint flip,
docking/sheet transition, open/close — so there's no need to poll or measure
anything yourself.

### Progress: register before you do anything else

`exulu:session:progress` fires whenever an agent turn in the panel made
progress: `reason: "tool"` (a tool call finished, success or failure) or
`reason: "turn"` (the whole turn finished). It is a signal to **refetch
whatever the artifact reads from the backend** — the agent may just have
written to it.

**A bump can arrive immediately, before the user has done anything.**
Reopening a panel on a session that already has tool-call history fires one
batched bump on mount, deliberately — your artifact's data may already be
stale relative to what that session's history wrote. Call `onProgress`
synchronously right after `connectImp` resolves, and make the handler safe to
run with nothing else having happened yet (e.g. a plain refetch, not
something that assumes a prior state).

### Opening a panel: prefill never submits

`openPanel(slot, { prompt?, items?, files? })` asks the host to open `slot`'s
panel with the composer prefilled and/or files attached. **It never sends
anything on the user's behalf** — the user reads what was prepared and
presses send themselves. There is no API for submitting a message from an
artifact, by design; that is the whole point of this feature over an opaque
background routine.

- `prompt` fills the composer text. The user can edit or clear it before
  sending.
- `items` are knowledge-item ids (gids) pinned into the session's scope.
- `files` are S3 keys of **files the viewer has already uploaded** (through
  whatever upload path your artifact used to get them into object storage) —
  not arbitrary URLs, and not a way to hand the agent a file it doesn't
  already have permission to read.

`openPanel` resolves `true` on an accepted ack, `false` on a rejected one
(`reason` on the wire names why — e.g. `"no-panel"`, `"unknown-slot"`), and
**`false` after a timeout if no ack ever arrives** — it never hangs. Re-enable
your own "open" button on whatever `openPanel` resolves to, not only on
`true`.

**Attachment limits — a seam to know about.** The backend's adopt step (what
turns your `files` keys into session attachments) accepts at most **20 keys**
per batch and refuses any single file over **50 MB**, all-or-nothing — a
batch with one oversized file is rejected in full, not partially applied. If
your own upload helper has a larger cap (the reference artifact's does, at
100 MB), a file your artifact successfully uploaded can still be refused at
the attach step. Check your own cap against 50 MB, or be ready to show the
user that a file attached but one of its files didn't make it into the chat.

## Development outside the IMP

`templates/app.html` falls back, only when it is the top window (not
embedded), to `location.hash` → `#backend=http://localhost:9001&token=<jwt or
api key>`. The hash never leaves the browser, but it is a development
convenience only; there is no refresh and no agent panel in that mode, and no
artifact must ever rely on it.

## Known gap: a port can outlive its document by one navigation

The host retires the port when the iframe navigates, so a stale document
cannot keep receiving `exulu:host:info`/`exulu:panel:viewport`/
`exulu:session:progress` announcements or renew its own token. It does this
by watching the frame's `load` event: the **first** `load` after a handshake
is the handshaking document's own (an artifact's script runs during parsing,
before its own first `load` fires), so the host lets that one pass; the
**second** `load` is necessarily a navigation away from that document, so the
host retires the port there.

That rule has a known, deliberate gap: **a document that completes its
handshake *after* its own `load` event** — a click-triggered connect, code
that waits for `window.onload` before calling `connectImp`, a dynamic import,
or a legitimate second handshake later in the same document's life — has no
`load` of its own still to come. Its port then survives one navigation too
long: the host only retires it on the *next* document's `load`, and a hostile
document occupying the frame has no reason to handshake at all, let alone
navigate again. The mirror fix (retire on the very next `load` after any
handshake, full stop) was tried and is worse: an artifact that reloads itself
handshakes during its new document's parse, and that new document's own
`load` would then retire its own, brand-new port — silently killing a live
artifact's channel for the rest of the session. The two orderings — "my own
load, still pending" vs. "my own load, already fired" — are indistinguishable
from the host's side; `event.source` is the same `WindowProxy` across a
navigation by design, so the host cannot tell which case it's in by watching
alone.

**The contract that closes the gap, if you need it to:** handshake only after
your own document's `load` event has fired (wrap the call to `connectImp` in
a `window.onload` check, or simply don't call it from code that runs before
`load` — `templates/app.html`'s inline script and the Vite template's
`DOMContentLoaded`-gated mount both already satisfy this by construction, so
most artifacts get it for free). Following this contract does **not**, on its
own, close the gap — the host has no way to observe that a given artifact
honours it, so it cannot yet treat such a client any differently from one
that doesn't.

That observability is the missing half, and it is a **recommended, not yet
implemented** follow-up on the host side: bump the identity *request* itself
to a new version (today's is `{ type: "exulu:identity:request", v: 1 }`) so a
client can declare, in the request that opens the channel, that it follows
the post-load handshake contract — e.g. `{ ..., v: 2 }` — and have the host
apply the strict single-navigation retirement rule only to ports opened by
such a request, while a `v: 1` request (unchanged, no new promise made) keeps
today's one-extra-navigation grace period. This is a decision for whoever
owns `artifact-frame.tsx` next (frontend repo), not something to change from
this module or from a bundled skill — and it is a different `v` from this
module's own `CHANNEL_V = 2`, which already exists and names the *agent-panel*
wire shapes, not a promise about handshake timing.
