# Artifact agent panel — design

Date: 2026-11-04
Status: approved for planning

## Intent

Artifacts in the IMP are mostly small applications rendered in an iframe, and
most of them are UI/UX companions to an agent. The Metzler & Vater Pitch
Matrix is the reference case: an agent reads a pitch folder, checks Hubspot,
and proposes values for 68 fields; a human corrects and approves them in the
artifact.

Today an artifact can only start backend work by calling `runWorkflow` — i.e.
by launching a routine. That is not a stylistic choice. GraphQL mutations do
not fire context processors (those hang off `ExuluContext.createItem`, so only
tools and sources trigger them), so a routine is the only way an artifact
holding a user token can cause real work to happen. The consequence is that
the most important moment in the product — "analyse these documents and fill
the matrix" — is a black box. The user clicks, nothing visible happens, and
some minutes later data may or may not have changed. They cannot see the
reasoning, cannot correct a wrong turn, and cannot ask a follow-up.

This design replaces that with a chat session the user watches, running beside
the artifact, writing into the artifact's data while they read it.

The win is not only transparency. An agent has tools; a routine is a fixed
script. Moving this work into a session means the work itself gets better, and
the user can intervene.

## Goals

1. An admin or an artifact owner can assign one or more agents to an artifact.
2. When an artifact has assigned agents, its detail page
   (`/artifacts/open/[name]`) shows a call to action that opens one of them in
   a chat panel on the right, built from the same components as the chat page.
3. An artifact's own UI can raise that panel from a button in its own code,
   with the composer prefilled and documents attached, ready for the user to
   send.
4. While the session runs, the artifact's data updates — the user watches the
   matrix fill as the agent works.

## Non-goals

- **No second chat implementation.** The panel hosts the existing chat
  components. If something is missing from them, it gets added there.
- **No adding tools or skills to a session.** The session capability model is
  subtractive: `disabledTools` (`frontend app/(application)/chat/hooks.ts:357`)
  is ephemeral React state over the tool list the *agent definition* carries.
  Nothing adds a capability to a session, and nothing in this design changes
  that. "The right tools are loaded" means **the right agent was assigned**, so
  the intended usage pattern is purpose-built agents per artifact.
- **No change to tool approvals.** If the agent reaches for Hubspot and the
  user is asked to approve it, that is correct behaviour and part of the
  transparency the feature exists for.
- **No platform-side configuration of the buttons.** Label, agent, prompt text
  and attachments live in the artifact's own code. (Decided explicitly: the
  alternative — declaring actions as artifact configuration so an owner could
  edit a prompt without republishing — was considered and rejected.)
- **No re-run logic in the platform.** Clicking "Analyse" a second time does
  the same thing a second time. Whether to skip, warn, or redo is logic the
  agent's admin configures inside the agent (e.g. a skill that checks first).
- **Not for `public` or `password` artifacts** in this version. The panel needs
  a session, which needs a user. Public and guest agents exist
  (`frontend app/public/agents/`), so this is a possible later story, not a
  closed door.
- **Not for non-app artifacts.** `shared_artifacts` also backs PDFs, images,
  spreadsheets and download-only files, and "ask an agent about this PDF" is a
  plausible feature — but it is not this one. Every part of this design assumes
  a frame that can talk back: the port, the prefill, the progress signal, the
  width message. Assignment is therefore hidden in the settings UI for rows
  where `artifactType()` is not `app`, and no CTA is rendered for them.

## Anti-goals

These would make the feature a failure even if it shipped and worked:

- **An artifact that can send on the user's behalf.** Prefill fills the
  composer and never submits. This is already the deliberate rule for the
  existing `?q=` deep link ("Fills the textarea only — must NOT send",
  `frontend app/(application)/chat/components/composer.tsx:325`). It is what
  keeps a compromised or buggy artifact from driving an agent under the user's
  identity, and it keeps the audit trail honest.
- **An artifact that can attach a file it does not own.** See the
  authorization rule under Attachments.
- **Silent staleness.** An agent that finishes while the artifact still shows
  its load-time snapshot is worse than the routine it replaced, because the
  user has been given a reason to believe it worked.
- **Work the user cannot see or correct.** If the panel ends up showing a
  spinner and then a result, we have rebuilt a routine with extra steps.

## Constraints

Facts in the current code that this design depends on. A builder should not
have to rediscover them, and should not "fix" them without reading why.

### The iframe is sandboxed with an opaque origin

`frontend app/artifacts/[artifact_name]/artifact-frame.tsx` renders the
artifact with `sandbox="allow-scripts allow-popups
allow-popups-to-escape-sandbox allow-forms"` — deliberately **without**
`allow-same-origin`. The artifact therefore has no cookie, no localStorage, no
parent access, and its origin is the string `"null"`, which proves nothing.
Consequences:

- The frame **cannot navigate the parent** (no `allow-top-navigation`). An
  in-frame button therefore cannot open the panel by changing the URL. It must
  use `postMessage`. (It *can* open a popup, which is what the existing comment
  about `/chat/<agent>/new?q=…` refers to — a separate top-level context, not
  this feature.)
- Sender verification is by **window identity** (`event.source !==
  frame.contentWindow`), never by origin.

### A `regular` artifact renders at two routes, and only one can host a panel

`/artifacts/open/[name]` is the in-shell viewer; `/artifacts/[artifact_name]`
is the published share route, and **both** grant identity (`grantIdentity={
authMode === "regular" }` in each). The share route has its own root layout
(`frontend app/artifacts/layout.tsx`) with none of the `(application)`
providers — no Apollo, no `UserContext`, no `ConfigContext`, no sidebar — and
it is where every share link lands *and* where the in-shell viewer's own "Open
in new tab" sends people (`shareUrl = /artifacts/${name}`).

So the same artifact code, with a working port, can post "open the panel" into
a host that has no panel. **This version builds the panel on the in-shell
viewer only** — Goal 2 names that route, and lifting a second provider stack
into the share route is a different piece of work. The protocol therefore has
to tell the artifact whether a panel exists here, so authors hide the trigger
rather than ship a dead button.

### The identity handshake already provides a bidirectional channel

The handshake is port-first and deliberately so: the token is only ever sent
over a transferred `MessagePort`, never aimed at a window, because a sandboxed
frame can navigate itself between a request and an awaited reply. Read the
comment block at the top of `artifact-frame.tsx` before touching any of this.

The artifact holds `port2`; the parent holds `port1` and already listens on it
for `exulu:identity:refresh`. **This design needs no new handshake and no new
permission** — the channel exists, and new message types go on it.

Two hazards:

- `ArtifactFrame` answers **at most one identity request per frame load**
  (`handledRef`, reset by the iframe's `load` event). Do not make the panel
  depend on a second identity request.
- The artifact-side client reassigns `port.onmessage` on every `refresh()`
  call (`mevakipi/artifact-pitch/src/lib/identity.ts`). Any unsolicited
  parent→artifact event that lands while a token refresh is in flight is
  handed to the refresh handler, which ignores anything that is not a grant,
  and is dropped. **The artifact-side client needs a real dispatcher before a
  second message type goes on that port.** The failure mode is "sometimes the
  matrix does not update", which is expensive to chase.

### Session creation is lazy

`createSession` fires on first send and swaps the URL with a raw
`history.replaceState`, which leaves the App Router tree reading `[session] =
"new"`. `ChatShell` carries an entire mechanism for that desync
(`newChatNonce`, `startNewChat`, `beginLazyCreate` — read the comments in
`frontend app/(application)/chat/components/chat-shell.tsx`). Anything that
needs a session id must go through `ensureSession()` the way
`addSessionItems` does (`hooks.ts:976`), not assume one exists.

### Two different attachment mechanisms already exist

- **`addSessionItems(gids)`** (`hooks.ts:976`) pins knowledge-base items into
  the session. Reachable today by deep link as `?items=<gid,gid>`.
- **`addFileItem(s3Key)`** (`hooks.ts:1025`) adds an S3 key to the **next
  message** as a presigned `FileUIPart`. No backend work needed.

Neither is the same as **session files**, which live in S3 under
`user_<owner>/sessions/<session>/` (`src/exulu/session-files.ts`) and are what
sandbox tools (`readFile`, `bash`, `parse_document`) can operate on across
turns. The prefix is built from the session **owner**, never the caller —
`loadSessionFilesAuth` in `src/exulu/routes.ts:4709` explains why.

### Artifact uploads already land under the caller's own prefix

`POST /s3/sign` mints the key server-side from the authenticated token:
`user_<id>/<uuid>-_EXULU_<filename>` (`src/uppy/index.ts:877`,
`addUserPrefixToKey`). The artifact never chooses where its bytes land. This is
what makes the authorization rule below writable at all.

Note the `global/` branch in the same route: with a `global` header the key
lands under `global/` and skips the user prefix entirely.

### `shared_artifacts` writes do not go through generic GraphQL

`apiWrites: "super_admin"` (`src/postgres/core-schema.ts:968`) — because
public/password shares carry `rights_mode: "public"`, which the generic write
check reads as "anyone may edit". Creators change their shares through `PATCH
/shared-artifacts/:name` (`src/exulu/routes.ts:5325`). Agent assignment must
follow that same path.

`addMissingFields` only ever **adds** columns, so a new field on this table is
additive and safe; removing one leaves it orphaned (see the comment about the
three removed `grant_viewer_identity` columns).

### The app sidebar's collapsed state is persisted in a cookie

`SidebarProvider.setOpen` writes `sidebar_state`
(`frontend components/ui/sidebar.tsx:92`). Auto-collapsing the nav by calling
`setOpen(false)` would overwrite the user's global preference for every page in
the IMP. The collapse must be a **transient override** that does not write the
cookie, or must capture and restore the previous value.

### `SidePanel` already has the responsive behaviour

`frontend components/primitives/side-panel.tsx`: docked and resizable at
`≥ lg` with the width persisted per `storageKey`, right-side overlay Sheet
between `md` and `lg`, bottom Sheet below `md`, with focus management and Esc
handling. Do not write a second one.

## Decisions

### Layout: docked split, and the artifact is told its width

The panel docks on the right, the main nav collapses to its icon rail, and the
parent **posts the artifact's new viewport width over the port** so the artifact
can reflow itself (the Pitch Matrix drops to a single full-width column rather
than truncating labels across three).

Why this and not an overlay floating over a full-width artifact: the whole case
for this feature over a routine is watching the work land in the data, and an
overlay sits on top of the data — specifically on top of the field under
discussion, because that is where the agent's attention is.

Three things follow:

- An artifact that ignores the width message behaves exactly like a plain
  squeeze. That is acceptable, not broken. Reflowing is **opt-in**.
- Below `lg`, `SidePanel` is already a Sheet, so the overlay behaviour comes
  for free on narrow viewports. There is no second design to build.
- The panel must be **collapsible to a thin edge, not only closable**, so the
  artifact can return to full width without ending the session.

This costs artifact authors a second layout. That is the right bill to send:
there are few artifacts, and the ones dense enough to matter need it anyway.

### The port protocol gains a version and three directions of traffic

Extend the existing channel rather than adding another. Since the protocol
grows, **version it once, now**, and carry everything this feature needs from
day one even if a consumer lands later.

Parent → artifact:

- **whether this host has a panel at all.** A `regular` artifact renders at
  *two* routes and both grant identity, but only the in-shell viewer has a
  panel (see Constraints). Without this field an artifact ships a button that
  is dead on the share route, which is also where the viewer's own "Open in new
  tab" sends people. Artifact authors hide their own trigger on a host that
  says no;
- the agents assigned to this artifact — **slot key, agent id and display
  name** (see Assignment);
- the artifact's current viewport width, on panel open, close, and resize;
- turn progress — see below.

Artifact → parent:

- open the panel for a slot, with optional prefill text and attachments.

The parent **validates the request against the assignment list every time**.
That list is the trust boundary: artifact code can only ever open an agent an
admin assigned to that artifact.

### Progress fires on tool-call completion, not only on stream end

The artifact refetches its own queries — coarsely, via
`client.refetchQueries({ include: "active" })` — because the parent genuinely
cannot know which rows the agent touched.

Fire on **tool-call completion as well as turn completion**. A 74-field matrix
that fills in visibly while the agent works is a different product from one
that snaps into place at the end, and it is precisely what a routine could
never do.

### The prefilled text is the whole contract — there is no structured binding

The routine this replaces passed a structured argument:
`runWorkflow(ROUTINE_BEFUELLEN, { pitch: id })`
(`mevakipi/artifact-pitch/src/screens/NeuerPitch.tsx:507`). The panel
deliberately has no equivalent. A button supplies prose, the user may edit it
before sending, and **identifying the record is the agent's job** — the same
division of responsibility as re-run handling: platform supplies the moment,
the agent supplies the logic.

So do not build a variables blob, session metadata binding, or any other
side-channel carrying record identity. If an agent picks the wrong record, that
is fixed in the agent — its prompt, its skills, its tools — not by adding a
parameter to the protocol.

Builders should know the failure mode this accepts: a user who edits the id out
of the prefilled sentence leaves the agent to infer the record from whatever
remains. Pinning the record as a session item is available as an ordinary
attachment if a given artifact wants the belt as well as the braces; it is not
required, and it is not the mechanism.

### Attachments: two paths, because they are two different things

- **Knowledge-base items** → `addSessionItems(gids)`. Free today. The Pitch
  Matrix already registers its documents as context items, so for that artifact
  this covers the common case with no new backend.
- **The user's own loose uploads** → a new endpoint that copies the objects
  into the session's file prefix, then `syncToSandbox`. This is the path for
  "the agent will run tools over these six PDFs for the next twenty turns",
  which is the actual pitch-analysis shape. Not everything relevant to an
  artifact belongs in a knowledge base, so this path is required, not optional.

`addFileItem(s3Key)` is a third, cheaper option that attaches a key to the next
message as a presigned file part with no backend work at all. It is the right
tool for "look at this one thing", and the wrong one for "work on these across
turns". **Builder's call** whether it is worth exposing as a distinct
attachment kind or whether the two paths above are enough.

**The authorization rule:** every source key must sit under
`user_<caller's id>/`. This is exactly the guard the delete route already runs
(`src/uppy/index.ts:498`). A user can only pull their own uploads into their
own session, and the destination prefix is still built server-side from the
session owner.

Four things to get right, every one of which fails silently:

1. **Allowlist, not denylist.** `user_<me>/` only. If `global/` passes, any
   user can pull any global object into a session.
2. **Do not copy the delete route's guard verbatim.** It reads `user.type !==
   "api" && …`, i.e. api-key callers bypass it entirely. Harmless for artifacts
   today (they carry a user JWT), poison the first time something runs with an
   api key.
3. **Normalise the key.** `s3KeyFromUploadUrl` deliberately returns a key
   *with* the bucket segment, because the processor's reader needs it there.
   The endpoint receives that form and must strip it — `normalizeS3Key` in
   `src/exulu/shared-artifacts.ts` exists for this. Getting it wrong uploads
   cleanly and breaks reading, with no error anyone sees. Same family as
   `c30f466`.
4. **Only one cap is actually missing.** `EXULU_ATTACHMENT_MAX_PAGES` is
   enforced at *read* time, not upload time — `extractDocument`'s `tooLong` is
   honoured both on the message-attachment path (`src/exulu/attachment-text.ts`)
   and by `parse_document` (`src/templates/tools/parse-document-tool.ts:160`) —
   so an adopt path inherits it for free. Do not write a second check that
   duplicates one already firing. What an adopt path *does* route around is the
   client-side `MAX_UPLOAD_BYTES` in
   `frontend app/(application)/chat/components/session-files/upload.ts`, which
   is the one to enforce server-side.

Adopted files must appear in the session-files panel **before** the user presses
send. Seeing what the agent is about to receive is the point.

### Attachment wiring mirrors pinned items

Do **not** add keys to the session-create mutation. Session creation is lazy
(see Constraints), and coupling attachments to session birth means handling
that race. Add a controller method shaped like `addSessionItems`: await
`ensureSession()`, then call the endpoint, then `syncToSandbox`.

### Parameterise `useChatSession`; do not fork it

`createSession` ends with a hardcoded `window.history.replaceState(null, "",
/chat/${agent.id}/${newSession.id})` (`frontend
app/(application)/chat/hooks.ts:727`). Mounted in the panel as written, the
first send rewrites the *artifact page's* URL — a reload would land on the chat
page, the `useSearchParams()` the composer reads for `?q=`/`?items=` would
change under it, and `isChatSessionRoute(pathname)` would flip the shell's
height class.

**Editing the controller to make that destination a parameter is explicitly
sanctioned**, and is the intended reading of the "no second chat
implementation" non-goal. The public guest shell went the other way —
`use-public-chat-session.ts` reimplements `ChatSessionController` in ~295 lines
without reusing `useChatSession` — and that fork is the thing this non-goal
exists to prevent happening a second time. Converging the guest shell onto the
parameterised controller is out of scope here but is the direction of travel;
do not add a third variant.

The panel's session **is** reflected in the artifact page's URL (a `?session=`
parameter), so reload and back restore the conversation beside the artifact,
and the history rail's rows navigate in place instead of leaving the artifact.
`HistoryRailPaths` already exists for exactly this kind of host-specific
routing.

Closing or collapsing the panel mid-turn is **not** destructive:
`persistThroughDisconnect()` on the chat stream (`src/exulu/routes.ts:977`)
plus the `catchingUp` / `generating_since` machinery already save a turn whose
client has gone. Nothing needs to be built to protect it — collapse-versus-close
is purely a UX call.

### Assignment

A new additive field on `shared_artifacts`, set through `PATCH
/shared-artifacts/:name` and surfaced in the existing artifact
sharing/settings UI
(`frontend app/(application)/artifacts/components/sharing-form.tsx`), not
through a generic GraphQL mutation.

**Store slots, not a bare id list:** `[{ key, agentId }]`, where `key` is a
stable string the owner types ("analyse", "review") and the artifact's code
binds its buttons to. A bare id list cannot work here. Ids differ per IMP
instance, display names are editable free text, and with several agents
assigned an artifact button has nothing stable to name — which is exactly the
pain being removed, since the Pitch Matrix today hardcodes `ROUTINE_EINLESEN`
and `ROUTINE_BEFUELLEN`. The same artifact bundle has to run against more than
one instance.

This matters more than it looks: `addMissingFields` only ever adds columns, so
a shipped field of the wrong shape cannot be reshaped. There is a precedent for
the bare form (`agent_ids` json at `src/postgres/core-schema.ts:523`) — do not
follow it here.

Only agents the viewing user may actually reach are offered. An assignment the
current user cannot see degrades to "no agent", not to an error — and a slot
whose agent is unreachable reports itself as absent over the port, so the
artifact hides that button rather than offering one that will fail.

The CTA appears **only when agents are assigned** — no dead chrome on the
majority of artifacts that have none. With one agent it is a single button;
with several it is one trigger that opens a picker.

### My calls, flagged as mine

These were not discussed and a builder should feel free to raise them, but
something had to be chosen:

- A button-launched action opens a **new session**. Prefilling an empty
  composer is unambiguous; prefilling a conversation in progress is not.
- The panel keeps the normal history rail, scoped to the agent as it is on the
  chat page, so earlier sessions remain reachable.
- `public` and `password` artifacts show no CTA at all, rather than a disabled
  one.
- The share route gets no panel in this version; the protocol carries a
  host-capability flag so artifacts hide their trigger there.
- Assignments are slots with an owner-typed stable key, not a bare id list.
- `useChatSession` gets parameterised rather than forked, and the panel's
  session is reflected in the artifact URL as `?session=`.

## Open to the builder

- Component composition for the panel host, and whether it reuses `ChatShell`
  or supplies `ChatShellContext` the way the public guest shell does
  (`frontend app/public/agents/[id]/components/public-chat-shell.tsx` is the
  precedent for an alternate provider).
- Exact protocol message names, field names and version numbering, and where
  the shared artifact-side client library lives so artifacts stop
  copy-pasting `identity.ts` between repositories.
- Whether the `/artifacts/open/[name]` page also accepts `?agent=` / `?q=`
  query parameters for deep links from outside the artifact (e.g. from an
  email). Cheap, and the composer already reads `?q=`.
- Whether the adopt endpoint ships in the same release as the panel or one
  behind it. The knowledge-base path covers the Pitch Matrix's documents today.
- i18n keys, test placement, and the usual gates. Note that backend tests are
  typechecked by nothing (tsconfig excludes them, ts-jest only transpiles), so
  a fixture can assert a shape no code emits and stay green.
