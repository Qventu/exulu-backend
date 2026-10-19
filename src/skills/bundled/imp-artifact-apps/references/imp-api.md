# The IMP API from inside an artifact

Everything goes to `${backendOrigin}` with `Authorization: Bearer <token>`.
GraphQL at `POST /graphql` (`{ query, variables }`); a few REST routes for bytes.
Outside the viewer (scripts, tests) an org API key works in the same places:
`x-api-key: sk_…/keyname` (a `Bearer ` prefix is tolerated); see
`/api-reference/graphql/introduction` in the docs. Full reference of the
generated operation set: `/api-reference/graphql/conventions` and
`/api-reference/graphql/dynamic-types`.

## Discover what exists

Introspection works with the viewer's token:

```graphql
{ __schema { queryType { fields { name } } } }
```

Every context (table) appears as `<ctx>_itemsPagination`, `<ctx>_itemsById`,
`<ctx>_itemsByIds`, `<ctx>_itemsOne`, `<ctx>_itemsStatistics`. Field names of a
table: `{ __type(name: "<ctx>_items") { fields { name type { name } } } }`.
Routines (workflow templates): `workflow_templatesPagination { items { id name description } }`.

## Reading rows

```graphql
query ($limit: Int, $page: Int) {
  tenders_itemsPagination(
    limit: $limit, page: $page,
    sort: { field: "createdAt", direction: DESC },
    filters: [{ status: { eq: "open" } }, { display_name: { contains: "Portal" } }]
  ) {
    pageInfo { itemCount pageCount currentPage hasNextPage hasPreviousPage }
    items { id name description created_by rights_mode createdAt updatedAt status cockpit }
  }
}
query ($id: ID!) { tenders_itemsById(id: $id) { id name cockpit } }
```

- Several entries in `filters` are ANDed. Inside one field: `and: [...]`, `or: [...]`.
- Operators by field type — String: `eq ne in contains`; Float: `eq ne lte gte in`;
  Date: `lte gte`; Boolean: `eq ne in`; JSON: `eq ne in contains`; enum fields:
  `eq ne in`. There is no `like`/`ilike`; `contains` is the substring match.
- `sort.field` must be a real column (`createdAt`/`updatedAt` and the
  context's own fields; not `created_at`).
- Rows the viewer may not read are filtered out silently, not reported.

## Writing rows

```graphql
mutation ($id: ID!, $input: tenders_itemsInput!) {
  tenders_itemsUpdateOneById(id: $id, input: $input) { item { id updatedAt cockpit } job }
}
mutation ($input: tenders_itemsInput!) {
  tenders_itemsCreateOne(input: $input) { item { id } }
}
mutation ($id: ID!) { tenders_itemsRemoveOneById(id: $id) { id } }
```

- `created_by` is set by the server and cannot be changed through `input`.
- Write access: the creator, a `rights_mode: "public"` row (anyone logged in),
  or an rbac grant (`users`/`roles`/`teams`) with `rights: "write"`. A `private`
  row created by a tool with no creator is read-only for everyone but admins —
  tools that create rows for an app should write `rights_mode: "public"`.
- For app state keep **one JSON field** (e.g. `cockpit`) and update it with a
  read-merge-write: read the row, merge your overlay, write the whole field,
  then re-read. Several screens writing the same field concurrently must merge
  on the server's copy, not on their own stale one.

## Routines (long-running work)

A Routine is a row in `workflow_templates`: an agent, a queue, and a step text
such as "Call the Tender tool exactly once for tender {tender_id} with action
{action} {options} and report briefly." Variables in `{braces}` are substituted
from `variables`; an empty value throws, so always send every variable the text
names (use a harmless phrase such as "without further options").

```graphql
mutation ($id: ID!, $variables: JSON) {
  runWorkflow(id: $id, variables: $variables) { job result metadata }
}
query ($workflow: ID) {
  routineRuns(workflow: $workflow, limit: 100) {
    items { id job_id state error createdAt updatedAt session inputTokens outputTokens costUsd }
    total
  }
}
query ($session: String!) {
  agent_messagesPagination(page: 1, limit: 50,
    sort: { field: "createdAt", direction: ASC },
    filters: [{ session: { eq: $session } }]) {
    items { id content createdAt }
  }
}
```

- `runWorkflow` returns the `job` id immediately; match it against
  `routineRuns.items[].job_id` (there is no job filter — filter client-side).
- Poll every few seconds with backoff; stop on a terminal `state`
  (`completed`, `failed`, `cancelled`). Then re-read the rows the tool changed.
- `session` on a run is the agent session: its `agent_messages` show the
  tool calls and results, which is what a "run log" screen renders.
- Running a Routine needs write access to the template row; give app routines
  `rights_mode: "public"`.
- Routine ids are environment data. Keep them in one constants module, create
  the rows per environment with an idempotent script, and show a clear message
  when a run fails with "Workflow template not found in database."

## Files

- Upload: `POST /s3/sign` with `{ "filename": "...", "type": "<mime>" }` →
  `{ url, key, method: "PUT" }`; then `PUT` the bytes to `url` with the same
  `Content-Type`. The stored key is the URL's path (bucket first on path-style
  endpoints); the share and context APIs normalise it.
- Read: `GET /s3/download?key=<stored key>` with the Bearer token returns the
  bytes; for images inside the app, fetch to a `blob:` URL — `img-src` allows it.
- Shares: `GET /shared-artifacts/<name>/meta` (public metadata),
  `POST /shared-artifacts` (create), `GET /shared-artifacts/<name>/settings`
  and `PATCH /shared-artifacts/<name>` (creator or admin: name, auth_mode,
  password, expires_at, rights_mode, rbac, s3key), `DELETE /shared-artifacts/<name>`.

## The viewer's user

Only what the grant carries: `user.email`, `user.name`. For anything else
(role, teams, id) query `userById`/`users` with the token — the viewer can read
their own row.
