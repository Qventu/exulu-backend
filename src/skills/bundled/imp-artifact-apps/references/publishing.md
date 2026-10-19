# Publishing an artifact app

## Share modes

| `auth_mode` | Who opens it | Identity handshake | Rights scope |
|---|---|---|---|
| `regular` | logged-in IMP users who pass the share's rights | yes | `rights_mode` private / public / users / roles / teams (+ rbac) |
| `password` | anyone with the link and the password | no | — |
| `public` | anyone with the link | no | — |

An app that reads or writes IMP data must be `regular`. `rights_mode` decides
who sees the share in the Artifacts list and may open it: `private` = the
creator, `public` = every logged-in user, or an explicit rbac scope.

## From the IMP

Artifacts (main navigation) → **New artifact** → drop the `.html` → name the
link (this becomes `/artifacts/<name>`) → Access "Logged-in users" → rights
scope → Publish. The row menu (…) of an artifact offers Rename, Sharing (mode,
password, expiry, scope) and Delete. Opening from the list shows the app inside
the IMP shell at `/artifacts/open/<name>`; the share link `/artifacts/<name>`
shows it full-screen with the same handshake.

## From the command line

`scripts/publish-artifact` reads the IMP connection from `~/.config/imp/skills.json`
(written by the IMP installer: `curl -fsSL <base_url>/api/skills/install.sh | sh`)
and never prints the key.

```
sh "<this-skill-dir>/scripts/publish-artifact" <name> dist/index.html
sh "<this-skill-dir>/scripts/publish-artifact" <name> dist/index.html --rights public
sh "<this-skill-dir>/scripts/publish-artifact" <name> report.pdf --access password --password <pw> --expires-days 7
```

- A new name creates the share (default: logged-in users, private, no expiry).
- An existing name you own **updates the bytes in place**: new upload, the
  share is re-pointed at it, the link and the viewers' stars survive. Sharing
  settings are untouched; change them in the Sharing dialog or with a PATCH.
- `users`/`roles`/`teams` scopes need ids; set those in the Sharing dialog.

## What the viewer does with the file

- `.html`/`.htm` renders in the sandboxed frame with the handshake.
- PDFs and images render inline (fetched as a blob); everything else (slides,
  sheets, documents) gets a download card. The content type comes from the
  upload, so send the right one.
- The frame is the full content area of the IMP shell (full-bleed) or the full
  window on the share link. The app owns its scrolling.

## Checklist before publishing

- One file, no external `src`/`href` except the CSP-allowed hosts, no
  `type="module"` on the inlined script, mount after `DOMContentLoaded`.
- The first screen is useful without any click; every region has loading,
  empty and error states; a session-lost banner says "reload the IMP tab".
- No token in the file, no `console.log` of the grant.
- The name is a slug (`[a-z0-9][a-z0-9._-]*`), stable across updates.
