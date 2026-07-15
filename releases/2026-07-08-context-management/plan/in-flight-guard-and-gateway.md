# Prose section plan — Guards while the agent is working (no video)

## Sources of truth

- Spec: `docs/superpowers/specs/2026-07-07-context-window-management-design.md` §2
  (mid-response overflow) + §3 (surfaces without the chat UI)
- Backend: `src/exulu/context-guard.ts` (`contextGuard`, `composePrepareSteps`, `4c03c60`),
  gateway pre-check + guard composition in `src/exulu/openai-gateway.ts` (`1107826`),
  mid-stream error mapping `mapStreamErrorMessage` / `isProviderContextLengthError` in
  `src/exulu/context-budget.ts` (`6b221ad`)

## Why prose, not video

Both mechanisms are invisible when they work — that is the point. A prepareStep hook
rewriting messages mid-loop and an OpenAI-compatible 400 have no product UI to
reconstruct; the offload short already shows the visible half of the story.

## What shipped (raw material for 2–3 paragraphs)

- **In-flight microcompaction.** A `prepareStep` hook tracks estimated context during the
  agent's step loop. When a single turn's tool outputs push the estimate past the usable
  window, it collapses tool results in all but the two most recent tool messages down to
  a 400-character stub ending in "…[older tool output collapsed mid-response to fit the
  context window — the full output is in the session file named in the notice above, if
  one was saved]". Restorable by construction (the offload guard already stored the full
  artifacts) — no user interaction, no failed request, the turn just keeps going. It
  composes with the existing final-answer guard via `composePrepareSteps` (context guard
  first, each guard sees the previous one's rewritten messages).
- **The OpenAI-compatible gateway gets the same protection.** Requests to the gateway are
  pre-checked against the model's budget; oversized prompts get a proper OpenAI-style
  error (`type: "invalid_request_error"`, `code: "context_length_exceeded"`) instead of a
  provider crash, and the gateway's step loop runs the same in-flight guard. Continue.dev,
  Cowork, routines — every non-chat surface benefits without UI.
- **No raw provider errors anywhere.** Context-length failures that slip through to the
  provider (LiteLLM `ContextWindowExceededError`, "maximum context length", "prompt is too
  long", "token count exceeds", …) are pattern-matched in the stream error path and
  rewritten to the same structured `CONTEXT_COMPACTION_REQUIRED` code the chat UI already
  understands.

Benefit angle: the 80%/95% story covers conversations that grow *between* turns; this
section covers the turn that explodes *mid-flight* — the last uncovered way to hit a
context wall, now handled silently on every surface including headless ones.

## Code snippet decision

**Yes — JSON (the gateway pre-check error).** Real shape from
`src/exulu/openai-gateway.ts`; anyone pointing an OpenAI SDK at Exulu sees exactly this.

Label: "Gateway pre-check — OpenAI-compatible, no provider crash"

```json
HTTP/1.1 400

{
  "error": {
    "message": "This request is ~131,072 tokens, which exceeds the model's usable context window (102,400 tokens). Reduce the conversation history.",
    "type": "invalid_request_error",
    "code": "context_length_exceeded"
  }
}
```
