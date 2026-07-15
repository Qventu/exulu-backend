# Feature plan — Memory that asks first (SHORT + prose)

## Sources of truth

- Backend: `src/templates/tools/memory-tool.ts` — commits `fa1e81b` (visibility
  gate + type persistence), `7a93145` (dynamic toolName in dialogue), `a826517`
  (enum normalization/validation), `a5913e0` (surroundingContext capture)
- Chat tool-chip UI (for reconstruction): `frontend/components/ai-elements/tool.tsx`
  (Tool/ToolHeader/Badge), wiring in
  `frontend/app/(application)/chat/components/message-column.tsx` (makeUntypedToolPart)
- Composer placeholder: en.json `chat.composer.placeholder` = "Ask me anything..."

## What shipped

Four memory-tool upgrades:

1. **Visibility dialogue (the demoable one).** `create_<context>_memory_item`
   now has a `visibility: "private" | "public"` field. If the agent calls the
   tool without it, nothing is written — the tool returns: *"Before saving this
   memory, ask the user whether it should be PRIVATE (visible only to them) or
   PUBLIC (shared with the team), then call `<toolName>` again with `visibility`
   set."* The saved item gets `rights_mode: "private" | "public"` — real RBAC,
   not a label.
2. **Type persistence** — a caller-supplied `type` is stored when the memory
   context declares a type field.
3. **Enum validation** — enum fields are constrained via `z.preprocess` +
   `z.enum` (lowercase auto-uppercased); non-canonical values are dropped at
   write time instead of persisting un-recallable garbage.
4. **Surrounding context** — a required `surroundingContext` field is folded
   into the stored description, so a memory carries what was going on when it
   was made.

## Hook

**"Memory that asks first"** — no memory is saved until you choose private or
public.

## Surface area

The interaction lives in chat (recipe A): agent question → user answer → tool
chip completes. Items 2–4 are prose-only on the page (schema/validation work,
not visual).

## Reconstruction cues (exact, from the shipped code)

- Chat column on `#FDFDFD`; assistant message plain text block; user message a
  right-aligned bubble.
- Assistant question (write verbatim in the demo): **"Should I save this as a
  PRIVATE memory (visible only to you) or PUBLIC (shared with the team)?"** —
  mirrors the tool's dialogue-gate copy.
- Composer: bordered input, placeholder `text-sm placeholder:text-muted-foreground`
  **"Ask me anything..."**; typed text `text-base md:text-sm`.
- Tool chip (from `tool.tsx`, verbatim structure): `rounded-md border` full-width;
  header `p-3 flex items-center gap-2` — `WrenchIcon` `size-4` muted →
  `text-sm font-medium` title **"Create memories memory item"** (capitalize; from
  tool id `create_memories_memory_item`) → secondary `Badge` `rounded-full text-xs
  gap-1.5` with green `CheckCircleIcon` `size-4` + **"Completed"** → `ChevronDownIcon`
  right.
- Assistant confirmation line under the chip: **"Saved as a private memory."**

## Demo arc — `memory-visibility.mp4`, 1920×1080, 9.5s, ONE action (send "Private")

| t (s) | What's on screen | Rule honored |
|---|---|---|
| 0.0–0.4 | Hook "Memory that asks first" fades in | entrance |
| 0.4–1.8 | Hook holds still (1.4s) | ≥1.4s 4-word floor |
| 1.8–2.4 | Crossfade to chat: assistant question bubble already present + composer | establish |
| 2.4–4.0 | Hold still — viewer reads the question (1.6s) | on-screen sentence read time |
| 4.0–4.8 | "Private" types into the composer, letter by letter | the action begins |
| 4.8–5.2 | Message sends: right-aligned user bubble "Private" appears, composer clears | the action lands |
| 5.2–5.8 | Hold still (600ms) | breath after action |
| 5.8–6.3 | Tool chip fades in: wrench · "Create memories memory item" · green "Completed" badge, then confirmation "Saved as a private memory." | the payoff state |
| 6.3–7.1 | Hold still (800ms) | breath after state change |
| 7.1–7.5 | Payoff "Nothing saved without asking." fades in | entrance |
| 7.5–9.5 | Payoff holds still (2.0s); final ~0.6s fully still | ≥1.4s floor + loop rest |

## Page prose (beyond the video)

Para 1: the dialogue gate — the agent literally cannot write a memory until the
user picks a visibility; the choice maps to `rights_mode`, the same RBAC field
that governs every other Exulu record. Para 2: quality-of-recall work — enum
values validated and normalized at the Zod boundary, surrounding context
captured with every memory so future retrieval knows *why* it exists, memory
type persisted when the context defines one.

## Code snippet — NOT EARNED

The memory tool is an internal agent tool (not exported via `src/index.ts`, no
REST route, no GraphQL operation). The dialogue copy in the video carries the
story; no code block.
