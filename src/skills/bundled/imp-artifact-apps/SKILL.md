---
name: imp-artifact-apps
description: Build and publish single-file web apps that run inside the IMP as artifacts, like the Tender/Ausschreibungs-Agent cockpit. Use when a user wants an app, dashboard, cockpit or tool on top of IMP data (contexts, routines, agents) that opens from the IMP's Artifacts page. Covers the viewer sandbox, the identity handshake, the GraphQL conventions, routines, building to one HTML file, and publishing or updating the share.
---

# IMP artifact apps

An **artifact app** is one HTML file that the IMP serves as a shared artifact.
It opens inside the IMP (Artifacts → open) or through its share link, runs in a
sandboxed iframe, learns who is looking at it through a handshake with the IMP
page, and talks to the IMP backend with that person's own rights. The Tender
cockpit (Ausschreibungs-Agent) is one: eleven screens over the `tenders`
context, every long-running step a Routine, zero custom backend routes.

Read this file fully, then the reference that matches the step you are on:

- `references/identity-handshake.md` — who is looking, and how the token is refreshed
- `references/imp-api.md` — contexts, filters, mutations, routines, agent messages, uploads
- `references/publishing.md` — share modes, the Artifacts page, the publish script, updates
- `references/build-setup.md` — Vite single-file build for apps too big for one hand-written file
- `templates/app.html` — a working skeleton: handshake, client, session-lost banner
- `scripts/publish-artifact` — upload + publish (or update) from the command line

## The contract (non-negotiable)

1. **One file.** Everything inline: CSS, JS, fonts as data URIs, images as data
   URIs. The viewer loads the HTML through `srcdoc`; a relative `src` or `href`
   has nothing to resolve against.
2. **The sandbox is `allow-scripts allow-popups allow-forms` on an opaque
   origin.** No cookies, no `localStorage`/`sessionStorage` (they throw), no
   parent DOM. Links to other pages need `target="_blank"`. State lives in the
   backend (a context row, usually a JSON field) or in memory.
3. **The IMP page's CSP applies inside the frame.** Inline scripts and styles
   are fine. External scripts load only from `https://cdn.jsdelivr.net`; stylesheets
   from `https://fonts.googleapis.com`; fonts from `https://fonts.gstatic.com` or
   `data:`; images from `data:`, `blob:` and the instance's object storage.
   `fetch` reaches only the IMP backend origin (and object storage). No
   `eval`/`new Function` — allowed in development only. Prefer inlining a
   library over a CDN tag: the CDN is one network failure away from a blank app.
4. **Identity only for "logged-in users" shares.** A share published as
   `regular` (login required) gets the viewer's identity through the handshake;
   `public` and `password` shares get nothing — the app must still render
   something honest without a session (a message, or a static view).
5. **Only existing IMP APIs.** Table I/O through the generated GraphQL,
   long-running logic through Routines (which call agent tools), files through
   the signed-upload route. If the app seems to need a new backend route, the
   logic belongs in a tool the Routine calls, not in the app.
6. **The viewer's rights are the app's rights.** The token is the viewer's;
   rows they may not read do not come back; writes fail where they lack write
   access. Design rows that everybody should edit with `rights_mode: "public"`.

## How an app is wired

```
IMP page (parent)            artifact iframe (your app)
  ArtifactFrame  <── request ─┐  1. ask for identity, keep asking until answered
     │ ── channel (port) ────►│  2. receive a MessagePort
     │ ── grant over port ───►│  3. { token, backendOrigin, user }
     │                        │  4. fetch(`${backendOrigin}/graphql`, Bearer token)
     │ ◄── refresh ───────────│  5. on an auth failure: ONE refresh over the port, then retry
```

The template implements 1–5. Keep one client per page and route every call
through it; the refresh is single-flighted on purpose.

## Workflow

1. **Pin the job.** One sentence: who opens the app, what they decide or see,
   what data it reads and writes. Name the contexts (tables) and the Routines
   involved. If the user is unsure what exists, list the instance's contexts
   through introspection (`references/imp-api.md`, "Discover") and show them.
2. **Scaffold.** Copy `templates/app.html` for a small app. For anything with
   screens, components or a UI library, set up the Vite single-file build
   (`references/build-setup.md`) and port the template's `identity` and
   `client` modules as-is.
3. **Model the state.** Put the app's own state (decisions, pins, progress) on
   the row it belongs to, in one JSON field, as a small overlay
   (`{ "<scope>:<id>": { value, by, at } }`), and re-read the row after each
   write. Never keep the only copy in memory.
4. **Build the screens.** Honest states for every region: connecting, loading,
   empty, error, session lost. Full width of the viewer — no fixed max-width
   that leaves a third of the surface empty. Write the UI in the language the
   instance's users work in. Buttons say what happens; errors say what to do.
5. **Routines for work that takes time.** The app starts a Routine
   (`runWorkflow`), shows the run, polls `routineRuns` until it settles, then
   re-reads the rows the tool changed. The Routine rows are data: create them
   once per environment (an ops script or SQL), note their ids in the app's
   README, and never hard-code assumptions about their shape beyond the ids.
6. **Build and check.** The output must be one `.html` file with no external
   `src`, no `type="module"` on the inlined script, and a mount that waits
   for `DOMContentLoaded` (see build-setup).
7. **Publish.** Artifacts → "New artifact" → upload the file, name the link,
   choose "Logged-in users" and the rights scope — or
   `sh scripts/publish-artifact <name> <file>`. Updating is the same script
   with the same name: the share keeps its link and its stars, only the bytes
   change.
8. **Verify inside the IMP.** Open it from the Artifacts page (not only the
   share link): the handshake only exists there. Check a write, a Routine run,
   and the session-lost banner (open the app, log out in another tab, click).

## Rules learned the hard way

- Register the `message` listener **before** posting the first identity
  request, and keep re-posting every 300 ms until answered: the IMP page
  answers once per frame load and may not be listening yet when the frame runs.
- An expired viewer token does **not** come back as HTTP 401 from `/graphql`.
  It is HTTP 500 with an error whose message starts with "Context creation
  failed". Treat both as "refresh once, then retry"; a second failure means the
  session is gone — show "reload the IMP tab", never loop.
- A GraphQL response can be HTTP 200 with `errors`. "Access control error" there
  is a rights problem on a row, not a lost session: show it as the data error it is.
- Core columns on every context table: `id`, `name`, `description`, `tags`,
  `created_by`, `rights_mode`, `createdAt`, `updatedAt`. Do not declare fields
  with those names in a context; do not sort on a field the table lacks.
- Generated names come from the physical table `<context>_items`:
  `tenders_itemsPagination`, `tenders_itemsById`, `tenders_itemsUpdateOneById`,
  filter input `FilterTenders_items`.
- A direct `updateItem` from a tool does not bump `updatedAt`; only the GraphQL
  mutation does. If the app orders by `updatedAt`, tools must set it explicitly.
- Keep screens scrollable within the frame (`html, body { height: 100% }` and a
  single scrolling `main`); the viewer gives the frame its full height and no more.
- Never put a token in a URL except the local `#backend=…&token=…` development
  hash the template supports, and never ship that hash.
