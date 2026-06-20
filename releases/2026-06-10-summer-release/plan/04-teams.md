# Feature 4 — Teams

**Spec:** docs/superpowers/specs/2026-06-02-teams-design.md (commit 7af6306)
**Surface:** Admin UI (/users team column, /teams page) + RBAC "Shared with Teams" mode

## Hook

"Group users into teams — then share agents, projects, and data team-wide."

## Demo arc (~9s, 1920×1080)

UI-reconstruction: the /users table slice (columns: User, Email, Role, Team) with
the TeamSelector combobox, toolbar with "Manage teams" outline button.

1. 0.0–1.6s — Hook caption; users-table card slides in (3 user rows, Team column showing "Select team...").
2. 1.6–3.6s — Cursor opens the team combobox on a row → popover with "Search teams..."
   and options Engineering / Marketing / HR (name + small description, real component anatomy).
3. 3.6–4.8s — Click **Engineering** → check icon, button now reads "Engineering". Hold ≥0.6s.
4. 4.8–6.6s — Quick second beat: a compact RBAC visibility chip row morphs to
   "Shared with Teams · Engineering (Read)" — showing the payoff of team-wide sharing.
5. 6.6–9.0s — Payoff caption: "One team per user. Share with teams like you share with roles." Hold ≥1.4s.

NOTE: beats 2–3 are one user action (pick a team); beat 4 is a passive state morph,
not a second interaction — within pacing rules.

## Code snippet

None — organizational/admin feature; CRUD is auto-generated GraphQL.

## Page copy beats

- Teams are organizational, not permissions: cost attribution and sharing, while roles keep governing abilities.
- New "Shared with Teams" visibility mode on every resource, next to roles sharing.
- Super admins manage teams from /users → "Manage teams", mirroring roles.
