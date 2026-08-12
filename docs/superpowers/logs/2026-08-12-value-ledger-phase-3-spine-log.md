# SDD ledger — plan: /Users/daniel.claessen/Desktop/Projects/exulu/backend/docs/superpowers/plans/2026-08-12-value-ledger-phase-3.md
Executing Tasks 1-3 only (the deterministic tool spine) per Daniel. Tasks 4-7 (the LLM
classifier) are deferred until the spine is validated against real data — Task 3 is that gate.
Structure facts in the plan came from sampling 300 real production rows; the sample is at
/tmp/litellm-restore/sample-rows.tsv (23MB, contains real prompt text — local only).
Task 1: implementer DONE (959ba7c); review approved, 0 Critical.
Task 1: controller validated against 300 REAL bodies — firstUserMessage 300/300 non-null,
  median 1,715 chars; toolUsesFromBody 4,105 in-body-deduped uses, 20 distinct names,
  matching an independent analysis. A string-only parser would have managed ~70%.
Task 1: Important (doc gap, reviewer calls it defensible): firstUserMessage returns the first
  user turn that YIELDS text, skipping one whose content is unusable — "first non-null-yielding"
  rather than strict "first". Folded into Task 2's dispatch as an addendum rather than a
  separate fix cycle, since the behaviour is right and only the documentation is missing.
Task 1: complete (commits 3338ed1..959ba7c). 202 tests.
Task 2: implementer DONE (c194693) — body-fetching spine, unit tests green.
Task 3 GATE FAILED the original design, which is exactly what it was for. Against real data
  toolUseBodies returned 4,000 bodies and ZERO tool uses: ORDER BY startTime DESC LIMIT n
  takes a contiguous recent slice and the tool-bearing rows sat outside it. Body fetching was
  also the wrong shape (10.8KB median x ~22% of rows).
  Diagnosis needed two steps: the restore holds {"x": 1} placeholders because the original
  restore filtered bodies out for disk, so 300 real bodies were patched back in by request_id
  before the gate could say anything at all.
Task 2: fix round 1/5 (e9f9f50) — extraction moved into SQL; DISTINCT (session_id, use_id)
  dedups in Postgres; no bodies transfer; no LIMIT. toolUsesFromBody removed with the old
  path. Integration test added proving the SQL dedup against a real Postgres.
Task 2/3: controller re-ran the gate — 435 triples (naive 4,105, 9.4x inflation avoided),
  968 ms, 20 tools, shares 100.0%, calls>=sessions everywhere, no user-id leak.
  June breakdown: Bash 34.9%, Edit 15.2%, Read 14.7%, playwright ~20%, figma 6.7%.
Plan annotated with a SUPERSEDED banner above Task 2 so a re-run does not rebuild the
  abandoned approach.
Task 2: fix round 2/5 (11b6e21) — NULL guards on part->>'id'/'name' (a malformed tool_use
  would otherwise have produced a blank-label panel row AND collapsed all malformed calls in
  a session into one, silently); jsonb_typeof guards now actually tested; a unit test renamed
  because it claimed an assurance it did not provide; no-LIMIT rationale documented.
Task 2: controller re-ran the gate — 435 triples UNCHANGED (so the null guard removed nothing
  real), zero null tools, zero empty-label rows, shares 100.0%. 207 tests, tsc clean.
TASKS 1-3 COMPLETE. The deterministic use-case signal, validated end to end on real data:
  code work 66.0% · browser/UI (playwright) 21.8% · design-to-code (figma) 9.7% · other 2.5%
NOT YET DONE: the spine is computed but NOT rendered — the report does not show it. That is
  plan Tasks 6-7. Tasks 4-5 (the LLM classifier) are also outstanding and gated on the
  tenant opt-in.
NOTE for any re-run: the local restore holds {"x": 1} placeholders for proxy_server_request.
  300 real bodies were patched back in by request_id from /tmp/litellm-restore/sample-rows.tsv
  and they cluster in 2026-06-17..24, so Phase 3 validation must target June, not July.
