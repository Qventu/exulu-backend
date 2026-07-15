# Prose section plan — Final-step hardening (no video)

Companion prose to `plan/step-budgets.md`. Pure infra reliability work — no UI, no
developer surface, no demo-able moment → prose only, no video, no snippet. Renders
as a short closing block inside the step-budgets feature section (or its own small
section at the end of the page).

## Sources of truth

- Spec: `docs/superpowers/specs/2026-07-08-step-budget-decoupling-design.md`
  (Problem #2 "Flatten-format mimicry", Design §4)
- Code: `src/exulu/resolve-max-steps.ts` — `flattenPart` / `flattenToolHistory`
  (prose rendering), `FINAL_ANSWER_INSTRUCTION` (explicit no-tool-syntax clause),
  `finalAnswerGuard` (three-layer guard doc comment)
- Commit: `a2f5e16`

## Benefit-language draft (2–3 paragraphs for the page)

**Paragraph 1 — the failure.** When an agent runs out of tool steps, Exulu forces a
final plain-text answer: tools are stripped, and the turn's tool history is
flattened into text so the model cannot imitate the structured parts. In
production we caught a model imitating the *flattening itself* — the history
rendered tool calls as `[called tool bash: {...}]`, and the model's "answer" was a
new line in exactly that bracket format instead of prose.

**Paragraph 2 — the fix.** The flattened history is now written as plain prose
("Earlier, the assistant ran the "bash" tool with input: …" / "The "bash" tool
returned: …") — there is no copyable call-syntax template left anywhere in the
final step's context. The final-step instruction is also explicit: answer in
normal prose, never output tool-call syntax, JSON commands, or bracketed
`[called tool ...]` lines; if the step limit was reached, say so honestly,
summarize progress, and name what remains.

**Paragraph 3 — why it matters (one sentence is enough).** Budget-exhausted turns
now reliably end in a real answer — or an honest "I hit the step limit, here's
where I got to" — never machine-shaped noise.

## Code snippet decision

**No snippet.** Internal prompt/flattening logic — not a surface developers call.
(Do not print `FINAL_ANSWER_INSTRUCTION` verbatim as a code block; quoting one
bracketed example inline in prose is enough.)

## Notes for the page builder

- Keep this block short and factual — it earns trust precisely by being
  understated. No metric invention; the verifiable claim is "no tool-syntax
  template remains in the final step's context".
- Good inline detail if space allows: the guard is three layers deep
  (`toolChoice: "none"` → `activeTools: []` → prose-flattened history + explicit
  instruction), each layer added after a real production failure of the previous
  one.
