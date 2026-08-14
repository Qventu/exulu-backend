# Repo-managed skills: a filesystem source for the Skills library

**Date:** 2026-08-14
**Status:** Approved design — ready for implementation planning
**Repos:** `exulu/backend` (skill provider layer, route/resolver merge) and `exulu/frontend` (read-only surfacing)
**Requested by:** AI.OPEN (`gitlab.interlutions.de/open-digital-experience-gmbh/odxexul`)

## Problem

Skills today have exactly one source: a row in the `skills` table plus a versioned
bundle in S3 at `skills/{skillId}/v{n}/`. The only way to get a skill into the
library is to upload a ZIP (or author it in the mini-IDE).

AI.OPEN asked for something different. Paraphrased from their request: they are
building a TYPO3 upgrade skill, it is iterated on constantly, and they want to
apply updates through a Git repo rather than re-uploading a ZIP or hand-copying
changes each time.

The skill they are building lives in a repo and is developed like code. The
library forces it through a manual, lossy transfer step on every change.

## Goals

- Let a deployment declare a directory of skills that are read directly from disk
  and appear in the Skills library alongside database skills.
- Keep Git as the source of truth for those skills: they are read-only everywhere
  in the product.
- Change nothing for deployments that do not opt in.

## Non-goals

- **Per-skill remote Git links.** No repo URL, ref, or credential stored against a
  skill; no cloning from the backend. Considered and rejected for v1 — see
  "Approaches considered".
- **Pushing anything back to Git.** The agent's end-of-run "learnings" are out of
  scope. They stay a session artifact the humans pick up and commit themselves.
- **Fork-to-editable-copy.** `skillsCopyOneById` against a folder skill would be a
  useful escape hatch but requires routing a filesystem source through the
  zip/extract path. Deferred; noted as an extension point.
- **RBAC for folder skills.** They are readable by everyone in the instance. No
  frontmatter-driven visibility in v1.
- **Versioning for folder skills.** One version, no history.

## Approaches considered

**A. Publish from CI to the existing registry API.** `POST /skills/registry/:name`
already accepts API keys (`src/validators/requests.ts:10-16`) and already handles
create-or-version-bump. A CI job could zip each skill directory and POST it, with
near-zero backend work. Rejected because it makes skills DB rows that drift from
the repo, requires an API key in CI, and needs explicit rules for rename and
deletion.

**B. Boot-time sync of a directory into DB + S3.** Scan on boot, hash, upsert a new
version when content changed. Rejected because it writes on every boot, needs a
cross-container lock (`server.js` and `worker.js` boot from the same image), and
still produces DB rows that can drift.

**C. Per-skill remote Git link.** Repo URL + ref + subdir + encrypted PAT on the
skill row, `isomorphic-git` pull in a BullMQ job. This is closest to the literal
request, but it is a genuine new subsystem: a new dependency, credential storage,
an SSRF guard that cannot simply allowlist `github.com` (their GitLab is
self-hosted), a background job, and new UI. Deferred as a possible phase 2.

**D (chosen). The directory is a read-only provider merged at query time.** No
rows, no S3, no writes, no boot sync. The folder "slides in" as a second source
behind the existing skill APIs. This mirrors the established
`ExuluAgent.source: "code" | "database"` pattern
(`types/models/agent.ts:7`, `src/exulu/app/index.ts:478-541`), where code-defined
agents are merged in at request time and never persisted.

The transport constraints that ruled out the alternatives are worth recording:
the skill sandbox has **no network access** (empty `allowedDomains` in the SRT
config, `ee/invoke-skills/create-sandbox.ts`), and `@exulu/backend` ships as an npm
package into each client's own Docker image, so **no `git` binary can be assumed**.
Any remote-git design has to run server-side in pure JS.

## Architecture

One module, two providers, one interface:

```ts
interface SkillProvider {
  list(): Promise<ResolvedSkill[]>
  getById(id: string): Promise<ResolvedSkill | null>
  getByName(name: string): Promise<ResolvedSkill | null>
  fileTree(skill: ResolvedSkill): Promise<SkillFileNode>
  readFile(skill: ResolvedSkill, relPath: string): Promise<Buffer>
  zip(skill: ResolvedSkill): Promise<Buffer>
  readonly writable: boolean
}
```

- **`DbSkillProvider`** — wraps today's behaviour (`skills` table + S3 prefix).
  `writable: true`.
- **`FolderSkillProvider`** — scans `config.skills.directory`. `writable: false`.
- **`skillRegistry`** — merges the two and becomes the single dependency for the 16
  skill REST routes, the skill GraphQL resolvers, and `getEnabledSkills`.

The point of the seam is that no endpoint learns about folders; each learns about
one registry. `downloadSkill()` in `create-sandbox.ts` becomes a `provider.zip()` /
`readFile()` call and stops knowing where bytes live.

## Semantics

### Identity and the `source` field

Folder skills get `id = "fs:<folder-name>"`. Stable across deploys, which matters
because agents persist their skill selection as `skills: [{ id, name }]` JSON
(`src/postgres/core-schema.ts:275-277`).

Every skill returned by the registry carries `source: "database" | "repository"`,
following the `ExuluAgent.source` precedent. Database skills report `"database"`;
folder skills report `"repository"`. This is a computed field on the GraphQL type,
not a column — the `skills` table is unchanged by this design.

**Sharp edge:** `skillById("fs:typo3-upgrade")` would reach a Postgres UUID cast and
throw. The registry must short-circuit `fs:`-prefixed ids before any SQL runs, on
every path that takes an id. This is the single most likely source of bugs in the
implementation and needs a dedicated test.

**Second sharp edge:** the id appears in URL paths — `/skills/:skillId/files` on the
REST side and the `/skills/[skillId]` Next.js dynamic route on the frontend. A colon
is legal in a path segment under RFC 3986, but the implementation must verify that
both Express routing and Next.js handle `fs:typo3-upgrade` (and its
percent-encoded form `fs%3Atypo3-upgrade`) without mangling. If either does, fall
back to `fs_` as the prefix.

### Access control

No row means no `rights_mode` and no `created_by`. Folder skills are readable by
every user in the instance and writable by nobody — the same default
`ExuluApp.agent()` applies to code-defined agents. RBAC editing is hidden in the UI
rather than disabled.

### Versioning

`current_version: 1`, `history: []`. Provenance is shown instead: a hash over the
folder's file contents, plus the deploy's Git SHA when the image exposes one via
env, rendered in the detail panel as "from repo, commit `abc1234`".

### Tags and counters

`src/skills/frontmatter.ts` extracts only `name` and `description` today. It gains
an optional `tags` list so folder skills can participate in the library's tag
filter; absent means an empty list. `getUniqueSkillTags` returns the union across
both sources.

`usage_count` and `favorite_count` are always `0` for folder skills — there is no
row to increment. Favouriting is therefore unavailable on them, and the UI hides
the control rather than showing one that silently does nothing.

### Name collisions

`name` is unique within the `skills` table, but the folder set is independent, so a
folder skill and a database skill can share a name.

**Decision: the folder wins.** The directory is a deliberate deploy artifact, so it
takes precedence. The database skill is hidden, never deleted or modified. A
warning is logged at scan time and the detail panel carries a badge explaining the
shadowing.

The accepted risk is that a folder skill can silently shadow a user-created skill
that had its own RBAC configuration. The log line plus the badge are the
mitigation; the data is untouched and reappears if the folder skill is removed.

### Pagination

`skillsPagination` is served by the generic SQL resolver every table shares
(`src/graphql/resolvers/index.ts:21-93`), which does `COUNT` + `LIMIT/OFFSET` and
cannot see the folder.

Skills need a resolver override that loads both sources, then filters, sorts, and
paginates **in JS**. This is correct only because skill counts are small (tens).
The implementation caps the load and logs a warning when the cap is hit, rather
than implying it scales to thousands of skills.

## Endpoint surface

**Merge (read):**
`GET /skills/registry`, `GET /skills/registry/:name`,
`GET /skills/registry/:name/download`, `GET /skills/:skillId/files`,
`GET /skills/:skillId/download`, `GET /skills/:skillId/file`.

**Refuse for `fs:` ids (write):**
`POST /skills/:skillId/sign`, `DELETE /skills/:skillId/file`,
`POST /skills/:skillId/version`, `POST /skills/:skillId/rename`, and
`POST /skills/registry/:name` when the name resolves to a folder skill.

All return **403** with a single shared message: *"This skill is managed in the
deployment repository."* One guard in the registry, not sixteen copies.

**Untouched:** `POST /skills/:skillId/init`, `/upload-sign`, `/init-from-upload`,
`GET /skills/agent/bootstrap`.

**`GET /skills/:skillId/diff`** returns 400 for folder skills — there is only ever
one version to compare.

**GraphQL:** `skillById`, `skillByIds`, `skillsPagination`, `skillOne`, and
`getUniqueSkillTags` merge both sources. `skillsCreateOne`, `skillsUpdateOne`,
`skillsUpdateOneById`, `skillsRemoveOne`, `skillsRemoveOneById`, and
`skillsCopyOneById` reject `fs:` ids.

`skillsStatistics` stays **database-only** and excludes folder skills. It aggregates
over counters that folder skills do not have, so including them would report zeroes
as though they were measurements.

Note that `GET /skills/:skillId/file` takes `?key=<s3key>` today. Folder skills have
no S3 key, so their file tree emits a relative path in the `key` field and the
provider resolves it against the skill directory with the same normalisation the
sandbox uses (`create-sandbox.ts:244-266`). Traversal attempts return 400.

## Runtime

`downloadSkill()` currently lists S3 objects into `{sessionDir}/skills/{skillName}/`.
For folder skills it **copies** files from disk into that same path.

**Copies, not symlinks.** A symlink would let a running skill write back into the
server's deploy directory and mutate itself, defeating the trust boundary the SRT
sandbox exists to enforce.

The skills directory must be present in **both** the `server.js` and `worker.js`
containers, because agents execute in both. Today they are built from the same
image, so a single `COPY` satisfies this — but it is a deployment requirement, not
a coincidence to rely on silently.

## Configuration

```ts
config: { skills: { directory: "./skills" } }   // resolved from process.cwd()
```

Absent config, or a configured directory that does not exist, means
`FolderSkillProvider` is never registered and behaviour is byte-identical to today.

Folder skills reuse the validation already in `src/skills/bundle-extractor.ts`:
`SKILL.md` at the folder root, 50 MB total, 500 entries, path safety. Frontmatter is
parsed with the existing `src/skills/frontmatter.ts`.

For AI.OPEN specifically this is `./skills` at the repo root. Their existing
`.agents/skills/` directory is for the repo's own Claude Code tooling and is
explicitly unrelated and untouched.

### Caching

The directory is scanned once at boot; parsed frontmatter and file trees are held in
memory, since the directory is immutable for the container's lifetime. File
*contents* are read lazily per request, so a volume-mounted development setup picks
up edits without a restart.

## Frontend

Smaller than it appears, because the read-only UI already exists. The editor threads
`canWrite` throughout: `file-tree.tsx` suppresses the kebab and context menus, and
`skill-editor.tsx` renders a read-only textarea with a "Read-only" badge.

- Add `source` to `SKILL_FIELDS_INDEX` (`app/(application)/skills/queries.ts:47-73`)
  and to the `Skill` type (`app/(application)/skills/types.ts`).
- Set `canWrite = source !== "repository"`.
- Detail panel: "Managed in repository" badge plus commit SHA; hide Delete; hide
  access editing; hide the favourite control.
- Skills list: a small badge on repo-sourced rows.
- `create-skill-dialog.tsx` is unchanged.

## Error handling

Boot-time problems degrade rather than crash:

| Condition | Behaviour |
|---|---|
| `config.skills.directory` absent | Info log; provider not registered |
| Directory configured but missing | Info log; provider not registered |
| Folder has no `SKILL.md` | Warn; skip that folder |
| Folder exceeds size/entry caps | Warn; skip that folder |
| Folder name collides with a DB skill | Warn; folder wins; badge in UI |

Request-time: an `fs:` id on a write route returns the shared 403; a traversal
attempt on `?key=` returns 400.

## Testing

**Unit — `FolderSkillProvider`:** scan, frontmatter parse, tree build, traversal
rejection, missing `SKILL.md`, size and entry caps.

**Unit — registry merge:** collision precedence, `fs:` ids short-circuiting before
any SQL, and filter/sort/pagination correctness across both sources.

**Integration:** write routes return 403 for `fs:` ids; read routes surface folder
skills; `getEnabledSkills` resolves an agent pinned to `fs:<slug>`; sandbox
hydration copies folder skill files into the session directory and does not
symlink.

**Regression — the release gate:** with no `config.skills.directory` configured, the
entire existing skills test suite passes unchanged. This feature ships in
`@exulu/backend` to every client, and for all but AI.OPEN it must be provably
invisible.

## What this does and does not solve for AI.OPEN

Solved: the TYPO3 skill lives in their repo, is edited with normal tooling and
review, and reaches the library through their existing deploy pipeline. No more ZIP
uploads, no hand-copying.

Not solved: a skill text change requires a deploy, and the agent's end-of-run
learnings still need a human to fold them back into the repo. Both were accepted
scope reductions. If the deploy latency turns out to bite in practice, approach C
(per-skill remote Git link with a "Sync now" button) becomes the informed phase 2,
and nothing in this design blocks it.
