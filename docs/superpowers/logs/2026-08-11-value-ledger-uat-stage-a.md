# Value Ledger — UAT Stage A results

**Date:** 2026-08-11
**Scope:** Stage A only — "does it run at all", executed by Claude. Stage B (does the report
say anything true and useful) is Daniel's and has not happened.

## Environment

| Piece | What was used |
|---|---|
| LiteLLM source | Restored production snapshot, 112,559 rows, docker `ll-probe` :55441 |
| App's own Postgres | Real database `value_ledger` on :55432, Drizzle migration applied |
| SMTP | Mailpit :1025, UI :8025 — real SMTP conversation, nothing leaves the machine |
| App | `next build` + `next start -p 3111` — production build, not dev mode |

The restore is representative for Phase 1: no Phase 1 query reads `messages`,
`response` or `proxy_server_request`, the three columns the restore replaced with
placeholders. Row count and all attribution columns are the real thing.

## Results

| # | Case | Result |
|---|---|---|
| 1 | `next build` compiles the route | PASS (after fix — see D1) |
| 2 | Drizzle migration against a real Postgres | PASS — `job_run`, `value_month_snapshot` created |
| 3 | No auth header | PASS — 401 `{"error":"unauthorized"}` |
| 4 | Wrong bearer token | PASS — 401 |
| 5 | Malformed month `2026-7` | PASS — 400, message names the expected format |
| 6 | Out-of-range month `2026-13` | PASS — 400, "month must be 01–12" |
| 7 | Incomplete month `2026-08` | PASS — 500 with the guard's message; nothing frozen, nothing sent (G6) |
| 8 | Valid month `2026-07` | PASS — 200 `{"status":"sent"}`, email delivered |
| 9 | Same month re-run | PASS — 200 `already_frozen`, **no second email** (G3) |
| 10 | Second month `2026-06` | PASS — sent; not July-specific |
| 11 | Default month (no `?month=`) | PASS — resolved to 2026-07, `already_frozen` |
| 12 | Snapshot persisted | PASS — one row per month, 6,562-byte payload |
| 13 | `job_run` written on success and failure | PASS — all five outcomes recorded |
| 14 | Email shape | PASS — subject "Value Ledger — July 2026", CSV attachment `value-ledger-2026-07.csv` (4,482 B), HTML 5,146 B |
| 15 | Unreachable LiteLLM | PASS (after fix — see D2) |

Full suite after all fixes: **125 tests**, `tsc --noEmit` clean.

## Defects found and fixed

**D1 — the application could not be started.** `package.json` carried only the `phase0`
script. No `dev`, `build`, or `start`. `next build` had never been run in fifteen tasks, and
the README's documented `curl` against the trigger route had no way to be served. Root cause:
the plan never asked for them. Fixed in `865702e`.

**D2 — a failed job produced an empty, undiagnosable error.** With LiteLLM unreachable the
route returned `{"error":"","month":"2026-07"}`, wrote `job_run.message = ''`, and logged
nothing at all. Root cause: `pg-pool` throws an `AggregateError` whose `message` is the empty
string, with the detail in `code` and `errors`; the route used `err.message` directly. This
mattered because a 500 exists to make cron alert, and the alert led to an audit row saying
`error` and nothing else. Fixed in `410d80d` — a `describeError` helper reconstructs a message
from constructor name, `code` and the aggregated errors, the failure is now `console.error`d
with its stack, and the audit message is capped at 1000 chars.

After the fix the same failure reports:
`AggregateError: ECONNREFUSED: connect ECONNREFUSED ::1:55441; connect ECONNREFUSED 127.0.0.1:55441`
in the HTTP body, the server log (with stack), and the audit row.

**D3 — `.env.local` was not gitignored.** Next's convention file for secrets would have been
committable. Fixed in `865702e` (`.env*` with `!.env.example`).

## Not covered by Stage A

- The read-only database grant has never been created or exercised.
- Never run against the live LiteLLM — only the restore.
- Never run on a real schedule, and never delivered to a real mailbox.
- **Whether the report's content is correct and useful — Stage B, Daniel only.**
