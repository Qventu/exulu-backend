# 03 — LiteLLM proxy integration

**Spec:** `docs/superpowers/specs/2026-05-23-litellm-proxy-integration-design.md`
**Slot:** Third — big platform capability, takes a moment to land so we slot it after the immediate visual wins.

## Hook
**Bring your own model gateway.** Flip `EXULU_USE_LITELLM=true` and Exulu boots LiteLLM as a sidecar, routes every model call through it, and treats your `config.yaml` as the single source of truth for the model catalog.

## Surface area
Backend / infra feature. The demo can't be "watch the proxy run" — it has to land the *user-facing impact*: the dev edits one yaml file, the model catalog updates everywhere.

## Code snippet
**Yes** — YAML. Pulled from `ee/python/.litellm/config.yaml.example` (the starter config the spec ships). Show one env var line and a trimmed model_list. Languages: `bash` for env + `yaml` for config.

## Demo arc (1 slice, ~9s, 1920x1080 + 1080x1920)
Pattern: Recipe **D** (infra / hard-to-show). Code editor on the left, Exulu admin "Models" page on the right. Edit yaml → models page updates.

1. Hook fades in: **"One config. Every model."**
2. Cut to split view: left half = code editor with `config.yaml` open, right half = Exulu Models admin page (currently sparse).
3. Cursor in the editor. A new model block fades into the yaml (`vertex-flash` already there; add `claude-haiku`).
4. **Hold 600ms.**
5. On the right, the Models admin list refreshes — `claude-haiku` row appears at the bottom with its `upstream_model` value rendered (`anthropic/claude-haiku-4-5`). A read-only banner sits at the top of the page: *"LiteLLM is enabled — models are configured in config.yaml."*
6. **Hold 700ms.**
7. Payoff caption fades in across the bottom: **"Rate limits, budgets, 100+ providers — handled."**

### Pacing budget
- 0.0–0.4: hook fades in
- 0.4–1.8: hook holds (1.4s) — short sentence fragment
- 1.8–2.2: pivot to split view
- 2.2–3.5: yaml block fades into editor in stagger (key lines pop in)
- 3.5–4.1: **breath** (600ms)
- 4.1–5.5: Models row materializes on right side
- 5.5–6.2: **breath** (700ms)
- 6.2–6.6: payoff fades in
- 6.6–9.0: payoff holds (2.4s, last 600ms still)

## YAML snippet to render in the editor (and on the page)
```yaml
# ee/python/.litellm/config.yaml
general_settings:
  master_key: os.environ/LITELLM_MASTER_KEY

model_list:
  - model_name: vertex-flash
    litellm_params:
      model: vertex_ai/gemini-2.5-flash
      vertex_project: os.environ/GOOGLE_VERTEX_PROJECT
  - model_name: claude-haiku
    litellm_params:
      model: anthropic/claude-haiku-4-5
      api_key: os.environ/ANTHROPIC_API_KEY
```

## Page copy snippet block (separate from the video, lives in index.html)
Two short labeled blocks:

**Enable** (bash):
```bash
EXULU_USE_LITELLM=true
LITELLM_MASTER_KEY=sk-…
```

**Catalog** (yaml — same as above, trimmed).

## Visual brand notes
- Editor: dark theme, JetBrains Mono, syntax-highlight keys in `--primary`, strings in a muted accent.
- Models page: reconstruct from `frontend/app/(application)/models/...` shapes — light theme, table rows on `--card`, `--border` dividers.
- Banner on the Models page in LiteLLM mode: subtle `--accent` background, small icon (i), copy from the spec verbatim.
