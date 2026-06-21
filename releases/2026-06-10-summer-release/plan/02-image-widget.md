# Feature 2 — In-chat image generation widget

**Spec:** docs/superpowers/specs/2026-05-31-in-chat-image-generation-design.md (commit e9d20bd)
**Surface:** UI (chat widget) — `frontend/components/image-generation/image-generation-widget.tsx`

## Hook

"Generate, refine, and pick images — without leaving the chat."

## Demo arc (~9s, 1920×1080)

UI-reconstruction pattern. Rebuild the widget card faithfully:
container `border rounded-lg bg-card`, header `p-3 border-b bg-muted/30` with model
("gpt-image-1") + style selects, prompt textarea (pre-filled: "A friendly robot
assistant, watercolor style"), controls row (Size 1024×1024 / Quality high / Count 4),
full-width primary Generate button with Wand2 icon.

1. 0.0–1.6s — Hook caption over chat backdrop; widget card slides in.
2. 1.6–2.6s — Cursor clicks **Generate** → button swaps to spinner "Generating… (click to cancel)".
3. 2.6–4.4s — 4-image grid pops in (staggered scale-in), `grid grid-cols-4 gap-2`,
   square images (pre-made gradient/illustration placeholders).
4. 4.4–6.2s — Two images get the selected state: `border-2 border-primary` + check badge
   (`bg-primary rounded-full` top-right). Footer shows "2 image(s) selected" + **Use these** button. Hold ≥0.6s after.
5. 6.2–9.0s — Payoff caption: "Prompt, model, size, references — the user drives. The agent
   sees only what they pick." Hold ≥1.8s.

## Code snippet

None — pure UI feature (earn-the-spot rule).

## Page copy beats

- The agent opens the widget with just a prompt; the user takes over: model, count, size, quality, reference images, saved styles.
- Edit mode: attach reference images and the same widget becomes an image editor.
- Selection is explicit — only the images the user picks are sent back to the conversation.
