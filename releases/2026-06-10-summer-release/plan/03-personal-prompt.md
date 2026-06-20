# Feature 3 — Personal system prompt

**Spec:** docs/superpowers/specs/2026-05-29-personal-system-prompt-design.md (commit 8a559cc)
**Surface:** UI (/settings page) + injection in every chat (provider.ts)

## Hook

"Tell Exulu about yourself once. Every conversation remembers."

## Demo arc (~8s, 1920×1080)

UI-reconstruction: the real /settings card — heading "Settings", card titled
"Personal system prompt" with its actual description copy, 10-row textarea, Save button.

1. 0.0–1.6s — Hook caption; settings card slides up.
2. 1.6–4.6s — Typewriter into the textarea: "I'm a backend engineer working in
   TypeScript. Keep responses concise and skip preamble." (real placeholder copy as typed content).
3. 4.6–5.8s — Click **Save** → toast bottom-right: "Settings saved — Your personal
   system prompt has been updated." Hold ≥0.6s.
4. 5.8–8.0s — Payoff caption: "Applied to every chat, on top of any agent's instructions." Hold ≥1.4s.

## Code snippet

None — user-facing setting. (The injection point is internal provider code.)

## Page copy beats

- Role, language, tone, response length — preferences stated once, honored everywhere.
- Sits between the agent's instructions and the generic context in the system message, for every agent you talk to.
- Plain text, no limits, edit any time at /settings.
