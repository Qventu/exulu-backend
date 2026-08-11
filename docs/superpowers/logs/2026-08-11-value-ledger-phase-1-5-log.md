# SDD ledger — plan: /Users/daniel.claessen/Desktop/Projects/exulu/backend/docs/superpowers/plans/2026-08-11-value-ledger-phase-1-5.md
Phase 1.5 execution started. NOTE: plan Task 1 Step 8 says Task 1's summarise() references
adoption.projects from Task 2, so TASK 2 IS EXECUTED FIRST to avoid a transient type error.
Local validation stack still up: ll-probe :55441 (production restore), test pg :55432
(+ value_ledger db with 2026-06 and 2026-07 already frozen — real delta baseline available),
mailpit :1025/:8025, app buildable.
Task 2: implementer DONE (6919662); review: spec compliant, 0 Critical/Important.
Task 2: controller validated on production — 35 projects, shares sum to 100.0%, labels
  clean. 33 of 35 fall below min-N, which vindicates the decision NOT to roll projects into
  "Other": the team-style rule would have left a 2-row panel plus a giant Other blob.
Task 2: complete (commits 865702e..6919662). 131 tests.
Task 1: implementer DONE (044db6a); controller found a CRITICAL before review by testing
  against the real value_ledger DB: summarise() crashed (TypeError: rows is not iterable) on
  snapshots frozen under the OLD schema, because adoption.projects is undefined there. Crash
  occurs during build, so no report would go out — every month — until old rows were deleted.
  This is exactly the readSnapshot cast risk parked by the Phase 1 final review, materialising
  on the first breaking change to Snapshot.
Task 1: fix round 1/5 (5f4d014) — summarise hardened on all three arrays, loadPriorContext
  warns-and-skips a bad month, schemaVersion added. Verified live: previous.month 2026-06,
  EUR 1581.04 (= $1718.52 x 0.92, matching an independently derived figure).
Task 1: review approved; 1 Important — month-1 was read twice, so a transient failure on the
  second read could yield previous:null while the month still appeared in history.
Task 1: fix round 2/5 (11bf4cf) — single read per month, pinned by a call-count test.
Task 1: complete (commits 6919662..11bf4cf). 143 tests.
Tasks 3+4 combined into one dispatch: both are small standalone pure modules (delta labels,
  chart helpers) with no interaction. One review covers both.
Tasks 3+4: implementer DONE (f5281da, a44f602); controller verified with real figures —
  deltaLabel(4221.88, 1718.52) = "▲ 145.7%", the true July-vs-June movement; no ASCII hyphen;
  Evidence-Lock passes with bars+deltas; widths invisible to the lock; NaN clamps.
Tasks 3+4: review approved, 2 Important. NaN reached the email as "▼ NaN%" — and crucially
  Evidence-Lock does NOT catch it, because "NaN" has no digits, so the build succeeds and the
  garbage ships. Also barRow's escaping contract was undocumented, the same defect class
  already fixed once in html.ts, right before Task 5 writes callers passing real project tags.
Tasks 3+4: fix round 1/5 (a7d8773) — non-finite guard returning DELTA_NONE, escaping contract
  documented on barRow and barTrack. 160 tests.
Tasks 3+4: complete (commits 11bf4cf..a7d8773).
Task 5: implementer DONE (a2106e0); production render found 3 defects the controller flagged
  and the review confirmed plus 3 more. Worst: "break-even ▲ 74.7%" beside "spend ▲ 145.7%"
  in a positively-framed block — break-even RISING is bad, so the arrow inverted the meaning
  of the report's central number. Also 5841.9% deltas off near-zero bases, and slice(0,12)
  silently dropping 23 of 35 projects in a report whose selling point is honesty.
Task 5: fix round 1/5 (c8369df) — polarity words (arrow stays literal direction, a word
  carries interpretation), a money floor suppressing near-zero-base noise, truncation
  disclosed with the spend share, retention table removed leaving bars, trend dedup, entity
  decode order. Re-review: all 6 addressed, no new breakage.
Task 5: controller re-rendered and reconciled every figure. NOTE the implementer's report
  claimed "break-even ▲ 89.9%"; the stored snapshots give 21.17 -> 36.99 = 74.7%, which is
  what the render actually produces. Report numbers were wrong, code was right.
Task 5: complete (commits a7d8773..c8369df). 189 tests.
Task 6: implementer DONE (3338ed1); controller validated on production — CSV 85 -> 196 rows,
  all 35 projects present (top-12 truncation is display-only, the export stays complete),
  suppressed headcounts emit a bare trailing comma not "null"/0, no NaN. 194 tests.
Task 6: review folded into the final whole-phase review (one file, five tests, already
  production-validated) — a proportionate controller call, recorded here rather than skipped.
FINAL WHOLE-PHASE REVIEW: 0 Critical. Merge recommendation READY. Importants are
  non-blocking: the projects SQL uses correlated subqueries rather than LATERAL and will
  matter at ~10x volume; the trend chart plots spend but not activePeople though the data is
  already stored and exported; barRow's escaping doc names its caller rather than the
  invariant. Minors logged for the next touching task.
DELIVERED: fresh report emailed through the real SMTP path (Mailpit) at 22:40. Local July
  snapshot was deleted first to force a resend — a test-database action only, and that row
  had been frozen under the pre-1.5 schema anyway.
STATE: Phase 1.5 COMPLETE. 194 tests, tsc clean. Repo main, 6 new commits, NO REMOTE.
  Still open: Phase 2 (dashboard), Phase 3 (prompt classification — needs the sample
  re-restore first, since proxy_server_request was filtered out of the local restore).
