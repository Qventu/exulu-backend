# Memory recall — follow-ups after the Newlift eval (2026-09-30)

**Status:** deferred by Daniel on 2026-09-30 ("write down the recall work for later and continue with the UI").
**Context:** `docs/superpowers/evals/2026-09-29-newlift-memory-recall.md` (first run) and
`docs/superpowers/evals/2026-09-30-newlift-memory-recall-rerun.md` (re-run with the cited-memory gate).
Raw data (gitignored): newlkiag `scripts/memory-eval/out/` — `judged-rerun.json`, `results-rerun.json`,
`cases.json`, `memory-config-before.json`, plus the throwaway diagnostics from the first run.

## 1. The four weak cited cases (Stage 2 sub-gate)

| Case | Score | Recall | Question | What to check |
| --- | --- | --- | --- | --- |
| 601efa06 | 0 | hit | "Bitte nochmal überlegen: Etage 02 und Geschwindigkeit …" | The model invented a combined RAW value (001A029A). Recall was fine; this is answer quality — compare the recalled memory text with the verified answer and see whether the memory or a document carried the correct value. |
| 8be51b0b | 25 | miss | "Brandfall vom ADM/EAZ soll beide Tür Seiten öffnen bei einer FST-2XT" | The Miscel-15 Bit-0 / Miscel-22.6 memory was not among the 25 recalled. Reproduce `recallMemories` for this question (user 51, limit 25), inspect hybrid ranks; candidate for the keyword-variant expansion (spec §3.1) or a title-boost. |
| c0978411 | 45 | hit | "Wie kann man die Notentriegelung reseten" | Memory recalled but the answer omitted the Morse-code method and the FST menu reset. Check whether the model cited the memory at all; if not, the injected block may be crowded out by the search tool's document chunks (topK 10) — consider ranking recalled memories first or a stronger instruction. |
| 9a35d1ac | 45 | hit | "was kann der Grund sein, wenn bei einem MDD6 Can der Türstand …" | Same pattern as c0978411. |

## 2. Eval tooling

- Make the "approval-paused" exclusion observation-based: a turn whose stream ended with a `tool-memory_*`
  (Newton: `tool-Remember`) part in state `approval-requested` is excluded from Stage 2, instead of the
  question regex (which missed 6 of 11 such turns in the re-run).
- Gate proposal for Daniel: replace "no cited case below 50" with "≤ 10 % of cited scorable cases below 50"
  (the re-run measured 9.8 %); keep mean ≥ 70 and Stage 1 ≥ 80 %.
- One replay error to reproduce: case `1a0356cd` — `500 fetch failed` from the run endpoint.
- Promote `out/compare-first-run.ts` (paired comparison) and the cited-recall helper into `scripts/memory-eval/`
  if the eval is run again.

## 3. Recall design candidates (only if misses persist)

- Keyword-variant expansion of the recall query (spec §3.1 escalation step), reusing
  `ee/agentic-retrieval/pipeline/text-utils.ts` `deriveKeywordVariants` in a second `tsvector` search
  merged before the cap.
- Feed the retrieval pipeline's rewritten question back into recall for agents with knowledge search on.
- Measure the token cost of limit 25 vs 10 on Newton (system-prompt size per turn) before making 25 the
  platform default; the workbench default stays 10.
- `generateSync` (REST run, sub-agents) only recalls on its `prompt`-string path, not for `inputMessages`
  (pre-existing; noted by the Task 6b implementer).

## 4. Product robustness notes surfaced by the eval

- `POST /agents/litellm/run/:instance` with an unknown `session` header returns a 500 Express HTML page
  (`checkRecordAccess` dereferences an undefined row) instead of a 400/404.
- The LiteLLM supervisor resolves its binary at `<packageRoot>/ee/python/.venv`, which does not exist in a
  git worktree; a fallback (env var or primary-checkout lookup) would remove the symlink workaround.

## 5. Housekeeping still owed (exulu-test / Newlift)

- Revoke `temporary_eval_key` (users.id 51, super-admin) in the admin UI.
- Optionally delete the 177 `[memory-eval]`-titled `agent_sessions` (and their messages) under user 51.
- `agents.memory_config` was added to `exulu-test` by the eval helper (nullable json, as in core-schema);
  Newton's row is set to `{"retrieval":{"enabled":true,"limit":25}}` on purpose.
