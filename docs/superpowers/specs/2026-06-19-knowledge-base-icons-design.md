# Knowledge base icons

**Date:** 2026-06-19
**Status:** Implemented (frontend); backend reuses existing collection
**Scope:** Frontend (`exulu/frontend`). No backend code changes — reuses the existing `platform_configurations` collection.

## Problem

Knowledge bases (`ExuluContext`) are listed in the `/data` library as a flat, text-only row list (status dot + name + description). With more than a handful of contexts the list is hard to scan — every row looks the same, so users can't recognize a knowledge base at a glance. Contexts are backend-defined and there is no frontend mutation to edit them, so there was no obvious place to attach lightweight presentation metadata.

## Goal

Let an admin give each knowledge base a recognizable, **emoji-style icon** shown in the library list, with a sensible default icon as a fallback when none is set. The icon is **selectable from a curated set** — never an upload — to keep the interaction one-click and the visuals on-brand.

The icon is shared platform-wide (everyone sees the same icon for a given context), set by admins, and read by all users.

## Non-goals

- **No new `Context` field / mutation.** Contexts stay backend-defined; we do not add `icon` to the `Context` schema or introduce a context-update mutation. Icons are stored out-of-band in the generic key-value store.
- **No image upload / custom icons.** Selection from a fixed curated set only.
- **No per-user icons.** The icon is shared org-wide, not a personal preference (contrast: `favourite_projects`, which is per-user).
- **No runtime icon CDN dependency.** The chosen glyph set is bundled into the frontend, not fetched from the Iconify API at runtime.
- **No new npm dependency.** No emoji-picker library; the glyph data is a generated TS module and the picker is a small custom Popover grid.
- **No icon on the context detail page / other surfaces.** This pass only touches the `/data` library list (L1). Other surfaces can adopt the shared `ContextIcon` later.

## Decisions

| Topic | Decision |
|---|---|
| Persistence | One shared row in the existing `platform_configurations` collection (same store as `theme_config` / `image_generation_style:*`) |
| Config key | `knowledge_context_icons` |
| Config value | JSON map `{ [contextId]: glyphName }` |
| Create-or-update | Mirror `useThemeConfig`: update by id if the row exists, else create once (guarded by a `createdIdRef` so a second save before refetch can't duplicate the row) |
| Icon set | Curated **50** glyphs from **Fluent Emoji Flat** (https://icones.js.org/collection/fluent-emoji-flat) |
| Glyph delivery | Fetched once from the Iconify batch API and **bundled** as a generated TS module (`fluent-emoji-data.ts`, ~62 KB) — no runtime network call |
| Default glyph | `books` (`DEFAULT_CONTEXT_ICON`) — used when a context has no icon or the stored name is unknown |
| Rendering | Inline `<svg>` with `dangerouslySetInnerHTML` of the bundled (trusted, build-time) glyph body |
| Edit gating | `super_admin` only (shared, platform-wide state). All authenticated users *read* the icons |
| Read permission | Relies on `platform_configurations` reads being allowed for all authenticated users (already true: the image-generation widget reads this collection client-side for regular users) |
| List row layout | Leading emoji tile (replaces the always-muted status dot as the leading visual); the failed-job health dot moves to a corner overlay on the tile when `KNOWLEDGE_CONTEXT_HEALTH_SUPPORTED` is on |
| Row navigation vs. picker | Stretched-link pattern: an absolutely-positioned `<Link>` covers the row behind a `pointer-events-none` content layer, so the picker button (`pointer-events-auto`) is not nested inside the anchor (invalid HTML) |
| i18n | All copy under the `knowledge.library` namespace in `messages/{en,de}.json` |

## Architecture

### Data flow

```
/data library renders
    └── useContextLibrary() → rows (GET_CONTEXTS)
    └── useContextIcons()   → icons map (GET_CONTEXT_ICONS, key "knowledge_context_icons")
          └── ContextLibrary passes icons[row.id] + canEdit(super_admin) + setIcon to each LibraryRow

Admin picks an icon (LibraryRow → ContextIconPicker)
    └── onSetIcon(contextId, glyphName | null)
          └── useContextIcons.setIcon merges the map and:
                if row exists → UPDATE_CONTEXT_ICONS(id, { config_value })
                else          → CREATE_CONTEXT_ICONS({ config_value })  (id captured in createdIdRef)
          └── refetch() → icons map updates → LibraryRow re-renders with the new glyph

Any user loads /data
    └── reads the same shared row → sees the admin-set glyph (or the default fallback)
```

### File map

**New files (frontend):**

| File | Purpose |
|---|---|
| `components/primitives/context-icon/fluent-emoji-data.ts` | Generated module: the 50 bundled glyphs (`body`/`width`/`height`), `DEFAULT_CONTEXT_ICON`, and the ordered `CONTEXT_ICON_NAMES` list. Regenerate via the Iconify batch API (see "Regenerating the icon set"). |
| `components/primitives/context-icon/context-icon.tsx` | `ContextIcon` — renders a bundled glyph as inline SVG; falls back to the default for unknown/unset names. |
| `components/primitives/context-icon/context-icon-picker.tsx` | `ContextIconPicker` — searchable Popover grid (6-col) + "reset to default". i18n-agnostic (labels passed in by the caller). |

**Modified files (frontend):**

| File | Change |
|---|---|
| `app/(application)/data/queries.ts` | Add `CONTEXT_ICONS_CONFIG_KEY` and `GET_CONTEXT_ICONS` / `CREATE_CONTEXT_ICONS` / `UPDATE_CONTEXT_ICONS` (distinct operation names so they don't collide with the monolith's `platform_configuration` documents). |
| `app/(application)/data/hooks.ts` | Add `useContextIcons()` — reads the shared map, exposes `setIcon(contextId, name \| null)` with the create-or-update + `createdIdRef` guard. |
| `app/(application)/data/components/library-row.tsx` | Lead each row with the emoji tile; admins get the `ContextIconPicker`, others a static tile. Stretched-link refactor; health dot moved to a tile-corner overlay. |
| `app/(application)/data/components/context-library.tsx` | Call `useContextIcons()`, read `super_admin` from `UserContext`, gate editing, toast on save failure, pass `icon`/`canEdit`/`onSetIcon` to each row, and update the loading skeleton to the new tile shape. |
| `messages/en.json`, `messages/de.json` | `knowledge.library.row.setIcon` + `knowledge.library.iconPicker.{title,searchPlaceholder,reset,noResults,saveError}`. |

### Reused backend surface (no changes)

The feature writes to the generic `platform_configurations` collection via the already-exposed GraphQL roots:

- `platform_configurationsPagination(filters: { config_key })` — read the row
- `platform_configurationsCreateOne(input: platform_configurationInput)` — first write
- `platform_configurationsUpdateOneById(id, input)` — subsequent writes

`config_value` is stored/returned as parsed JSON (same as `theme_config`). The row carries `config_key: "knowledge_context_icons"`, the `{ [contextId]: glyphName }` map, and a static `description`.

### Regenerating / extending the icon set

The glyph bodies are bundled at author time so there is no runtime CDN call:

```
curl "https://api.iconify.design/fluent-emoji-flat.json?icons=books,brain,rocket,..."
```

Each returned `{ body, width, height }` is written into `FLUENT_EMOJI_GLYPHS` in `fluent-emoji-data.ts`, and the name added to `CONTEXT_ICON_NAMES` (display order). The procedure is documented in the header comment of `context-icon.tsx`.

## Error handling

- **Unknown / unset glyph name** → `ContextIcon` falls back to `DEFAULT_CONTEXT_ICON`, so a row always renders an icon.
- **First write (no row yet)** → `CREATE_CONTEXT_ICONS`; the new id is captured in `createdIdRef` so a rapid second save updates rather than creating a duplicate row.
- **Save failure** → caught in `ContextLibrary.handleSetIcon`, surfaced via the existing `sonner` toast (`knowledge.library.iconPicker.saveError`); the optimistic merge is discarded on the next refetch.
- **Non-admin user** → no picker affordance is rendered; the tile is a static, non-interactive element.
- **Reset** → picker calls `onSelect(null)`, which deletes the context's key from the map and persists the smaller map (falls back to default on render).

## Testing

- **Manual:** as a super admin, open `/data`, click a row's icon tile, pick a glyph → the row updates after the save round-trip; reload → icon persists; open as a non-admin → icon is visible but not editable.
- **Manual (default):** a context with no stored icon shows `books`.
- **Manual (reset):** pick "Reset to default" → the context returns to the default glyph and its key is removed from the map.
- **Manual (search):** typing in the picker filters the 50 glyphs by humanized name; no-match shows the empty copy.
- **Typecheck/lint:** `npx tsc --noEmit` and `eslint` on the touched files pass.
- **UAT** (optional): `/uat-testing` against the `/data` library on the feature branch.

## Open questions

- **Edit audience.** Currently gated to `super_admin`. If regular users should also set icons, widen the gate to `elevated` (or `all`) — but confirm the backend permits `platform_configurations` writes for that role first; otherwise non-admins would hit a save error.
- **Read permission assumption.** Confirmed indirectly (the image-generation styles widget reads this collection for regular users). If a stricter policy is ever applied to `platform_configurations`, non-admins would silently fall back to default icons.

## Future work (not in this spec)

- Show the `ContextIcon` on the context detail page (L2) header and anywhere else contexts are listed (agent knowledge selectors, command palette).
- Promote `ContextIcon` / the bundled glyph set to a shared "pick an emoji for any entity" primitive (projects, skills, prompts).
- Optimistic icon update (render the chosen glyph immediately, before the save round-trip resolves).
- If presentation metadata on contexts grows beyond an icon (color, pinning), reconsider whether a first-class `Context` field is warranted instead of the key-value map.
