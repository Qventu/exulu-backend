# Feature 1 — OAuth 2.0 for ExuluTools

**Spec:** docs/superpowers/specs/2026-06-10-exulu-tool-oauth-design.md (commit 5150af5)
**Surface:** Developer / SDK (backend `ExuluTool` constructor + generic `/oauth/callback` route)

## Hook

"Connect your tools to Google, Slack, HubSpot — any OAuth provider — with one config property. No plumbing."

## Demo arc (~9s, 1920×1080)

Code-reveal pattern (API-feature recipe):

1. 0.0–1.6s — Hook caption enters, holds.
2. 1.6–5.2s — Editor card: `new ExuluTool({ ... })` snippet with the `oauth: { ... }` block
   revealed line-by-line (syntax-highlighted, JetBrains Mono). The `oauth` key glows in primary purple.
3. 5.2–7.4s — Cut to a chat bubble: tool result card "Authorization required — Connect HubSpot →"
   (button in primary), then a ✓ "Connected" state swap.
4. 7.4–9.0s — Payoff caption: "Exulu handles the tokens, refresh, and callback." Hold ≥1.4s.

One slice: declare → user connects. No multi-step retry shown.

## Code snippet for the page (TypeScript — earned: SDK surface)

```ts
new ExuluTool({
  id: "hubspot_crm",
  name: "HubSpot CRM",
  type: "function",
  oauth: {
    authorizationUrl: "https://app.hubspot.com/oauth/authorize",
    tokenUrl: "https://api.hubapi.com/oauth/v1/token",
    clientId: process.env.HUBSPOT_CLIENT_ID!,
    clientSecret: process.env.HUBSPOT_CLIENT_SECRET!,
    scopes: ["crm.objects.contacts.read"],
  },
  execute: async (inputs) => {
    // runs only with a valid token
    const token = inputs.oauth.accessToken;
  },
});
```

## Page copy beats

- Per-user tokens: each user connects their own account; tokens are stored encrypted and auto-refreshed.
- Agent-native UX: when authorization is missing the tool returns a connect link the agent shows in chat.
- Zero routes to write: one generic `/oauth/callback` ships with the platform; PKCE on by default.
