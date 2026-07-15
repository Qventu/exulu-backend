# Connect Your Agent — release plan (2026-07-13)

Feature: connect any coding agent (Claude Code, OpenCode, 48+ clients) to the
Exulu skills library via a one-line installer, then list / install / publish
skills straight from the agent.

Spec: docs/superpowers/specs/2026-07-08-skill-library-agent-distribution-design.md
Surface: frontend /skills page ("Connect your agent" dialog), backend
/skills/agent/bootstrap + /skills/registry* REST endpoints, exulu helper CLI.

Hook: One line in your terminal, and every skill in your library is available
to every coding agent you use — list, install, update, publish, without
leaving the agent.

## Shorts (one slice each, 7–9s, 1920×1080, new website CI)

1. **connect-modal** (UI) — /skills page, click "Connect your agent" (Terminal
   icon, outline) → dialog: title "Connect your agent", body "Run this in your
   terminal:", command box `curl -fsSL https://exulu.your-company.com/api/skills/install.sh | sh`,
   details line about client selection + API key, footer "Close" / "Copy
   command" → click Copy command → "Copied" toast.
2. **install-script** (terminal, ink/void) — the curl one-liner runs: resolve
   backend via /api/config → paste API key (masked, chmod 600 config note) →
   multi-select clients (agents + claude pre-selected; windsurf, goose, roo …)
   → symlink question → "installed exulu-skills into .agents/skills/ and
   .claude/skills/".
3. **list-skills** (agent terminal, mirrors screenshot) — prompt "List exulu
   skills" → Skill(exulu-skills) → "Ran 1 shell command" → "Available Exulu
   skills:" table: Symfony Profiler Skill / grill-me / skill-scout /
   wargame-build with descriptions, tags, versions.
4. **install-skill** (agent terminal, mirrors screenshot) — prompt "install
   grill-me" → Ran 1 shell command → "Installed **grill-me** (v1) as a symlink
   into the agents and claude client dirs."
5. **publish-skill** (agent terminal) — prompt "Publish my local skill to the
   library" → exulu publish grill-me-v2 ./skills/grill-me → zip + POST
   /skills/registry/<name> → "Published grill-me v2" (version bump).

## Code snippets for the page (all real)

- bash: the curl one-liner (from the dialog, origin-baked)
- bash: `exulu list` / `exulu install <name>` / `exulu publish <name> <dir>`
  (helper commands, verbatim from the bootstrap SKILL.md)
- REST: `GET /skills/registry`, `GET /skills/registry/:name/download?version=latest`,
  `POST /skills/registry/:name` (zip body) — from src/exulu/routes.ts:3277-3484
