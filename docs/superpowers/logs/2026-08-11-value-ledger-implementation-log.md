# SDD ledger — plan: /Users/daniel.claessen/Desktop/Projects/exulu/backend/docs/superpowers/plans/2026-08-11-value-ledger-phase-0-1.md
Task 1: implementer DONE (commit ce5ec2f, new repo adoption-and-value-tracker, root commit on main)
Task 1: review returned 1 Critical, 1 Important, 2 Minor
Task 1: adjudication — Critical REFUTED empirically. Reviewer claimed the
  `tags @> '["__probe__"]' IS NOT NULL AND ...` predicate makes spend_with_user_tag
  return NULL/0. Tested on postgres:16: plan version and clean version both return
  10.00; (tags @> '...') yields false (not NULL) for non-null tags, so the predicate
  reduces to `tags IS NOT NULL`, already implied by the EXISTS. Downgraded to Minor.
  Also note: the predicate is plan-mandated (present in task-1-brief.md:108) — the
  implementer transcribed faithfully; the reviewer misattributed it as divergence.
Task 1: Important finding accepted — pool.connect() unguarded, so a connection failure
  writes an empty phase0-findings.md with the error only on stderr. Real, given the
  documented `> phase0-findings.md` usage.
Task 1: fix round 1/5 (4 addressed, 0 open — connect guard, sentinel removed, finally block, README note; commits ce5ec2f..0e257c8)
Task 1: complete (commits ce5ec2f..0e257c8, review clean)
Task 1: plan text corrected to match (sentinel predicate removed from the plan's SQL,
  implementation note added). Plan and code are now in sync.
NEXT: Task 1 Step 7 is a HUMAN GATE. Daniel runs the probe against production and returns
  phase0-findings.md. Tasks 2-15 are NOT started. Do not run the final whole-branch review
  or delete this workspace — 14 tasks remain.
Phase 0 EXECUTED 2026-08-11 against a production backup restored locally (filtered:
  prompt/response payloads discarded, 112,559 SpendLogs rows). Findings committed to
  docs/superpowers/specs/2026-08-11-value-ledger-phase0-findings.md
Phase 0 verdict: GATE PASSED — attribution coverage 100% (user/team/role). Phase 1 proceeds.
Phase 0 caught two would-be-fatal errors:
  (a) Exulu's x-litellm-spend-logs-metadata does NOT yield queryable metadata keys
      (0 of 112,559 rows have metadata->>'user_id'). The feasibility probe's recommended
      SQL would have returned nothing. Tags are the only attribution channel.
  (b) SpendLogs.messages is always empty despite prompt storage being ON; prompts live in
      proxy_server_request. Building against messages would have silently returned nothing.
Phase 0 plan changes required before Task 2:
  1. session_id is 100% populated (30,086 sessions) — drop the heuristic sessionization.
  2. LiteLLM_UserTable has 7 rows vs 52 active users; TeamTable/AgentsTable empty. Panel 4
     dormant-seat metric NOT computable under the hard boundary — reframe as
     "active this month vs any prior month". Labels come from *_name_* tags, not tables.
  3. status vocabulary confirmed exactly success|failure (7.5% failure).
OPEN DECISION (Daniel): 89.4% of spend is Claude Code, 2% Exulu agents. Proposal is to fold
  tool/team/project breakdown into Phase 1 and make Phase 3 classification optional.
Spec + plan RECONCILED to Phase 0 findings 2026-08-11 (audit workflow: 26 claimed defects,
  18 refuted on verification, 8 confirmed and applied).
  Fatal fixes: WastePanel roster-based dormancy removed (would have divided by 7 instead of
    52 and printed a wrong percentage); buildAdoption team mapping moved from the empty
    identity tables to tag co-occurrence.
  Additions: parseClientTool() for LiteLLM's auto-added `User-Agent: ` tags (separate from
    parseTag — they do NOT follow dimension_value shape); AdoptionPanel.clientTools;
    LiteLLMSource.userTeams()/clientTools() replacing provisionedUsers()/teams().
  New SQL validated against the live restore before being written into the plan.
  Two production behaviours discovered while validating and now encoded in the plan:
    - one user carries two team tags -> Task 8 collapses to one team deterministically,
      else per-team activePeople sums above headcount;
    - SpendLogs and DailyTagSpend differ by 0.3% (UTC boundary) -> SpendLogs is the single
      source for every reported number.
NEXT: Tasks 2-15 ready. Task 2 (scaffold) and Task 3 (own schema) are unaffected by the
  reconciliation and can start immediately.
Task 2: implementer DONE (63656b3); review: spec compliant, 2 Important + 3 Minor
Task 2: fix round 1/5 (5 addressed, 0 open — SMTP_PASS/USER/HOST trim-before-min,
  SMTP_FROM email(), HOURLY_RATE test pinned, REPORTING_CURRENCY regex, 6 regression
  tests; commits 63656b3..c8fcfa5)
Task 2: complete (commits 0e257c8..c8fcfa5, review clean)
Task 2: plan defect found by reviewer and corrected — the brief's VALID fixture had
  JOB_TOKEN "secret" (6 chars) against min(8), so the plan's own test would have failed.
Task 3: implementer DONE (9519bd9); review: spec compliant, 1 Important (plan-mandated)
Task 3: plan-mandated finding escalated to Daniel per skill rule — he chose to strengthen.
Task 3: fix round 1/5 (1 addressed, 0 open — complete-column-set assertions for both
  tables, PK check retained, new no-updatedAt G3 assertion; proven non-tautological by a
  deliberate finishedAt removal; commits 9519bd9..79b9262)
Task 3: complete (commits c8fcfa5..79b9262, review clean)
Task 4: implementer DONE (2c38de5); review: spec compliant, 0 Critical/Important
Task 4: minor (deferred): longest-prefix sort is defensive, not load-bearing for the
  current dimension set (none is a strict prefix of another) — guards future additions
Task 4: minor (deferred): parseClientTool trim() normalises double-space UA tags, untested
Task 4: minor (deferred): valuesForDimension has one test case only
Task 4: complete (commits 79b9262..2c38de5, review clean)
Task 4: note — implementer wrote its report into a stray .superpowers/ dir inside the app
  repo; recovered to the workspace and the dir removed. Commit itself was clean (2 files).
Task 5: implementer DONE (e0d01ab); review: spec ❌ on a missing tests/fixtures/litellm-rows.ts
Task 5: adjudicated — the file is a PLAN DEFECT, not an implementer omission. Grep proves it
  appears only in the Files list and the directory sketch; nothing imports it and no task
  specifies its contents. The fixtures actually used are seed-litellm.sql (Task 6) and
  snapshot.ts (Task 12), both specified and imported. Creating an unspecified, unimported
  file would be dead code. Removed from the plan instead; spec ❌ thereby resolved.
Task 5: minor (deferred): fake-source defaults tested for only 2 of 10 methods
Task 5: complete (commits 2c38de5..e0d01ab, review clean after plan correction)
Task 5→6 note: removed vestigial tests/fixtures/litellm-rows.ts from the plan (see above).
Task 6: implementer DONE_WITH_CONCERNS (e0a133d); review: spec compliant, 0 Critical/Important
Task 6: deviation adjudicated — implementer used the `onConnect` pool option instead of the
  brief's `pool.on("connect", ... void query)`. MEASURED both against live Postgres: BOTH pin
  read-only and reject writes, so the brief was not broken — but it emits a pg@8
  DeprecationWarning and the behaviour is removed in pg@9. Deviation accepted, plan updated
  to match the implementation.
Task 6: controller validated the 3 untested queries against the 112,559-row production
  restore: agentsLastSeen substring offset correct (clean UUIDs), modelSpend correct.
Task 6: FINDING — routine exclusion is a no-op in production: humanUserMonths yields 105
  (user,month) pairs with or without it, because **0 of 112,559 requests carry a
  routine_id_* tag** (vs 8,951 carrying agent_id_*). Consequence: Panel 3's automation
  metric will be zero in the first report. Spec annotated to render it as "no scheduled
  automation observed" rather than a bare 0. The exclusion itself stays — it is correct and
  will matter the moment a routine does run.
Task 6: minor (deferred): agentsLastSeen / modelSpend / humanUserMonths have no integration
  test (outside the brief's prescribed 7); controller validated them against production instead.
Task 6: minor (deferred): add a comment explaining IS DISTINCT FROM 'success' counts NULL.
Task 6: complete (commits e0d01ab..e0a133d, review clean)
Task 7: implementer DONE (2a609c7); review: spec compliant, 0 Critical/Important
Task 7: controller ran buildBar END-TO-END against the production restore: spendUsd 4221.88
  (matches a straight SQL SUM exactly), 45 active people, 27.74 hours, 37.0 break-even
  minutes, 100% coverage. Headline arithmetic confirmed on real data.
  Note 4221.88 (SpendLogs) vs 4210.29 (DailyTagSpend) — the documented 0.3% UTC-boundary
  gap, confirming SpendLogs is the single source as G1 requires.
Task 7: minor (deferred): no FX-rate assertion on attributionCoveragePct/unattributed
Task 7: minor (deferred): SENSITIVITY_MINUTES not exported for renderer reuse
Task 7: complete (commits e0a133d..2a609c7, review clean)
Task 8: implementer DONE (0d14b2d); controller validated against production: 45 active,
  median 6 days, 59.3% top-decile, team headcount sums to 45 (multi-team collapse works),
  no user-id leak. All match independently-derived SQL.
Task 8: BRIEF DEFECT found only by production validation — retention emitted 0% for months
  that had not elapsed (July report showed "2026-07 cohort M+1:0%", reading as total churn
  when August simply had not happened). True M+2 was ~47% per SQL. Plan corrected: points
  are now filtered to offsets whose target month <= the reporting month; a cohort with no
  elapsed months yields an empty points array.
Task 8: fix round 1/5 (1 addressed, 0 open; commits 0d14b2d..ef64922). Re-validated on
  production: July report -> 2026-06 M+1:84%, 2026-07 (no points); August report ->
  2026-06 M+1:84% M+2:47%, 2026-07 M+1:61%. The 47% matches the pre-fix SQL prediction.
Task 8: complete (commits 2a609c7..ef64922, review clean)
Task 9: implementer DONE (b7e24e2); review: spec compliant, 0 Critical
Task 9: controller validated on production: 62,758 requests, 7.76% failure, automation 0
  (correct — no routine tags exist); waste activeThisMonth 45, prior 32, lapsed 5,
  returning 18. Cross-check: 32-5=27 continued, 27+18=45, and that 27 independently equals
  Panel 2's 84% June->July retention via a different code path.
Task 9: minor/plan-mandated (deferred): the buildWaste test stubs humanUserDays by CALL
  ORDER rather than by argument. Reviewer confirms it does catch an order inversion today
  (both assertions fail), but it would not survive a refactor that adds a third call.
  No override needed — keeping the plan as written. Flagged for the final review.
Task 9: minor (deferred): abandonedBeforeDay equal-day boundary untested
Task 9: complete (commits ef64922..b7e24e2, review clean)
Task 10: implementer DONE (365f0a0); review: spec compliant, 0 Critical
Task 10: controller ran the FULL PIPELINE against production. Snapshot 2026-07:
  EUR 3884.13 / 45 people / 27.7h / break-even 37 min / coverage 100%;
  median 6 active days (monthly — the 13-month window bug is NOT reintroduced);
  retention 2026-06 n=32 M+1:84%, 2026-07 n=18 no elapsed months;
  62,758 req 7.76% failed, automation 0; lapsed 5 returning 18;
  frozen fx 0.92 set 2026-08-01; no user id anywhere. monthWindow('2026-12')->2027-01-01.
  Guard correctly rejects an unfinished month and passes July.
Task 10: parked — "guard ordering depends on caller discipline". Ruling: by design; the
  plan separates them so the guard runs BEFORE anything is built or frozen. Adding a second
  call inside buildSnapshot would duplicate it. *** TASK 14 REVIEW MUST VERIFY runMonthlyJob
  calls assertMonthComplete -> buildSnapshot -> freezeSnapshot -> sendReport in that order. ***
Task 10: parked — readSnapshot casts payload to Snapshot without validation. Ruling: accepted
  for an internal append-only store; revisit if Snapshot gains a breaking change. Flagged to
  the final review.
Task 10: minor (deferred): monthWindow test does not assert priorWindowFromIso
Task 10: minor (deferred): abandonedBeforeDay uses a fixed 30-day subtraction, which for a
  short month can land before the month starts (no agent then classifiable as abandoned)
Task 10: complete (commits b7e24e2..365f0a0, review clean)
STATE: Tasks 1-10 done. Remaining: 11 (Evidence-Lock), 12 (renderers), 13 (SMTP),
  14 (job + route), 15 (docs). Local restore kept at localhost:55441 for validation.
Task 11: implementer DONE (21a59b9); controller ran a 13-case adversarial probe.
Task 11: BRIEF DEFECT — the tokeniser regex ignored a leading minus. Reproduced BOTH
  directions against the code: pct(-5.0) registered "-5.0" but the tokeniser saw "5.0", so
  the lock threw on its own output (report unbuildable for any negative); and with "5.0"
  registered a smuggled "-5.0" passed undetected (mechanism defeated). Deltas are required
  by the spec, so negatives are certain. Plan + code fixed to /-?\d[\d,]*(?:\.\d+)?/g in
  BOTH raw() and extractNumericTokens — they must stay identical or hyphenated model names,
  ISO dates and UUIDs start failing.
Task 11: fix round 1/5 (1 addressed, 0 open; commits 21a59b9..34bef1a). Re-probed 8/8 pass.
Task 11: complete (commits 365f0a0..34bef1a, review clean). 81 tests.
Task 11: CONSTRAINT FOR TASK 12 — the HTML template must not use numeric HTML entities
  (&#160;, &#8364;). Their digits are unregistered and will trip the lock. Use literal chars.
Task 12: implementer DONE (3e5fae8); controller rendered a REAL report from production.
  Evidence-Lock passed on production data; no numeric entities; no user-id leak.
Task 12: 6 findings, all from rendering real data that fixtures (2 models, 1 cohort) could
  never surface: automation zero-wording; no HTML escaping (a team label of
  'Eng</td></tr>...' silently corrupted the table — NOT an Evidence-Lock bypass, since
  raw() authorises label digits by design); 42 model rows with 32 zeros and one empty name;
  blank retention row for not-yet-observable cohorts; currency code bypassing the registry;
  CSV formula injection.
Task 12: fix round 1/5 (6 addressed, 0 open; commits 3e5fae8..aeac840). Re-rendered on
  production: model rows 42->20, "No scheduled automation observed in this period.",
  "2026-07 18 Not yet observable", injection escaped with & escaped exactly once,
  Evidence-Lock deliberate-break still throws.
Task 12: complete (commits 34bef1a..aeac840, review clean). 104 tests.
Task 12: rendered artifacts kept at /tmp/litellm-restore/value-ledger-2026-07.{html,csv}
Task 13: implementer DONE (128df07); review: spec compliant, ZERO findings.
Task 13: complete (commits aeac840..128df07, review clean). 106 tests.
Task 14: implementer DONE (c17b407); review confirmed the REQUIRED ordering check from Task
  10: assertMonthComplete -> buildSnapshot -> freezeSnapshot -> early-return -> render ->
  sendReport, verified in code and by 3 tests. Auth precedes pool creation; both pools close
  in finally; previousMonth rolls back across the year boundary.
Task 14: fix round 1/5 (2 of 3 addressed; commits c17b407..7781a1f) — audit inserts wrapped,
  dead spy removed, ?month= validated to /^\d{4}-\d{2}$/ with a 400.
Task 14: fix round 2/5 (1 addressed, 0 open; commit e1808d8) — the round-1 audit-insert tests
  were VACUOUS: the route calls db.insert().values() at depth 2 but the mock threw at
  returning(), depth 4, so `await` on a plain object resolved and the swallow was never
  exercised. Mock corrected to throw at values().
Task 14: controller independently MUTATION-TESTED the fix: stripping both inner try/catch
  swallows makes exactly those 2 tests fail; restoring makes all 5 pass. Tree restored clean.
Task 14: complete (commits 128df07..e1808d8, review clean). 116 tests.
Task 15: implementer DONE (46c97ca); README + verification. 116 tests, tsc clean.
Task 15: complete (commits e1808d8..46c97ca)
FINAL WHOLE-BRANCH REVIEW: 0 Critical. Two must-fix items; everything else triaged to ship.
  (Dispatched on sonnet — opus hit a harness error, as it did earlier in the session.)
FINAL FIX WAVE (commit 2ed3277): out-of-range month now rejected at BOTH layers — the route
  returns 400 before opening any pool, and monthWindow throws. This was a real hazard:
  monthWindow("2026-13") silently produced January 2027 and ("2026-00") December 2025, so a
  cron typo would have frozen wrong-month data under an uncorrectable write-once key.
  Also documented the readSnapshot cast assumption. Zod deliberately out of scope.
  Controller verified independently: 13/00 throw, 07/12 still correct incl. Dec->Jan rollover.
FINAL SCOPED RE-REVIEW: all addressed, no scope creep, no new breakage.
STATE: Phase 0 + Phase 1 COMPLETE. 15 commits, 120 tests, tsc clean, tree clean.
  Repo: ~/Desktop/Projects/exulu/adoption-and-value-tracker (branch main, NO REMOTE yet).
  Not deleted: the local production restore (docker ll-probe :55441) and the 5.4GB dump at
  /tmp/litellm-restore/, plus the rendered sample report there.
  NOT DONE: Phase 2 (dashboard), Phase 3 (use-case classification).
