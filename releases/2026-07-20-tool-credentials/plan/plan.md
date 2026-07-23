# Tool credentials — release plan (2026-07-20)

Feature (DEVELOPER-FACING): ExuluTool auth generalized from OAuth-only to an
authentication union. New user_credentials type: a tool declares the fields it
needs (API key, username/password); Exulu prompts the user in chat, stores the
values encrypted per-user, injects them at execute time, and self-heals — a
CredentialInvalidError wipes the stale secret and re-prompts.

Research: ./research.md (verbatim types, routes, e2e flow — the source of truth).

NOTE: this work lives on branch feat/auth-user-credentials (not yet merged to
develop) and there is NO dedicated frontend credential form yet — the
credential request surfaces through the generic tool card. Do NOT invent a
polished form UI. Show the honest developer story: code + payload + flow.

Hook: One property makes any tool self-authenticating.

## Shorts (1920×1080, 8–9s each, output to ../shorts/)

1. **define-tool** (8s, recipe B) — dark editor (code surface #22253A,
   JetBrains Mono). The ExuluTool definition types in fast — the REAL shape
   from research.md: new ExuluTool({ …, authentication: { authType:
   "user_credentials", provider, fields } }). Marker sweep underlines the
   authentication block. Payoff: "OAuth or credentials — same field."

2. **credential-flow** (9s, recipe B/D hybrid) — three-stage flow panel, calm:
   (1) tool call short-circuits → the credentialRequest payload appears as
   pretty JSON ({ provider, fields, submitUrl, nonce }); (2) POST
   /credentials/submit { nonce, values } types in a terminal line → 200
   { ok: true }; (3) the tool chip re-runs and returns data. Caption between
   stages: "Stored encrypted. Injected server-side." Payoff: "The model never
   sees the secret."

## Code snippets

1. "From the SDK" — the ExuluTool definition with authentication:
   user_credentials, assembled ONLY from real fields (research.md has the
   verbatim union + e2e construction). ≤12 lines.
2. "REST" — curl POST /credentials/submit with { nonce, values } body.

## Page prose extras

- The union: oauth arm unchanged (3-legged flows keep working); explicit
  authType tag replaces the old ExuluTool.oauth field (breaking rename).
- Self-heal loop: CredentialInvalidError → stale credential deleted →
  re-prompt in the same chat turn.
- Storage: user_credentials table, encrypted JSON blob per (provider, user).

## Build rules (apply to every short)

- Follow the hyperframes skill; register paused timeline on window.__timelines.
- Read-time floors: short phrase ≥1.0s static hold AFTER entrance; sentence
  ≥1.8s. Breath ≥600ms after each stage resolves. Final 1.5–2s still.
- Code typing: word-stream, fast (not per-char slow); syntax highlight with
  brand primary #7033FF for keywords, green for strings (match the house code
  style in previous release pages).
- Brand tokens: copy design.md from
  ../../2026-07-13-connect-your-agent/hyperframes/connect-modal/design.md.
- House caption style: mimic
  ../../2026-07-13-connect-your-agent/hyperframes/list-skills/index.html.
