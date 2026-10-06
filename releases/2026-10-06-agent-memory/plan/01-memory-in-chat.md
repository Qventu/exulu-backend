# 1 — Memory, in the open

**Spec:** `2026-09-29-agent-memory-redesign-design.md` (sub-project 1)

**Hook:** "Your agent remembers — and now you can see exactly what, and say no."

**Why it matters.** Memory already worked; it was just invisible. A text
question in chat, a generic approval card, a system-prompt injection nobody
saw. The redesign makes it visible, editable and governable: three agent tools
(remember, update, forget) whose **consent step is the save card itself** —
you approve the exact text that gets stored, not an abstract permission.

**Surface:** chat. The save card on a tool part, reusing the custom-card
pattern from tool credentials.

**Demo arc (~9s), one slice: the save card.**
| t | beat |
|---|---|
| 0.0–1.6 | Caption: "Tell it something once." Hold 1.4s after entrance. |
| 1.6–3.4 | User message types in — a preference worth keeping. |
| 3.4–4.6 | The save card appears beneath the reply: the memory text, editable. |
| 4.6–5.2 | **Breath.** Card still, nothing moves. |
| 5.2–6.6 | Cursor edits one word in the card — proving it is editable, not a yes/no. |
| 6.6–7.2 | Approve. Card settles into a saved state. |
| 7.2–9.0 | Caption: "Approved as written. Nothing is stored that you did not see." |

**Snippet:** none. This is a UI affordance; the earn-the-spot rule says no.
