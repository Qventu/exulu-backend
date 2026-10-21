# Knowledge Folders — Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A core table `context_folders` (admin-managed grouping of knowledge contexts for the UI), writable by super admins only, readable by every authenticated user.

**Architecture:** One schema entry in `src/postgres/core-schema.ts`; the table is created on boot like every core table and gets the generic GraphQL CRUD; `apiWrites: "super_admin"` is the write guard the generic resolvers already enforce.

**Tech Stack:** TypeScript, knex core schema, jest.

**Spec:** `/Users/daniel.claessen/Desktop/Projects/exulu/frontend/docs/superpowers/specs/2026-10-21-knowledge-folders-design.md` (lives in the frontend repo; D1–D3 bind this plan).

## Global Constraints

- Table: `type: "context_folders"`, `name: { plural: "context_folders", singular: "context_folder" }`, `RBAC: false`, `apiWrites: "super_admin"`.
- Fields, in this order: `name` (text, required, index), `description` (text), `icon` (text), `sort_order` (number, default 0), `context_ids` (json, required).
- No resolver changes, no new SDL; the generic CRUD (`context_foldersPagination`, `context_foldersCreateOne`, `context_foldersUpdateOneById`, `context_foldersRemoveOneById`) is the API.
- Commit message conventional, lowercase.

## Review Focus

1. A non-admin calling `context_foldersCreateOne` must be refused — covered by the existing `apiWrites` guard; the test in Task 1 asserts the schema carries the flag (the guard's own test covers enforcement).

---

### Task 1: The `context_folders` core table

**Files:**
- Modify: `src/postgres/core-schema.ts` (add the schema next to `context_presets`)
- Test: `src/postgres/core-schema.test.ts` (extend)

**Interfaces:**
- Produces: the table definition exported through `coreSchemas.get()` like the others (check how `core-schema.test.ts` reaches a table by name and follow it).

- [ ] **Step 1: Write the failing test** — find `context_folders` in `coreSchemas.get()` (same lookup the existing tests use): `name.plural === "context_folders"`, `name.singular === "context_folder"`, `apiWrites === "super_admin"`, `RBAC` falsy, `fields.map(f => f.name)` starts with `["name", "description", "icon", "sort_order", "context_ids"]`, `name` field `required === true` and `index === true`, `context_ids` field `type === "json"` and `required === true`, `sort_order` `default === 0`.
- [ ] **Step 2: Run to verify it fails** — `npm test -- src/postgres/core-schema` → FAIL
- [ ] **Step 3: Add the schema**
- [ ] **Step 4: Run to verify it passes**; also run `npm test -- api-writes-guard` and, if that test enumerates guarded tables, add `context_folders` to it (then it must still pass).
- [ ] **Step 5: Commit** — `git commit -m "feat: context_folders core table for knowledge-base folders"`
