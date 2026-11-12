# Context read tools — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox syntax.

**Goal:** Generated `get_<ctx>_item` / `find_<ctx>_items` tools for every context the KB editor grants, approval-free and access-controlled, plus the `getItem` chunk-count fix.
**Architecture:** New module `src/templates/tools/context-read-tools.ts` mirrors `context-write-tools.ts` (same segment rule, same field exclusion, same NOT_FOUND); `collectKbWriteTools` additionally emits the read tools per configured context; `ExuluContext.getItems` gains `limit`; `getItem` guards the chunk count.
**Tech stack:** TypeScript, zod, knex, jest (`npm test -- <file>`), mintlify docs.
**Spec:** `docs/superpowers/specs/2026-11-12-context-read-tools-design.md`

## Global Constraints
- `needsApproval: false` on both read tools; write tools unchanged.
- Access: `get` → `checkRecordAccess(record, "read", user)` (`src/utils/check-record-access.ts`); `find` → `getItems` with `user`/`role` (applyAccessControl). No user → NOT_FOUND / empty.
- One filter chokepoint: `find` passes `where` into `getItems({ filters: [where] })`; never builds SQL itself. `UnknownFilterPathError` → tool result text.
- Tool ids: `get_${segment}_item`, `find_${segment}_items` with the write tools' `segment` helper (68-char cap). Category `knowledge_base_reading`.
- No frontend change; `knowledge_base_editor` config untouched (read tools derive from create||update).
- Typecheck gate: `npx tsc --noEmit -p .` must report the SAME error count/identities as develop (baseline 8, see feedback-typecheck-count-is-equality); jest green for touched files; commit subjects conventional (`fix:` / `feat:` / `docs:` / `test:`), lowercase.
- Do not touch `convert-exulu-tools-to-ai-sdk-tools.ts` beyond what task 3 names.

## Review Focus
1. A context without embedder: `getItem` must not query the chunks table (the M&V failure).
2. A record the user may not read: `get` returns NOT_FOUND text, no field of the record appears in the output.
3. `find` with `limit: 500` → 50 results, not an error; with `limit: 0`/negative → default 20.
4. `find` with a filter on a json path the schema does not declare → tool result names valid paths; nothing thrown.
5. `fields` naming a hidden or unknown field → tool-result error, no data.

### Task 1: getItem chunk-count guard
**Files:** Modify `src/exulu/context.ts` (getItem), Test `src/exulu/context.test.ts` (or a new `context-get-item.test.ts` next to it if the existing file needs a live DB).
- [ ] Write the failing test: a context constructed without `embedder` calls `getItem` → the knex mock receives no query against `getChunksTableName(id)` and the result carries `chunksCount: 0`; a context with embedder still counts.
- [ ] Run it; expect FAIL (chunks query issued).
- [ ] Implement: `if (result) { result.chunksCount = this.embedder ? Number((await …count("id"))[0].count) || 0 : 0; }`.
- [ ] Run; PASS. Commit `fix(context): getItem counts chunks only when the context has an embedder`.

### Task 2: read tools module
**Files:** Create `src/templates/tools/context-read-tools.ts`, Test `src/templates/tools/context-read-tools.test.ts`; Modify `src/exulu/context.ts` (`getItems` gets `limit?: number` → `query.limit(limit)` when > 0).
**Interfaces:** Consumes from `context-write-tools.ts`: the segment helper and `NOT_FOUND` (export them if not exported yet — same values), the content-key / hidden-field exclusion helper. Produces `createContextReadTools(context: ExuluContext, deps?: ReadToolDeps): ExuluTool[]` returning `[getTool, findTool]`.
- [ ] Tests first (mirror `context-write-tools.test.ts` fixtures): ids/names; `needsApproval === false`; `get` happy path (mock `context.getItem` + `checkRecordAccess` true) returns `Item: {...}` with system + content fields; `get` without access → NOT_FOUND and no field value in the output; `get` with `fields: ["unknown"]` → error text listing valid names; `find` calls `getItems` with `filters: [where]`, `user`, `role`, clamped `limit` (20 default, 50 max); `find` when `getItems` throws `UnknownFilterPathError` → result text contains the error message, nothing thrown; `find` default fields exclude file fields.
- [ ] Run; FAIL (module missing).
- [ ] Implement per spec.
- [ ] Run; PASS. Commit `feat(tools): generated get_/find_ read tools per knowledge base context`.

### Task 3: wiring
**Files:** Modify `src/templates/tools/context-write-tools.ts` (`collectKbWriteTools` pushes `createContextReadTools(context, deps)` for every configured context; picker description says "create, update, read and find"), `src/templates/tools/convert-exulu-tools-to-ai-sdk-tools.ts` only if the read tools need a deps field the collector does not already pass; Test `context-write-tools.test.ts` (`collectKbWriteTools` now yields 4 tools for a create+update context, 3 for update-only, read tools never need approval even with `skip_approval: false`).
- [ ] Tests first; FAIL; implement; PASS. Commit `feat(tools): knowledge base editor also expands into read tools`.

### Task 4: docs
**Files:** Modify `mintlify-docs/building/agents/tools-and-skills.mdx` (section "Knowledge base editor": the four tools, filter grammar example for `find`, reads need no approval), `mintlify-docs/building/agents/access-and-safety.mdx` (reads obey item rights; not-found leaks nothing), `mintlify-docs/building/knowledge/items.mdx` (sentence).
- [ ] Edit; `npx mintlify broken-links` if available (else skip); commit `docs(agents): read tools next to the knowledge base editor`.
