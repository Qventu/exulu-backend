# Upstream Engineering Notes

Engineering flags accumulated during the IMP documentation build (Task 29).
These notes are for the engineering team — not published to the docs site (`.mintignore`d).

---

## Self-Hosting / Deployment

**No `/health` endpoint or container healthchecks.**
The backend and worker expose no dedicated health route. The only probeable path for liveness checks is `"/"` on the backend. Container healthchecks are absent from all compose files. Operators relying on automated health probes (load balancers, orchestrators) must use a TCP socket check or configure custom probes against the root path.

**`example` compose references missing `postgres/schema.sql`.**
`docker-compose.services.yml` mounts `./postgres/schema.sql` into the pgvector container's init directory. This file is not included in all repo checkouts. Workaround documented in the quickstart: `mkdir -p postgres && touch postgres/schema.sql`. The file should either be committed to the example repo or the mount removed if it is no longer used.

**Worker container EXPOSEs 9002 but binds no HTTP listener.**
The worker `Dockerfile` or compose file exposes port 9002, but the worker process does not start an HTTP server on that port. The `EXPOSE` directive is misleading; remove it or add a healthcheck endpoint if monitoring is needed.

**`docker-compose.worker.yml` lacks `env_file`.**
The backend compose file correctly sources `.env` via `env_file: - .env`. The worker compose file omits this. Outside Dokploy (where vars are injected by the platform), the worker starts without database and Redis credentials and crashes. Fix: add `env_file: - .env` to the worker service, or document the injection requirement clearly.

---

## Backend Configuration

**Backend README env section references wrong variable names.**
The README documents `DATABASE_URL` as the Postgres connection variable, but the application reads `POSTGRES_DB_HOST`, `POSTGRES_DB_PORT`, `POSTGRES_DB_USER`, `POSTGRES_DB_PASSWORD`, and `POSTGRES_DB_NAME` individually. The README should be corrected or a note added explaining the split-variable scheme.

**SMTP variable names drift between `.env.example` and code.**
`.env.example` uses `SMTP_USERNAME`; the backend code reads `SMTP_USER` (or similar). Audit all SMTP-related variable names and align `.env.example` with what the code actually reads.

---

## Operator UX

**`initdb` logs a fresh (unstored) API key on every boot.**
The database initialiser runs on every backend startup and prints a newly generated admin API key to stdout. Only the key generated on the very first startup is ever persisted. Keys printed on subsequent startups are discarded. This creates confusing operator UX where every deployment log contains a key that does not work. Consider suppressing the log on subsequent boots or printing a clear "this key is NOT valid — see first-boot log" message.

---

## Application Logic / API

**ID validator accepts length > 2 but error message says "at least 5".**
The slug/ID validator accepts IDs shorter than 5 characters (minimum appears to be 3 or fewer), but the `create()` error response states "ID must be at least 5 characters". Align the validator and the error message.

**`app/index.ts` JSDoc contradicts code on `requireSystemDependencies` default.**
The JSDoc comment says the default is `false` (lenient), but the code default is `"strict"` (throw on missing dependencies). Fix the JSDoc.

**Vector-search caps `limit` at 250 but the error message says 1000.**
The vector-search endpoint enforces a hard cap of 250, but the validation error message reads "limit may not exceed 1000". Correct the error message or raise the cap.

---

## Known SDK / Pipeline Gaps

**`resultReranker` is accepted by `ExuluContext` but its call site is commented out.**
`vector-search.ts` (~line 611) has the reranker pipeline call commented out. Queries pass `resultReranker` options that are silently ignored at runtime.

**`updateItem` returns the pre-update record.**
The knowledge item update path returns the record state from before the update is applied. Callers that inspect the return value receive stale data.

**`deleteAll` returns hardcoded `{count: 0}`.**
The bulk-delete helper always returns `{count: 0}` regardless of how many records were deleted.

**`createItem` returns `{id}` only.**
The item creation path returns only the new ID; callers must issue a subsequent query to retrieve the full created record.

**`agents()` RBAC resolution is gated inside the `include.source.code` branch.**
When a query requests agents with `code: false` (or omits the `source` include), the RBAC check for agent visibility is skipped. This may expose agents that should be hidden from the calling role.

---

## GraphQL / API

**`rbac` table has `graphql: false`.**
The `rbac` entity is excluded from the GraphQL schema. If any client or internal tool needs role-binding introspection via GraphQL, this must be enabled explicitly.

**`statistics` schema emits SDL type `tracking`.**
The statistics schema produces a GraphQL SDL type named `tracking` which is a technical artefact leaking from the `statistics` internal schema name. Rename to `StatisticsResult` or similar for public API cleanliness.

**`/agents/litellm/run` sync mode returns a bare JSON string.**
The synchronous run endpoint returns an unstructured JSON string instead of a typed response envelope. Consumers cannot reliably parse usage metadata. Consider returning a structured object with at least `{ result, usage }`.

**Anthropic gateway route is deprecated (shim).**
The `/agents/anthropic/*` gateway is a compatibility shim planned for removal. Communicate a deprecation timeline and remove comms so downstream integrators can migrate to the LiteLLM-based route.

---

## Frontend / UI

**`nav-config.ts` stale comment.**
A comment in `nav-config.ts` reads `"Label canon: 'Configuration', not 'Theme'"` but the live nav label is "Theme". Remove or update the comment.

**`en.json` evals list has unused column keys.**
`cases` and `lastRun` column keys are defined in the frontend translation file but are not rendered in the UI (deferred pending a backend API). Clean up or annotate as pending.

---

## npm

**`exulu-example` still carries legacy `NPM_TOKEN` plumbing.**
`docker-compose.backend.yml` (and `docker-compose.worker.yml`) pass `NPM_TOKEN` as a Docker build argument, and `.npmrc.example` configures the `//registry.npmjs.org/:_authToken` line. `@exulu/backend` is now on the public npm registry — no token is required. The build arg and `.npmrc.example` plumbing are candidates for cleanup.

---

## Versioning

**Package version scheme `0.3.13-development` vs old docs' `1.4x` line.**
Confirm the public versioning story before announcing the new documentation site. The old backend README referenced a `1.4x` release line; the current package.json reports `0.3.13-development`. Align version communication or add a migration note in the changelog.
