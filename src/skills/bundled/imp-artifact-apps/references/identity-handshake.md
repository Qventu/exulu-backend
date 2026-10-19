# The identity handshake (v1)

The artifact runs on an opaque origin and cannot create a session. The IMP page
that embeds it (`ArtifactFrame`) holds a real session and hands the artifact a
short-lived grant for the person looking at it — only for shares published as
`regular` (login required), because such a share renders only after the viewer
passed the row's rights check, so handing them their own identity grants nothing new.

## Messages

| Direction | Message |
|---|---|
| iframe → parent (`window.parent.postMessage`, target `*`) | `{ type: "exulu:identity:request", v: 1 }` |
| parent → iframe (`postMessage` with a transferred `MessagePort` in `event.ports[0]`) | `{ type: "exulu:identity:channel", v: 1 }` |
| parent → iframe (over the port) | `{ type: "exulu:identity:grant", v: 1, token, backendOrigin, user: { email, name } }` |
| parent → iframe (over the port) | `{ type: "exulu:identity:denied", v: 1, reason }` |
| iframe → parent (over the port) | `{ type: "exulu:identity:refresh", v: 1 }` → answered with a grant or a denial |

Verify `v === 1` and the `type` on every message. The credential only ever
travels over the port, never over `window.postMessage` — a port is bound to the
document that received it, so a navigation of the frame cannot intercept it.

## Timing rules

1. **Listener first, then ask.** The parent answers at most one request per
   frame load. A reply that arrives before you listen is lost for good.
2. **Ask repeatedly** (every ~300 ms) until the channel arrives, with an overall
   timeout of ~10 s. The parent's listener is registered in a client effect and
   does not exist until the IMP page has hydrated, while the iframe runs as soon
   as the page's HTML is parsed. Extra requests cost nothing: the parent ignores
   requests after the first answered one. Stop the interval the moment you settle.
3. **One refresh per auth failure, single-flighted.** Concurrent failures share
   one refresh promise. The port has one `onmessage` slot; two refreshes at once
   would clobber each other's handler and strand one until its timeout.
4. **A second auth failure after a refresh means the session is gone.** Show a
   banner telling the viewer to reload the IMP tab. Do not retry in a loop: each
   answered request costs the parent backend calls, and a dead session stays dead.

## What counts as an auth failure

- HTTP `401` from `/graphql` or a REST route.
- HTTP `500` from `/graphql` whose body has an `errors[].message` containing
  `Context creation failed` — this is how Apollo reports a token that no longer
  authenticates; it is the common case for an expired viewer token.

Not an auth failure: HTTP `200` with `errors[]` (a data or rights error on a row
— surface it), `403` on a REST route (rights, not session), `404`, `409`.

## The grant

`token` is the viewer's own JWT for the backend; send it as
`Authorization: Bearer <token>`. `backendOrigin` is where to send requests
(`${backendOrigin}/graphql`, `${backendOrigin}/s3/sign`, …). `user.email` /
`user.name` are for display and for stamping who did something; never use them
as authorisation.

## Development outside the IMP

`templates/app.html` falls back, only when it is the top window (not embedded),
to `location.hash` → `#backend=http://localhost:9001&token=<jwt or api key>`.
The hash never leaves the browser, but it is a development convenience only;
there is no refresh in that mode, and no artifact must ever rely on it.
