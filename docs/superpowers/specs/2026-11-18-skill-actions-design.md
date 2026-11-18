# Skill actions — design

Date: 2026-11-18
Status: approved by Daniel 2026-11-18 ("sounds good, lets proceed"), with the skill-author addition in section 8
Repos: `backend` (develop); docs in `backend/mintlify-docs`; first consumer
`mevakipi`. No frontend change required.

## Intent and why

A skill's script runs in the session sandbox and cannot reach platform data.
Today the agent reads the data with a tool and the model re-types it into a
file for the script. At M&V the Excel export of one pitch (about 80 field
values) took 18 tool calls and several minutes for a sub-second script
(session `db5198dd-…`, 2026-11-18). Daniel expected about five seconds: run
a script, get a download link.

A custom tool in the consumer app would be fast, but it is code: one
deployment per change, not editable in the UI. Wanted is the speed of a tool
with the adaptability of a skill.

**Skill actions:** a skill declares, in a file of its own, named actions —
a command plus the platform data it needs. The agent starts an action with
one tool call. The platform reads the data with the user's rights, hands it
to the script as files, runs the script in the sandbox and returns the
result.

## Goals

- One tool call per action; no platform data passes through the model.
- Declared in the skill, editable like any other skill file (UI editor or
  `POST /skills/registry/:name`), effective from the next turn without a
  deployment.
- Data is read with exactly the rights the agent's read tools already have
  in that turn. A skill cannot widen what an agent can read.
- `SKILL.md` stays conformant to the Agent Skills standard; a skill with
  actions still works, slower, on a host that knows nothing about them.
- First consumer: `mv-pitch-export`, one call, target under 15 seconds end
  to end in the chat.

## Non-goals

- Writing platform data from an action. Writes stay with the write tools
  and their approvals.
- Network or API access from the sandbox. The "platform access" switch is
  parked in `2026-11-18-skill-platform-access-design.md`.
- A form-based editor for actions in the UI. The file is edited as text.
- Chaining actions, scheduling, or actions calling tools.
- LLM-based skill security analysis (separate future feature, Daniel).

## Anti-goals

- Caller-supplied values must never be interpolated into the shell command.
- An action must not read a context the agent could not read with its own
  tools in the same turn.
- A broken `actions.yaml` must not break the skill, the sandbox or the turn.
- Sessions and skills without actions behave exactly as today.

## Constraints (found in the code)

- Skills are downloaded per session into `<sessionDir>/skills/<name>/`
  (`ee/invoke-skills/create-sandbox.ts`); the sandbox handle is cached per
  session, skills are re-synced when their version changes.
- The outer agent gets `readFile` / `writeFile` / `bash` from the shared
  session sandbox in `src/templates/tools/convert-exulu-tools-to-ai-sdk-tools.ts`
  (only when the agent has `sandbox_enabled`). `bash` output is truncated
  there; files a command creates outside `skills/` are mirrored to S3 and
  announced in an `[exulu-artifacts]` block with download URLs.
- Generated read tools `get_<ctx>_item` / `find_<ctx>_items` live in
  `src/templates/tools/context-read-tools.ts` (`createContextReadTools`,
  `checkItemReadAccess`, `readableContextFields`, `FIND_MAX_LIMIT = 50`).
  They need no approval. Their `execute` returns prose strings
  (`Item: {…}`, `Found n item(s): […]`), errors included, and `clampLimit`
  hard-caps at 50. They exist for an agent only through the
  `knowledge_base_editor` entry with create or update granted
  (`context-write-tools.ts:543-558`) — there is no read-only grant today.
- The `bash` wrapper in `create-sandbox.ts` (~1150-1200) has a fixed env,
  no timeout, and runs the S3 mirroring itself right after the command
  (mtime snapshot before/after over the whole session dir; ignored
  segments in `ee/invoke-skills/artifact-filter.ts`). Context-budget
  truncation of stdout/stderr is applied one layer up, in
  `convert-exulu-tools-to-ai-sdk-tools.ts:498-520`.
- Only tools that go through the ExuluTool loop are audited
  (`convert-exulu-tools-to-ai-sdk-tools.ts:588-807`); the sandbox tools
  (`:476-529`) are not.
- The sandbox follows the session owner; tools run as the speaker.
- The Agent Skills standard defines only `name`, `description`, `license`,
  `compatibility`, `metadata`, `allowed-tools` in the `SKILL.md` front
  matter. Actions therefore go in a separate file.

## Approaches considered

1. **Platform access token + opened network** (parked spec). Free API
   access for scripts, but touches auth, the sandbox network and needs
   deny/allow lists. Daniel: too complex and error-prone as a first step.
2. **`save_to` parameter on the read tools.** Smallest build, but Daniel
   rejected the semantics: not logical on a read tool, easy for the agent to
   forget.
3. **A separate "load items into sandbox" tool.** Small, but two calls and
   the agent still has to remember it.
4. **Skill actions (chosen).** The skill declares data and command; one
   call; nothing to remember. More build than 2 and 3, but no auth, no
   network, no token.

Where the declaration lives: front matter of `SKILL.md` (breaks standard
conformance) vs. a separate `actions.yaml` (chosen, Daniel 2026-11-18).

## Design

### 1. `actions.yaml`

At the skill root, next to `SKILL.md`. Optional.

```yaml
version: 1
actions:
  export:
    description: Writes the pitch matrix of one tender as an Excel workbook.
    run: python3 "$EXULU_SKILL_DIR/scripts/export.py" --item "$EXULU_INPUTS_DIR/pitch.json"
    timeout_seconds: 60
    inputs:
      pitch:
        type: item
        context: mv_pitches
        fields: [felder, projektnummer, kunde, bearbeiter, kundenkategorie, projektname]
        description: Id of the tender.
```

- `version`: must be `1`.
- Action name and input name: `[a-z][a-z0-9_]{0,39}`.
- `description` (required): shown to the model.
- `run` (required): one shell command, executed in the same sandbox and
  with the same base env and cwd (session dir) as a `bash` tool call.
- `timeout_seconds`: optional, default 60, max 300. *(my call)*
- `inputs`: optional map. Three types in version 1 *(my call)*:
  - `item` — caller passes an id (or `{ external_id }`). `context`
    required, `fields` optional (default: the read tool's default set).
    Result file `<name>.json` = the item object.
  - `items` — caller passes `{ where?, limit? }` in the syntax of
    `find_<ctx>_items`. `context` required, `fields` optional, optional
    fixed `where` in the yaml that is AND-ed with the caller's. Limit
    default 50, max 500 (higher than the read tool's 50 because nothing
    reaches the model). Result file `<name>.json` is an envelope
    `{ "items": [...], "limit": n, "truncated": true|false }`. When more
    items match than the limit, `truncated` is true AND the tool result
    carries a warning line, so neither script nor model mistakes a partial
    list for a complete one. *(my call — the envelope is the v1 contract)*
  - `text` — caller passes a string (max 10,000 chars). Optional
    `required: false`. Collected in `args.json` as `{ "<name>": "<value>" }`.
- Unknown keys anywhere → the file is invalid (strict schema), so typos
  surface instead of being ignored.

### 2. How the script gets its data

Before the command runs the platform creates
`<sessionDir>/.exulu-inputs/<runId>/` and writes one file per input
(`<name>.json`, plus `args.json` when there are text inputs). The command
gets two extra env vars:

- `EXULU_INPUTS_DIR` — absolute path of that directory
- `EXULU_SKILL_DIR` — absolute path of the skill's folder

Nothing the caller supplied appears in the command line.

The inputs must never reach S3 or another speaker's download list, also not
through a concurrent `bash` call in the same session (its mirroring scans
the whole session dir). Therefore `.exulu-inputs` becomes an ignored
segment in `artifact-filter.ts` — excluded from mirroring and from restore
— and the run directory is additionally removed when the command ends
(also on timeout or error). *(my call)*

### 3. The tool

One generic tool, `run_skill_action`, present only when the agent has a
sandbox this turn AND at least one enabled skill has a valid `actions.yaml`.

```
run_skill_action({ skill: "mv-pitch-export", action: "export",
                   inputs: { pitch: "<item-id>" } })
```

- Its description is built per turn and lists every available action:
  skill, action, description, inputs with type and description. That is how
  the model learns what exists; `SKILL.md` can additionally say when to use
  which.
- No approval (reads plus a sandboxed script, same as `bash` and the read
  tools today).
- Unknown skill/action, missing or surplus input, wrong shape → an error
  result that names the valid options; nothing runs.
- Result: `{ exit_code, stdout, stderr }`, truncated with the same
  context-budget rules as `bash` (applied explicitly — that truncation
  lives in the outer wrapper), and the same `[exulu-artifacts]` block with
  download URLs for files the script created.
- It is registered as an ExuluTool in the turn's tool list, not spread in
  next to `bash`, so it passes the audit loop.
- Execution: the command runner inside the `bash` wrapper (sandbox wrap,
  spawn, mtime snapshots, mirroring) is extracted into a shared function
  that takes extra env vars and a timeout; `bash` calls it with neither.
  Env, timeout and cleanup are parameters of that runner, not text baked
  into the command string.

One generic tool rather than one generated tool per action *(my call)*:
the tool list stays stable when skills change, and it mirrors how skills
are discovered today. A generated tool per action would give stricter
schemas; it can be added later without changing `actions.yaml`.

### 4. Reading the inputs

- Each `item` / `items` input is resolved through the same logic the
  generated read tools use (access check, readable fields, filter
  conversion), as the speaking user. That logic is extracted from the
  tools into a shared function that returns data (not the tools' prose
  strings) and takes the limit cap as a parameter; the tools keep their
  cap of 50 and their output, the action uses 500. Not a parallel
  implementation.
- An input may only name a context the agent is connected to this turn:
  either as knowledge-base editor (which is what gives it the read tools)
  or as a context attached for retrieval. Otherwise the call is refused,
  naming the context. A context the agent has no connection to cannot be
  read through a skill. *(my proposal, put to Daniel 2026-11-18 and not
  objected to when he approved; the alternative was to require the editor
  grant, which today always includes a write grant)*
- An item the user may not read is reported exactly as the read tool
  reports it (indistinguishable from "does not exist"); nothing runs.
- A field the context does not expose → refused, naming the valid fields.
- All inputs are resolved before the command starts. Any failure → no run.

### 5. Loading and validating `actions.yaml`

- Read from `<sessionDir>/skills/<name>/actions.yaml` after the sandbox is
  created or re-synced, for the skills enabled this turn; parsed with a
  YAML parser and a strict zod schema.
- Invalid file → that skill contributes no actions; the reason is logged
  and listed at the end of the tool description as
  `skill "<name>": actions.yaml ignored — <first error>` so the agent can
  tell the user instead of guessing. The skill itself keeps working.
- Size cap for the file: 64 KB. Max 20 actions per skill. *(my call)*

### 6. Audit

As an ExuluTool, `run_skill_action` is recorded by the tool-call audit
with its raw input, like every tool: skill, action, item ids, `where`
filters and `text` values as the model passed them. The fetched items are
never logged. No redaction hook in this version. *(my call)*

### 7. Documentation

A page in `mintlify-docs` for skill authors: the file format, the three
input types, the env vars, a Python and a Node example, the rule about
enabled read tools, and the fallback pattern for hosts without actions.

### 8. Skill author tool: how skills on the IMP differ

Daniel, 2026-11-18: the IMP's skill authoring tool must document how
building skills on the IMP differs from other platforms. Today the agent
writes skills from general knowledge plus one prompt paragraph
(`SKILL_AUTHOR_PROMPT` in `src/templates/tools/skill-author-config.ts`);
nothing tells it about the sandbox, file links or actions.

- **One guide, one source.** A markdown text `SKILL_AUTHORING_GUIDE`
  (`src/skills/authoring-guide.ts`). Sections:
  1. What is standard and stays portable: `SKILL.md` with `name` and
     `description` only in the front matter; no IMP keys there.
  2. Where scripts run: the session sandbox; no network; no platform
     secrets (only variables an admin granted); Python venv and globally
     installed npm packages; cwd is the session dir; the skill's own files
     under `skills/<name>/`.
  3. Files a script creates come back as download URLs in an
     `[exulu-artifacts]` block; link exactly that URL.
  4. Platform data never comes from the script itself and must not be
     re-typed by the model: use the read tools for small lookups, an action
     for anything a script processes.
  5. `actions.yaml`: format, the three input types, the env vars, one
     complete example, the rule about connected contexts.
  6. Staying usable on other hosts: describe a manual path in `SKILL.md`
     for hosts without actions.
  7. Limits: files per skill and size per file of the author tool, action
     limits.
  Every statement in the guide must be checked against the code by the
  builder; a wrong guide is worse than none.
- **A fourth read tool `skill_guide`** in the skill-author set (present
  whenever the author tool is enabled): returns the guide. No input, no
  approval.
- **Prompt:** one sentence added to `SKILL_AUTHOR_PROMPT`: skills on this
  platform differ from other hosts; call `skill_guide` before writing or
  changing a skill that contains scripts or needs platform data.
- **Validation at save:** `skill_create` and `skill_update` run the same
  strict schema over an `actions.yaml` among the files and refuse with the
  parser's message instead of saving a file the platform would ignore.
- The docs page (section 7) is written from the same guide.
- Drift guard: a test asserts that every input type and every top-level
  key of the actions schema is named in the guide.

### 9. First consumer (mevakipi, after the platform release)

- `skills/mv-pitch-export/actions.yaml` as in section 1.
- `scripts/export.py` gains `--item <file>`: takes the raw item, picks
  `felder.<key>.wert`, applies the three column fallbacks, drops retired
  and formula keys itself, names the output file from project number and
  customer.
- `SKILL.md`: "call `run_skill_action` … then link the file and say the two
  fixed sentences"; the hand-built JSON path stays as documented fallback.
- The agent's `get_mv_pitches_item` is already enabled at M&V.

### 10. Skill folders are read-only in the session

Decision (Daniel, 2026-11-18): "lets make them read only, the only time
they should be updated is when loading a new version (skill authoring tool
can do that)". What an action reads is pinned to the saved version
(section 5); this pins what it runs. In a shared session a script changed
in one speaker's turn would otherwise run with the next speaker's rights.

- The per-session sandbox policy denies writes under `<sessionDir>/skills`
  (`denyWrite`, layered over the session-dir `allowWrite`). `skills/` is
  created before the first command, because the runtime resolves a deny
  path only when it exists.
- The `writeFile` tool refuses a path that really lands under `skills/`
  (`..`, links and dangling links resolved, `safe-fs.ts` `landsInside`)
  before touching disk, in sandboxed and in degraded mode alike.
- The platform keeps writing the folder from the backend process
  (download, version re-sync, reload, removal), outside the sandbox.
- Degraded mode (no user namespaces, direct exec): nothing confines
  `bash` or an action there, so they can still change the folder. Stated
  in code, guide and docs; `EXULU_REQUIRE_SANDBOX=1` is the way out.

Verified 2026-11-19 with the real runtime (0.0.49): macOS seatbelt on the
dev machine (jest test `create-sandbox.readonly-skills.sandbox.test.ts`,
which fails with the deny removed), and Linux bwrap in the shipped
backend image run as uid 1000 with `seccomp=unconfined` and
`apparmor=unconfined`: write, append, create, delete, rename of a file,
of a skill folder and of `skills/` itself, writes through symlinks, hard
links, chmod and touch all fail; session-dir writes and running a Python
script that imports a module next to it work (`__pycache__` is skipped).
Not covered: when the backend runs as uid 0 with the capabilities to
sandbox (e.g. a privileged container), bwrap leaves the command its
capabilities and it can `umount` or remount any of the sandbox's mounts,
this one and the read-only root alike: that is a limit of the whole
sandbox, not of this rule.

### 11. Who may read and write a skill

Decision (Daniel, 2026-11-18): asked whether (a) public skills being
writable by every signed-in user and (b) skill read routes without an
access check should be fixed in this branch, he answered "Yes": both, here,
with (a) scoped to skills only. An action's declaration and its scripts
come from the saved skill version, so whoever can write that version
controls what the action reads and runs for every user of every agent with
the skill.

- Read routes. `GET /skills/:skillId/files`, `/download`, `/file` and
  `/diff` call `ensureSkillRead` (`canAccessSkill(..., "read")`) after the
  row load and before any S3 call or presigned URL. A caller who may not
  read the skill gets the same 404 "Skill not found." an unknown id gets,
  as the GraphQL skill queries (filtered, so `null`) and `skill_read`
  ("No skill … that you can read.") do. `POST /skills/:skillId/upload-sign`
  is the first step of replacing a skill's content and calls
  `ensureSkillWrite`; the create dialog runs `skillsCreateOne` first, so the
  creator passes.
- Write. For skills, "public" grants read and use, not write. A public
  skill is writable by its creator, a super admin, an admin-mode API key
  and anyone with an explicit RBAC write grant (user, role, team) —
  `canWritePublicSkill` in `src/skills/skill-access.ts`, which
  `canAccessSkill(..., "write")` applies before `checkRecordAccess`. That
  covers the REST write routes (`ensureSkillWrite`), the registry publish
  route and `skill_update`; the generic GraphQL write guard calls the same
  function for the `skills` table only. `checkRecordAccess` and every other
  record type keep "public satisfies any right". Read access, `rights_mode`
  values and RBAC rows are unchanged; no migration.

## Testing

- Schema: valid file; each invalid shape (unknown key, bad name, wrong
  version, unknown type, too many actions, oversized file).
- Tool: unknown skill/action; missing/surplus/wrongly shaped inputs; a
  context without the enabled read tool; an unreadable item; a text input
  containing quotes, `$()`, backticks and newlines arrives byte-identical
  in `args.json` and nowhere in the command line.
- Run: inputs dir exists during the run and is gone afterwards (also after
  a timeout); a `bash` call running concurrently in the same session does
  not mirror it; it is not restored on a cold start; timeout kills the
  command and reports it; a created file comes back with a download URL.
- Items: over-limit result sets `truncated` and the warning line.
- `bash` behaves exactly as before the runner extraction (existing tests).
- Skill author: `skill_guide` returns the guide; an invalid `actions.yaml`
  in `skill_create` / `skill_update` is refused and nothing is saved; the
  drift guard.
- Regression: an agent whose skills have no `actions.yaml` gets no new
  tool; existing sandbox tests untouched; backend typecheck stays at
  exactly 8 errors with the same identities.
- Manual on a Linux instance: the M&V export end to end from the artifact
  button.

## Left to the builder

- Module layout (suggested: `ee/invoke-skills/skill-actions/`).
- Exact wording of the tool description and error messages.
- YAML parser choice (prefer one already in the dependency tree).

## Possible follow-up (not in this design)

Agentless execution: an action is a defined unit with declared inputs, so
a button or an API call could run it without a chat turn. Daniel was told
2026-11-18 that this is not in scope here.

## Open risks

- Whoever can edit a skill can change what its action's command does with
  data the calling user can read. Same exposure as skill scripts today;
  the planned skill security analysis is the mitigation.
- In a shared session the inputs are read as the speaker and exist briefly
  in the owner's sandbox directory. They are deleted after the run.
