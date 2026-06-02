# Teams

**Date:** 2026-06-02
**Status:** Implemented
**Scope:** Backend (`exulu/backend`) + Frontend (`exulu/frontend`)

## Problem

Users can be assigned a **role** (which controls permissions across agents/workflows/variables/users/api/evals), but there is no notion of organizational grouping. We need to attribute usage and cost to organizational units like "engineering", "hr", "marketing", and we want to share resources with a team the same way we share with roles.

## Goal

Add a first-class **team** concept that parallels roles:

- A team has a name and description (no permission fields — teams don't grant abilities).
- Each user can be assigned to at most one team.
- A super admin can manage teams through a `/teams` page modeled on `/roles`.
- RBAC gains a new `rights_mode: "teams"` so any record can be shared with one or more teams, just like it can be shared with one or more roles.

## Non-goals

- **No per-team permission fields.** Teams are organizational, not authorization. Permission grants stay on roles.
- **No nested teams / hierarchy.** Flat list.
- **No multi-team membership.** A user has exactly one team (or none), mirroring `user.role`.
- **No default seeded teams.** Super admin creates them on demand.
- **No sidebar entry.** Teams are reached via a "Manage teams" button on `/users`, mirroring how roles work today.
- **No cost-aggregation integration in this pass.** The `team` UUID is now available on the user record; downstream cost dashboards consume it later.

## Decisions

| Topic | Decision |
|---|---|
| Schema location | `ee/schemas.ts` — `teamsSchema` next to `rolesSchema` |
| Schema fields | `name` (text, required, indexed, unique), `description` (text) |
| User field | `team` uuid added to `usersSchema` in `src/postgres/core-schema.ts`, immediately after `role` |
| License gate | Registered in `coreSchemas.get()` under `license["rbac"]` (same gate as roles) |
| Migration | Standard `addMissingFields` path in `init-exulu-db.ts` (column-existence check); no separate migration script |
| RBAC table | `rbac_id` table gains a `team_id` uuid column; new `access_type: "Team"` |
| Auth hydration | `src/auth/auth.ts` resolves `user.team` UUID → full team record, mirroring `user.role` |
| GraphQL exposure | Auto-generated CRUD via existing schema codegen; no manual resolvers |
| New visibility mode | `rights_mode = "teams"` joins `private` / `users` / `roles` / `public` |
| Frontend route | `/teams` under `(application)` |
| Frontend nav | None — accessed via "Manage teams" button on `/users` (parallel to roles) |
| `RBACControl` signature | `onChange` gains a 4th `teams` argument; `initialTeams` added as an optional prop |

## Architecture

### Data model

```
users.team           uuid → teams.id (nullable)

teams (id, createdAt, updatedAt, name, description)

rbac (id, entity, access_type, target_resource_id,
      role_id, team_id, user_id, rights)
   ^ access_type now includes "Team", rows then carry team_id
```

### Read path — listing records shared with my team

`src/graphql/utilities/access-control.ts` adds a fourth `orWhere` branch alongside the existing `users` / `roles` branches:

```ts
if (user?.team) {
  this.orWhere(function () {
    this.where(`${prefix}rights_mode`, "teams").whereExists(function () {
      this.from("rbac")
        .whereRaw("rbac.target_resource_id = …id")
        .where("rbac.entity", table.name.singular)
        .where("rbac.access_type", "Team")
        .where("rbac.team_id", userTeamId);
    });
  });
}
```

### Read-one path

`src/utils/check-record-access.ts` gains a `byTeams` branch parallel to `byRoles`, returning the rights stored on the matching team entry.

### Write path

`src/graphql/mutations/index.ts` gains a third branch in `validateWriteAccess`: `rights_mode === "teams" && user.team` checks for a matching `rbac` row with `access_type: "Team"` and `team_id: user.team` granting `"write"`.

### Persisting RBAC writes

`ee/rbac-update.ts` (the helper called from create/update/delete resolvers) now treats `teams` symmetrically with `users` and `roles`:

- Diffs incoming `teams: [{ id, rights }]` against existing `rbac` rows with `access_type: "Team"`.
- Inserts missing, deletes obsolete.

### Reading RBAC back

`ee/rbac-resolver.ts` (the resolver that materializes an `RBAC` object on each record) gains a `teams` array alongside `users` and `roles`. Mode `"teams"` with an empty teams array degrades to `"private"`, matching how `"roles"` degrades.

### Frontend `RBACControl` component

`components/rbac.tsx`:

- New visibility option: `{ value: "teams", label: "Shared with Teams", icon: Building2 }`.
- New `selectedTeams` state + `GET_TEAMS` query.
- New "Share with teams" panel (checkbox list + selected list with per-team read/write select), an exact mirror of the roles panel.
- `onChange` now passes a 4th `teams` argument. Optional `initialTeams` prop. Existing call sites that read fewer arguments continue to compile (TS function parameter bivariance).

### Teams management page

`app/(application)/teams/page.tsx` is a near-copy of `app/(application)/roles/page.tsx`:

- Search input + Create button.
- Table rows (name with `Building2` icon, description, created/updated, edit/delete actions).
- `TeamForm` (name + textarea description) shared by create + edit dialogs.

No reserved-name carve-out — teams have no equivalent of the `admin`/`default` roles that need protection.

### Users page wiring

- New `TeamSelector` (analog of `RoleSelector`) on each user row, calling `UPDATE_USER_BY_ID` with the new `$team: String` variable.
- "Manage teams" button next to "Manage roles" in the `/users` data table.

### Type widening (frontend)

`ExuluRightsMode` becomes `"private" | "users" | "roles" | "teams" | "public"`. The inline literal unions in `types/models/{agent,project,item,workflow-template,eval-run,context}.ts` and the local types in `model-form`, `prompt-editor-modal`, `transcriptions`, `edit-style-dialog`, `save-workflow-modal`, `save-preset-modal`, `data-display`, `workflows/columns` were widened to include `"teams"`. Each `RBAC` shape gained an optional `teams?: Array<{ id, rights }>`.

## Migration path

No manual script. On next backend boot:

1. `init-exulu-db.ts` iterates the `schemas` array; the new `teamsSchema()` entry creates the `teams` table.
2. The same loop runs `addMissingFields(knex, "users", usersSchema().fields, …)` which adds the new `team` column when absent.
3. `addMissingFields` also picks up `team_id` on the `rbac` table from the updated `rbacSchema`.

All three changes are idempotent and gated by column / table existence checks.

## Open follow-ups

- **Cost attribution.** Wire `user.team` into usage/cost aggregation once those dashboards land.
- **Team in AddUserModal.** Setting a team at invite time was deferred — not yet on the invite form.
- **Bulk team-assign.** Could be useful when onboarding cohorts; not in scope here.
- **`super_admin` bypass for team-shared records.** Already covered by the existing super_admin bypass in `checkRecordAccess` and `applyAccessControl`.
