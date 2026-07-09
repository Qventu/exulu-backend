import { CLIENT_MANIFEST } from "./clients.ts";

export const BOOTSTRAP_CLIENTS_JSON = JSON.stringify(CLIENT_MANIFEST, null, 2);

export const BOOTSTRAP_SKILL_MD = `---
name: exulu-skills
description: Install, update, and publish skills from this Exulu instance's central skill library. Use when the user asks to install a skill, get the latest version of a skill, list available skills, or publish a skill to Exulu.
---

# Exulu Skills

Bridge between this machine's coding agents and the Exulu central skill library.

## Config

Read \`~/.config/exulu/skills.json\`:
\`\`\`json
{ "base_url": "https://ai.example.com", "backend": "https://backend.ai.example.com", "api_key": "sk_...", "clients": ["claude","agents"], "link_mode": "copy" }
\`\`\`
- \`base_url\` is the Exulu frontend URL the user gave. \`backend\` is the API root.
- If \`backend\` is missing but \`base_url\` is present, resolve it: \`GET <base_url>/api/config\` returns \`{ "backend": "..." }\`. Cache it back into the file.
- If no config exists, ask the user for their Exulu base URL and API key, resolve the backend, and run the installer: \`curl -fsSL <base_url>/api/skills/install.sh | sh\`.

Normalize \`base_url\`: strip trailing slashes; default scheme to https.

## Client targets & layout

The file \`references/clients.json\` maps client ids to skill directories (e.g. \`claude\` -> \`.claude/skills\`, \`agents\` -> \`.agents/skills\`, \`tabnine\` -> \`.tabnine/agent/skills\`). \`.agents/skills\` is the cross-agent standard and the canonical store for symlink mode.

When installing or downloading, use the remembered \`clients\` + \`link_mode\` from config. If asked to change targets, present the client list, pre-selecting directories that already exist under the project root or \`$HOME\`, defaulting to \`agents\` when none exist.

- copy mode: write the skill's real files into each selected client dir; each copy gets a \`.exulu-skill.json\` marker.
- symlink mode: write the real files once into \`.agents/skills/<name>/\` (with the marker), then symlink \`<other-client>/skills/<name>\` -> the canonical store. If a symlink can't be created, copy instead and warn.

## Auth

All registry calls authenticate with the Exulu API key sent in the \`exulu-api-key\` header (NOT \`Authorization: Bearer\` — that header is reserved for user JWTs and an API key sent there is rejected). Example: \`-H "exulu-api-key: <api_key>"\`.

## List / search

\`GET <backend>/skills/registry\` with header \`exulu-api-key: <api_key>\` -> \`{ skills: [{ name, description, tags, current_version, updated_at }] }\`. Filter/search client-side.

## Install ("install skill X")

1. \`GET <backend>/skills/registry/<name>/download\` (header \`exulu-api-key: <api_key>\`). It streams a \`.skill\` zip with a single \`<name>/\` wrapper folder.
2. Unzip and place per the layout above (copy or symlink into the selected clients; project dir unless the user asked for global \`$HOME\`).
3. Write \`.exulu-skill.json\` into the installed folder: \`{ "name": "<name>", "version": <current_version>, "source": "<backend>" }\`.

## Update ("get the latest version")

For each installed skill that has an \`.exulu-skill.json\`: read its \`version\`, fetch \`GET <backend>/skills/registry/<name>\`, compare with \`current_version\`, and re-download when newer. In symlink mode one re-download into \`.agents/skills\` updates every linked client. Never touch a skill folder that has no marker file.

## Publish ("publish skill X to Exulu")

1. Zip the local skill folder (exclude the \`.exulu-skill.json\` marker and OS junk; resolve any symlinks to real files first). Root the zip at a single \`<name>/\` folder.
2. \`POST <backend>/skills/registry/<name>\` with headers \`exulu-api-key: <api_key>\` and \`Content-Type: application/zip\`, raw zip as the body.
   - New name -> creates a private skill at v1.
   - Existing name you can write -> appends a new version.
   - \`403\` = the skill exists and you can see it but lack write access; \`409\` = the name is unavailable (taken by a skill you cannot access).
3. Before overwriting an existing skill, fetch \`GET <backend>/skills/registry/<name>\` and confirm with the user that a new version of *that* skill is intended. On success, refresh the marker's \`version\`.

## Other agents (OpenCode etc.)

Same flows; the target directory is whatever client id applies from \`references/clients.json\`.
`;
