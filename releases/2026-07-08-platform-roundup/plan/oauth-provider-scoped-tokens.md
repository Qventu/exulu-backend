# Feature plan — OAuth: one consent per provider (PROSE + snippet)

## Sources of truth

- Spec: `docs/superpowers/specs/2026-07-03-oauth-provider-scoped-tokens-design.md`
- Code: `src/exulu/oauth/types.ts` (`ExuluOauthConfig.provider` — shipped
  docblock verified), `registry.ts`, `token-store.ts`, `flow.ts`,
  `callback-handler.ts`, `wrap-execute.ts`
- Commits: `a7d88dd` → `2e47af0` (`5562dc9` registry keyed by provider,
  `2fbfb13` provider column, `b64b567` store/flow/callback keyed by provider,
  `26fce93` dropped the backfill — no production users needed it, `2e47af0`
  validation + callback HTML escaping)
- SDK export: `src/index.ts:22` — `export type { ExuluOauthConfig, ... }`

## What shipped

OAuth token storage moved from `(tool_id, user_id)` to `(provider, user_id)`.
A tool opts in by setting `provider: "jira"` (or `"google"`, `"github"`, …) on
its OAuth config; every tool sharing that provider now shares one token row per
user — **one consent screen per provider, not per tool**. Before: six `jira_*`
tools meant clicking Connect six times for the same OAuth app.

Safety rails that make sharing sane:

- **Registration-time compatibility check.** Two tools claiming the same
  provider must agree on `clientId`/`clientSecret`/`authorizationUrl`/`tokenUrl`
  and declare the identical scope set — otherwise `ExuluTool` construction
  throws with a precise error. No silent scope escalation, ever.
- **Backward compatible.** `provider` is optional; when omitted it defaults to
  the tool's id, preserving per-tool tokens exactly as before. Zero changes for
  tools that don't opt in.
- `tool_id` stays on each token row for audit (which tool the user clicked
  through), it's just no longer the key.

## Hook

**"Connect Google once — every Google tool is signed in."**

## Surface area

Backend/SDK feature, prose-only. Audience: teams building tool suites on
`ExuluTool`.

## Page prose plan (2–3 paragraphs)

1. The pain: per-tool consent made multi-tool integrations feel broken — same
   provider, same scopes, six Connect buttons.
2. The fix: one `provider` string; the registry enforces identical
   client/URLs/scopes across the provider at construction time, so a shared
   token always carries the scopes every tool declared.
3. Migration posture: opt-in, non-breaking, tokens keyed per (provider, user).

## Code snippet — EARNED (TypeScript, SDK)

`ExuluOauthConfig.provider` verbatim from `src/exulu/oauth/types.ts`; tool shape
from `ExuluTool` (both exported in `src/index.ts`):

```ts
new ExuluTool({
  id: "jira_create_issue",
  // ...
  oauth: {
    provider: "jira", // ← share one consent across every jira_* tool
    authorizationUrl: "https://auth.atlassian.com/authorize",
    tokenUrl: "https://auth.atlassian.com/oauth/token",
    clientId: process.env.JIRA_CLIENT_ID!,
    clientSecret: process.env.JIRA_CLIENT_SECRET!,
    scopes: JIRA_SCOPES, // must match across the provider — enforced at boot
  },
});
```

Label on page: "From the SDK — ExuluOauthConfig".
