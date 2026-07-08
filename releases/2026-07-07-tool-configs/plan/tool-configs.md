# Feature plan — One-click tool configs from your project

## Source of truth

No dedicated spec in `docs/superpowers/specs/` — feature reconstructed from frontend code:

- `frontend/app/(application)/projects/hooks.ts` → `useProjectConfigDownloads` (lines 399–534)
- `frontend/app/(application)/projects/components/project-detail-view.tsx` → OverflowMenu items (lines 277–322)
- Labels from `frontend/messages/en.json`:
  - "Copy ID"
  - "Download Cowork config"
  - "Download Claude Code config"
  - "Download continue.dev config"
  - plus existing "Edit details" / "Delete project" below a divider

## What shipped

The project detail page's ⋯ (More actions) menu now lets you connect external
coding tools to the project's model gateway in one click:

1. **Copy ID** — copies the project ID to the clipboard (toast: "Copied to clipboard").
2. **Download Cowork config** — `cowork_config_<slug>.json`; gateway provider config
   with `inferenceGatewayBaseUrl: {backend}/litellm/{projectId}` and the user's token.
3. **Download Claude Code config** — `settings.json`; sets `ANTHROPIC_BASE_URL` to the
   project gateway, picks the best available Opus model from the live LiteLLM catalog,
   lists `availableModels`, wires the token via `apiKeyHelper`.
4. **Download continue.dev config** — `continue_config_<slug>.yaml`; OpenAI-compatible
   `apiBase: {backend}/litellm/{projectId}/v1` with chat/edit/apply roles.

All three configs route the tool's traffic through the project's own LiteLLM gateway —
so usage is attributed to the project, and users never hand-copy base URLs or tokens.

## Hook

**"Your project's models, inside your coding tools — one download away."**

## Surface area

UI feature (recipe A) + a developer-facing artifact (the generated config file).
Reconstruct the real project-detail header + overflow menu; show the download landing.

## Demo arc (one slice, ~9.5s, 1920×1080 + 1080×1920)

- Hook card: "Connect your coding tools" + sub "New in Projects" (entrance 0.4s, hold ≥1.4s)
- Crossfade to reconstructed project detail header (breadcrumb "Projects /", avatar,
  project name, visibility badge, star, ⋯ button, purple "New session" button).
  The ⋯ menu opens during establishment (no cursor needed for that) showing:
  Copy ID / Download Cowork config / Download Claude Code config /
  Download continue.dev config / ─ divider ─ / Edit details / Delete project.
- Cursor glides to "Download Claude Code config" → click (ONE user action).
- Menu closes; a `settings.json` file card slides up showing the real generated
  content (ANTHROPIC_BASE_URL → …/litellm/{projectId}, model: claude-opus-4-8).
  Hold ≥700ms breath.
- Payoff caption: "Cowork · Claude Code · continue.dev — ready in one click."
  Enter after breath, hold ≥1.8s, last ~600ms fully still (loop resting frame).

## Code snippet for the page

Show the actual generated Claude Code `settings.json` (from `hooks.ts` lines 480–497),
with a placeholder token. Label: "The generated settings.json". Also show the
continue.dev YAML head. Skip SDK/REST snippets — the surface is the downloaded file.

## Brand notes

Light theme, `#7033FF` primary (purple), Inter sans, JetBrains Mono code,
0.4rem radius, subtle shadows, border `#E7E7EE`. Menu = popover surface `#FCFCFC`
with 1px border, small radius, 13–14px text, lucide icons (Copy / Download / Pencil / Trash).
