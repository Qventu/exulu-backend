# 02 — Follow-up suggestions

**Spec:** `docs/superpowers/specs/2026-05-24-followup-suggestions-design.md`
**Slot:** Second — visible to every chat user, low cognitive load.

## Hook
**Never stare at a blank input again.** Opt-in, per-agent: after every reply, up to three smart follow-ups appear above the textarea. Click to fill, edit if you like, send when ready.

## Surface area
UI feature with a backend route. The demo is the suggestions appearing under an assistant reply and the user clicking one.
- Frontend: `frontend/app/(application)/chat/[agent]/[session]/chat.tsx` — three outline buttons rendered inside `writeAccess` gate, above the textarea.
- Backend route: `POST /agents/suggestions/:agentId` returning `{ suggestions: string[] }`.
- Toggle: per-agent `suggestions_enabled` boolean in the agent edit form.

## Code snippet
**No.** The feature is a UI button row + an opt-in toggle — neither earns the spot. A snippet would feel padded.

## Demo arc (1 slice, ~8.5s, 1920x1080 + 1080x1920)

1. Chat input area at rest. Above it, a finishing assistant reply: a couple of paragraphs about (placeholder) a tax-residency question.
2. The reply lands ("…and that's the standard 183-day rule."). **Hold 700ms.**
3. Three pill-shaped outline buttons fade in **above the textarea**, in a left-aligned wrap:
   - "What about double-taxation treaties?"
   - "Does this rule apply to digital nomads?"
   - "Show me the source statute"
4. Cursor glides to the second button. It highlights on hover.
5. Click. The textarea below populates with that suggestion text. The other two buttons stay visible.
6. **Hold 600ms.** Then payoff caption fades in over the chat: **"Three nudges. Zero blank pages."**

### Pacing budget
- 0.0–0.4: hook fades in
- 0.4–1.6: hook holds (1.2s) — "Suggested follow-ups"
- 1.6–2.0: pivot to chat
- 2.0–2.6: assistant reply finishes (last line types in)
- 2.6–3.3: **breath** (700ms)
- 3.3–4.5: suggestion buttons fade in in stagger (~150ms apart)
- 4.5–5.5: caption above stays: "(opt-in per agent)"
- 5.5–6.1: cursor to second pill, hover highlight
- 6.1–6.3: click → textarea populates
- 6.3–6.9: **breath**
- 6.9–7.3: payoff fades in
- 7.3–8.5: payoff holds (1.2s, last ~600ms still)

## Visual brand notes
- Reuse chat surface from the session-files short — same assistant bubble style.
- Suggestion buttons: shadcn outline variant, `h-auto py-1.5 px-3 text-xs`, `whitespace-normal`. Light `--border`, hover background tint.
- Textarea: placeholder text "Reply…" until populated.
- Cursor: simulated.
