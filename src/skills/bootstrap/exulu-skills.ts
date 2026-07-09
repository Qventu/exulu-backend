import { CLIENT_MANIFEST } from "./clients.ts";
import { EXULU_SH_B64 } from "./exulu-sh.generated.ts";

export const BOOTSTRAP_CLIENTS_JSON = JSON.stringify(CLIENT_MANIFEST, null, 2);

/**
 * The `exulu` helper script shipped inside the bootstrap skill. The agent runs
 * it instead of hand-writing curl: the script reads the API token from
 * `~/.config/exulu/skills.json` (so the token never enters the model context)
 * and performs the deterministic multi-client copy/symlink fan-out. The
 * client-id → directory map is generated from CLIENT_MANIFEST so it never drifts.
 */
const DIR_FOR_CASES = CLIENT_MANIFEST.map(
  (c) => `    ${c.id}) printf '%s' '${c.dir}' ;;`,
).join("\n");

export const BOOTSTRAP_EXULU_SH = Buffer.from(EXULU_SH_B64, "base64")
  .toString("utf8")
  .replace("__DIR_FOR_CASES__", DIR_FOR_CASES);

export const BOOTSTRAP_SKILL_MD = `---
name: exulu-skills
description: Install, update, and publish skills from this Exulu instance's central skill library. Use when the user asks to install a skill, get the latest version of a skill, list available skills, or publish a skill to Exulu.
---

# Exulu Skills

Bridge to the Exulu central skill library. **All operations go through the
bundled helper script — do not hand-write curl or copy files yourself.** The
script reads the API token from config (keeping it out of this conversation) and
handles the multi-client copy/symlink fan-out deterministically.

## The helper

Run the script next to this file, \`scripts/exulu\`, with \`sh\` and the absolute
path of this skill's directory:

\`\`\`
sh "<this-skill-dir>/scripts/exulu" <command>
\`\`\`

Commands:
- \`list\` — skills you can access (JSON on stdout)
- \`get <name>\` — one skill's metadata (JSON)
- \`install <name>\` — install/refresh a skill into the user's agent clients
- \`update [<name>]\` — update every installed skill, or just \`<name>\`, to latest
- \`publish <name> <folder>\` — publish a local skill folder as \`<name>\`
- \`config\` — show resolved backend / scope / clients (prints no secrets)

The token, backend URL, target clients, copy-vs-symlink mode, and scope all come
from \`~/.config/exulu/skills.json\` (written by the installer). Never print the
\`api_key\` or read it into your reply — the script uses it internally.

## Requests → commands

- "list / search skills" → \`exulu list\`, then filter the JSON for the user.
- "install skill X" / "add the X skill" → \`exulu install X\`.
- "update / get the latest version [of X]" → \`exulu update [X]\`.
- "publish / upload this skill as X" → confirm the target name with the user; for
  an existing skill run \`exulu get X\` first and confirm a new version is intended;
  then \`exulu publish X <folder>\`.

## Not configured yet?

If \`exulu config\` reports it's not configured (or \`~/.config/exulu/skills.json\`
is missing), tell the user to run the installer — it sets everything up
interactively (base URL, API key, target clients, copy/symlink):

\`\`\`
curl -fsSL <base_url>/api/skills/install.sh | sh
\`\`\`

\`<base_url>\` is their Exulu frontend URL (e.g. https://ai.open.de). They can
create an API key at \`<base_url>/token\`.

## Errors

- install: \`403\` = no access to that skill; \`404\` = unknown name.
- publish: \`403\` = you can see it but lack write access; \`409\` = the name is
  taken by a skill you can't access.
`;
