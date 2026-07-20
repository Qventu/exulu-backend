# P2 Task 11 Report: GraphQL — trigger CRUD + emailInboundConfig

## Status
DONE — all acceptance criteria met.

## Commit
`882da66` feat(email-inbound): GraphQL trigger CRUD + emailInboundConfig

## What was implemented
- Added imports for `getEmailInboundConfig`, `updateEmailInboundConfig`, `generateTriggerAddress`, `validateEmailTriggerConfig`, `parseTriggerConfig` to `src/graphql/schemas/index.ts`.
- Added `workflowTriggers(workflow: ID!): [WorkflowTrigger!]!` and `emailInboundConfig: EmailInboundConfig` to typeDefs.
- Added `upsertWorkflowEmailTrigger`, `deleteWorkflowTrigger`, `updateEmailInboundConfig` to mutationDefs.
- Added `type WorkflowTrigger` and `type EmailInboundConfig` to modelDefs — char-exact match to the SDL contract.
- Added six resolvers: `workflowTriggers`, `upsertWorkflowEmailTrigger`, `deleteWorkflowTrigger`, `emailInboundConfig`, `updateEmailInboundConfig` — plus helpers `loadWorkflowTemplateWithRBAC`, `requireWorkflowsWriteRole`, `toWorkflowTriggerPayload`, `toEmailInboundConfigPayload`.

## Two carried obligations
1. **Bounded address-collision retry**: upsertWorkflowEmailTrigger wraps `generateTriggerAddress` + existence check in a `for (attempt = 0; attempt < 5; attempt++)` loop; throws a clear error if all 5 fail.
2. **Signing key never crosses GraphQL boundary**: `toEmailInboundConfigPayload` maps `signing_key` to `has_signing_key: !!inbound.signing_key` and never selects or returns the key; `updateEmailInboundConfig` accepts it as input only.

## Test summary
87 tests passed, 0 failed across 8 suites (email-inbound × 7 + validators/bullmq × 1). Pre-existing type errors and lint issues are unchanged; zero new errors from Task 11 files.

## SDL verification
All 7 contract patterns confirmed in `src/graphql/schemas/index.ts` SDL strings (grep on lines 686–788). Type blocks are char-exact matches to the Plan 3 SDL contract.

## Concerns
None. Manual E2E checklist (Mailgun EU sandbox + tunnel) remains for release; it cannot be automated.

## Report path
/Users/daniel.claessen/Desktop/Projects/exulu/backend-email-routines/.superpowers/sdd/p2-task-11-report.md

---

## Fix note (code-review findings, 2026-07-17)

### Finding 1 — INSERT inside the retry loop (binding)

The SELECT-pre-check-then-INSERT pattern was replaced with a race-safe design:
`insertTriggerWithRetry` in `src/exulu/email-inbound/resolver-helpers.ts` runs the INSERT inside the loop. On a `{ code: "23505" }` (Postgres unique violation) the loop continues with a fresh candidate address; any other error is rethrown immediately; after 5 collisions a clear error is thrown. The resolver in `src/graphql/schemas/index.ts` now delegates to this helper. No SELECT pre-check remains.

### Finding 2 — Unit-testable resolver helpers (minor)

Extracted `toEmailInboundConfigPayload` and `insertTriggerWithRetry` into `src/exulu/email-inbound/resolver-helpers.ts`. The inline closure in `index.ts` was replaced with a comment + import. Tests added in `src/exulu/email-inbound/resolver-helpers.test.ts` (chainable-mock style, matching the module's existing pattern):
- `toEmailInboundConfigPayload`: signing_key absent from output, has_signing_key true/false both covered, webhook_url from process.env.BACKEND.
- `insertTriggerWithRetry`: success on first attempt; first-two-collide-third-succeeds; non-23505 rethrown immediately; five 23505s → /after 5 attempts/.

### Test summary after fix
92 tests passed, 0 failed across 8 suites (all email-inbound suites). Zero new TypeScript errors.
