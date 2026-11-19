import { ACTIONS_FILE, ACTIONS_MAX_BYTES, MAX_ACTIONS } from "@EE/invoke-skills/skill-actions/schema";
import { ARTIFACTS_BLOCK_HEADER } from "@EE/invoke-skills/artifact-filter";
import { MAX_FILE_BYTES, MAX_FILES } from "./authoring-limits";

/** Pinned by authoring-guide.test.ts and backed by create-sandbox.skill-actions.test.ts. */
export const ACTIONS_EDIT_NO_EFFECT =
  "Editing, replacing or deleting `skills/<name>/" + ACTIONS_FILE + "` inside a running session has no effect on which actions exist or what they read.";

/** Pinned by authoring-guide.test.ts and backed by create-sandbox.readonly-skills(.sandbox).test.ts. */
export const SKILL_FOLDER_READ_ONLY =
  "The skill's own folder `skills/<name>/` is read-only in a session: nothing run in the sandbox can create, change, delete or rename files there, so a script writes its output to the working directory (the session directory). A skill changes only when a new version is saved; the session picks it up on the next turn or a reload of the skills.";

/** Pinned by authoring-guide.test.ts: the degraded-mode limit of SKILL_FOLDER_READ_ONLY. */
export const SKILL_FOLDER_READ_ONLY_DEGRADED =
  "On a host where the platform runs commands without a kernel sandbox (degraded mode), only the writeFile tool refuses that folder; shell commands and actions are not confined there.";

/**
 * What an agent reads (skill_guide) before it writes a skill for this platform.
 * Every statement below was checked against the code it describes
 * (authoring-guide.test.ts pins what it can); the numbers that
 * exist as constants are interpolated so they cannot drift. The first yaml
 * fence is parsed by authoring-guide.test.ts.
 */
export const SKILL_AUTHORING_GUIDE = `# Writing skills for this platform

A skill is a folder of files. The format is the standard Agent Skills format and stays portable; this guide covers only what differs here.

## 1. What stays standard
- \`SKILL.md\` starts with front matter that carries only \`name\` and \`description\`. Put no platform-specific keys there.
- Instructions, reference files and scripts are ordinary files in the folder.

## 2. Where scripts run
- In the session sandbox, in the same working directory as the chat's other files (the session directory). The skill's own files are in \`skills/<name>/\` below it, so address scripts as \`skills/<name>/scripts/x.py\`.
- ${SKILL_FOLDER_READ_ONLY} ${SKILL_FOLDER_READ_ONLY_DEGRADED}
- The sandbox is configured to allow no network access. Do not write scripts that download or call anything.
- Environment: the backend's declared secrets are removed from the environment and variables an administrator has explicitly granted to skills are added under their own name (skipped if the name is not a plain POSIX name or collides with an existing variable). The rest of the process environment passes through, so do not rely on any other variable being present or absent. Never hard-code credentials; tell the user which variable the skill expects.
- Interpreters: \`python3\` resolves to the platform's Python virtual environment when one is available; when npm is found, globally installed npm packages can be \`require()\`d from CommonJS scripts (\`NODE_PATH\` is set; ES \`import\` ignores it). Do not assume any particular package: check with a quick import or \`npm ls -g\`, and say in SKILL.md what the skill needs.

## 3. Files a script creates
- When the session has a user and file uploads are configured, new or changed files under the session directory (not under \`skills/\`) are uploaded, and the command output ends with an \`${ARTIFACTS_BLOCK_HEADER}\` block listing each as \`path: URL\`.
- Give the user exactly that URL. Never link a relative path or invent one.
- At most 50 files are listed per command. Dependency and cache directories (e.g. \`venv\`, \`node_modules\`, \`__pycache__\`, \`.cache\`, \`.git\`) are not listed; do not install packages into the session directory. Never write output into \`$EXULU_INPUTS_DIR\`: it is deleted after the run and never uploaded.

## 4. Platform data
- A script cannot fetch knowledge-base data itself (no network, no credentials). Never copy item data into a file by retyping it; it gets corrupted and truncated.
- A small lookup: the agent uses the read tools \`get_<context>_item\` and \`find_<context>_items\` directly and reasons over the result.
- Anything a script must process: declare an action (next section). The platform reads the data with the current user's rights and hands it to the script as files.

## 5. actions.yaml
\`${ACTIONS_FILE}\` at the skill root (at most ${ACTIONS_MAX_BYTES} bytes) declares what the agent may start. The agent starts one with the tool \`run_skill_action\` and the arguments \`skill\`, \`action\` and \`inputs\` (an object keyed by input name).

Keys: \`version: 1\` (required); \`actions\` (required, at most ${MAX_ACTIONS}); per action \`description\` (required), \`run\` (required, the shell command, run from the session directory; the caller can never change it), \`timeout_seconds\` (1-300, default 60), \`inputs\`. Action and input names match \`^[a-z][a-z0-9_]{0,39}$\`. Unknown keys are errors.

Input types:
- \`item\`: keys \`type\`, \`context\` (required, the exact context id; the tool-name segment in \`get_<context>_item\` is sanitised and shortened, so it can differ from the id), \`fields\` (optional list of field names to include), \`description\`. The caller passes an item id string or \`{ "external_id": "..." }\`. The script finds \`<name>.json\` with the item.
- \`items\`: keys \`type\`, \`context\`, \`fields\`, \`where\` (optional fixed filter in the syntax of \`find_<context>_items\`: \`{ field: { operator: value } }\` with the operators eq, ne, in, contains, gte, lte; unknown fields or operators are refused, and per field type: \`contains\` is refused on number, boolean, date and uuid fields, \`gte\` and \`lte\` on json and uuid fields (so not on \`id\`); eq, ne and in are always allowed. It is combined with the caller's filter; a field filtered here cannot be filtered again by the caller), \`description\`. The caller passes \`{ "where": {...}, "limit": n }\` or nothing (default limit 50, maximum 500). The script finds \`<name>.json\` as \`{ "items": [...], "limit": n, "truncated": true|false }\`. Archived items are included unless the fixed \`where\` excludes them with \`archived: { eq: false }\`.
- \`text\`: keys \`type\`, \`required\` (default true), \`description\`. The caller passes a string of at most 10000 characters. The text inputs that were given arrive together in \`args.json\` as an object by input name; the file is missing when none was given (an optional text input left out). Do not name an \`item\` or \`items\` input \`args\`: the action then cannot run.

About \`fields\`: an \`item\` input without it returns every readable field, including createdAt, rights_mode, archived and file fields; an \`items\` input returns only id, updatedAt, name, description, tags, external_id and the context's non-file fields (name any other field to get it). A \`file\` field arrives as its storage key, never its content, and the script cannot fetch it. Fields whose value is null are left out unless \`fields\` names them.

In the script: \`$EXULU_INPUTS_DIR\` is the directory holding those files (it exists only while the command runs); \`$EXULU_SKILL_DIR\` is the skill's own folder. Values from the caller never reach the shell command, only these files.

Which contexts an action may read: only those the agent could read with its own tools in the same turn. That is the knowledge bases whose read tools the agent has (the knowledge-base editor setup), the knowledge bases its context search covers (all except those switched off there), or otherwise, in a project, the knowledge bases of the project's items. The agent's memory is never readable. An action that names any other context is refused when started, with the message that the knowledge base is not connected to the agent.

When the file is read: the platform takes \`${ACTIONS_FILE}\` from the saved skill version, when that version is downloaded into the session (the first turn, the first turn after a new version is saved, or a reload of the skills). ${ACTIONS_EDIT_NO_EFFECT} Save a new version instead; it is picked up on the next turn. Scripts still run from the session copy in \`skills/<name>/\`.

Invalid file: a skill whose saved \`${ACTIONS_FILE}\` is invalid is ignored (its actions are not offered and the agent is shown the reason), and this authoring tool refuses to save one.

Example:

\`\`\`yaml
version: 1
actions:
  summarize_contract:
    description: Build a one-page summary of a contract and the recent amendments.
    run: python3 "$EXULU_SKILL_DIR/scripts/summarize.py"
    timeout_seconds: 120
    inputs:
      contract:
        type: item
        context: contracts
        fields: [name, content]
        description: The contract to summarize.
      amendments:
        type: items
        context: amendments
        where: { status: { eq: active }, archived: { eq: false } }
      focus:
        type: text
        required: false
        description: A topic to emphasise.
\`\`\`

\`\`\`python
import json, os
d = os.environ["EXULU_INPUTS_DIR"]
contract = json.load(open(os.path.join(d, "contract.json")))
amendments = json.load(open(os.path.join(d, "amendments.json")))["items"]
args_path = os.path.join(d, "args.json")
focus = json.load(open(args_path)).get("focus") if os.path.exists(args_path) else None
\`\`\`

## 6. Stay usable elsewhere
Describe in SKILL.md a manual path that works without actions (for example: read the item with the read tools and follow the same steps by hand). Other hosts ignore \`${ACTIONS_FILE}\`, and on this platform an agent may not have the action available (the agent has no sandbox or the file is invalid; an action whose knowledge base is not connected is listed but refused when called).

## 7. Limits
- At most ${MAX_FILES} files per call to the authoring tools, each at most ${MAX_FILE_BYTES / 1024} KB; the \`${ACTIONS_FILE}\` limit is ${ACTIONS_MAX_BYTES / 1024} KB.
- A file path is relative, at most 200 characters, with no \`..\`, empty segments or control characters.
`;
