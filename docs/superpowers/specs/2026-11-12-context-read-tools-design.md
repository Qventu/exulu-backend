# Context read tools for agents — design (2026-11-12)

## Intent
Agents that may write a knowledge base today read an item only through a workaround: an `update_<ctx>_item` call with nothing but `updated_at`, which asks the user for approval and returns the current item as a side effect. M&V hit this on "Export als Excel" (2026-11-12): an approval prompt for a no-op write, and one agent run that went around the tools to the database. Agents need a first-class, approval-free way to read one item and to find items.

## Goals
- Per context, two generated tools next to `create_<ctx>_item` / `update_<ctx>_item`: `get_<ctx>_item` and `find_<ctx>_items`.
- No approval for reads (`needsApproval: false`), item access control applied (a record the user may not read is "not found", never leaked).
- Zero configuration change: every context the `knowledge_base_editor` grants `create` or `update` also gets the two read tools (write implies read). No frontend change in this release.
- Fix the read-back bug that blocks the workaround and the new tool alike: `ExuluContext.getItem` counts chunks on a table that does not exist for contexts without an embedder (`relation "mv_pitches_chunks" does not exist`).

## Non-goals
- A read-only grant (contexts the agent may read but not write) — follow-up with its own config entry and UI.
- Full-text/semantic search — that is `agentic_context_search`; `find` is a structured filter over columns and typed json paths.
- Changing the write tools' behaviour.

## Tool contracts
`get_<segment>_item` — input `{ id?: string, external_id?: string, fields?: string[] }` (one of id/external_id required). Output `{ result: string }` with `Item: <json>` — all content fields (including typed json) plus `id`, `name`, `external_id`, `created_at`, `updated_at`, `rights_mode`; `fields` narrows to the named content fields (unknown names → tool-result error listing valid names). Access: `checkRecordAccess(record, "read", user)`; without user or without access → the same `NOT_FOUND` text the write tools use. Large items are handled by the existing tool-output offload (no special casing).

`find_<segment>_items` — input `{ where?: Filter, limit?: number, fields?: string[] }`. `where` is the platform filter grammar already used by GraphQL and agentic retrieval: `{ <field>: { eq | ne | contains | in | gt | gte | lt | lte: value } }`, several fields and-ed; typed json paths allowed where the field schema declares them. Executed through `ExuluContext.getItems({ filters: [where], fields, user, role, limit })` so `applyFilters` stays the single chokepoint and `applyAccessControl` applies. `limit` default 20, max 50 (clamped, never rejected). Output `{ result }` with `Found <n> item(s): <json array>`; a filter on an unknown path (`UnknownFilterPathError`) comes back as a tool result naming the valid paths, not as a thrown error. Default `fields` when omitted: `id`, `name`, `external_id`, `updated_at` plus every non-file content field.

Segment rule, hidden/non-editable field exclusion and the `NOT_FOUND` constant are shared with `context-write-tools.ts` (import, do not copy).

## getItem fix
`getItem` queries `getChunksTableName(this.id)` for every read. Contexts without an embedder never get a chunks table. Rule: count chunks only when `this.embedder` is set; otherwise `chunksCount = 0`. No schema change, no migration.

## Docs
`building/agents/tools-and-skills.mdx` (Knowledge base editor: list the four generated tools, note reads need no approval), `building/agents/access-and-safety.mdx` (reads apply the item's access rights; nothing is leaked by "not found"), `building/knowledge/items.mdx` (the sentence about what an agent can do during chat). Release notes come from semantic-release (`fix:` + `feat:` → minor).

## Follow-ups outside this repo
mevakipi: skills switch from the no-op update to `get_mv_pitches_item` / `find_mv_pitches_items`; `exportNachricht` stops announcing approvals; runbook step for the version bump.
