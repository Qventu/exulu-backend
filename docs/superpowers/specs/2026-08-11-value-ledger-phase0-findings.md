# Phase 0 findings — Value Ledger

Source: production LiteLLM backup `2026-08-10T00-00-00-664Z.sql.gz` (pg_dump custom
format, PostgreSQL 17.6, 5.4 GB compressed / ~20 GB raw), restored locally with
prompt/response payloads filtered out. Data range 2026-06-02 → 2026-08-09.

## Gate answer: attribution coverage is 100%

July 2026, share of spend carrying each tag dimension:

| dimension | spend USD | % of total |
|---|---|---|
| user_id | 4,210.29 | 100.0 |
| team_id | 4,210.29 | 100.0 |
| role_id | 4,210.29 | 100.0 |
| project_id | 3,465.83 | 82.3 |
| agent_id | 86.37 | 2.1 |

Every dollar is attributable to a user, team and role. The design's main risk — a report
that silently accounts for only part of the invoice — does not materialise.
**Phase 1 proceeds as designed.**

## Volume and trend

| month | spend USD | requests | failed | active people | days |
|---|---|---|---|---|---|
| 2026-06 | 1,718.52 | 32,676 | 2,506 | 32 | 26 |
| 2026-07 | 4,210.29 | 62,525 | 4,751 | 45 | 30 |
| 2026-08 (1–9) | 1,064.60 | 17,029 | 862 | 28 | 8 |

Spend rose 2.4× June→July while active people rose 32→45.

## The Bar, computed for real (July 2026)

At €140/h and USD→EUR 0.92:

- €3,873 = **27.7 billable hours**
- 45 active people → **break-even at 37 minutes saved per person per month**

| scenario | value | vs cost |
|---|---|---|
| 15 min each | €1,575 | 0.41× |
| 30 min each | €3,150 | 0.81× |
| 60 min each | €6,300 | 1.63× |
| 120 min each | €12,600 | 3.25× |

## Adoption

- **Retention: 84%** — 27 of the 32-person June cohort were still active in July.
- **Median 6 active days** per person in July (mean 8.7, max 26).
- **Concentration: top 10% of people = 59.3% of spend**; top 25% = 85.2%.
- **Failure rate 7.6%** (4,751 of 62,525 July requests).

## The finding that reframes the product question

LiteLLM auto-tags every request with the client `User-Agent`. July spend by tool:

| tool | spend USD | % |
|---|---|---|
| claude-cli (Claude Code) | 3,765.90 | 89.4 |
| Kilo-Code | 192.96 | 4.6 |
| OpenAI SDK | 149.67 | 3.6 |
| ai / ai-sdk (Exulu backend) | 86.37 | 2.0 |
| Junie, Cline, ktor, curl, … | ~15 | 0.4 |

**89% of the spend is developers in Claude Code. Exulu's own agents are ~2%.**

## Runtime probes (112,559 SpendLogs rows restored)

| question | answer |
|---|---|
| `session_id` populated? | **Yes — 100%.** 112,559 rows, 30,086 distinct sessions (3.7 requests/session) |
| `status` vocabulary | Exactly `success` (104,133) / `failure` (8,426) — 7.5% failure |
| prompt storage on? | **Yes.** 95,826 rows (85%) carry `proxy_server_request`; 92,387 (82%) carry `response` |
| `messages` column | **Always empty (0 of 112,559)** — exactly as the vendored source predicted |
| Exulu identity in `metadata`? | **No.** `user_id`/`team_id`/`project_id` keys: **0 rows.** Only LiteLLM's own `user_api_key_user_id` |
| `user` column collapse? | **Yes.** 108,930 of 112,559 are `default_user_id` |
| provisioned users | `UserTable` 7 rows, 46 API keys, but **52 users seen in tags** |

## Two findings that would have broken Phase 1

**1. Exulu's `x-litellm-spend-logs-metadata` header does not produce queryable
`metadata` keys.** The earlier feasibility probe recommended aggregating on
`metadata->>'user_id'`, `->>'team_id'`, `->>'project_id'`. That query returns **zero rows**
against real data. Identity rides exclusively in `request_tags`. The design's choice to
make tags the attribution spine is what saves it.

**2. The `messages` column is always empty even though prompt storage is on.** Anything
built against `messages` would have silently returned nothing forever. Prompts are in
`proxy_server_request`.

Both were flagged as risks in the spec; both are now confirmed as real.

## Design impacts

1. **Free tool attribution.** The `User-Agent` tag delivers a large part of Panel 5(a)
   with no classification, no prompt access and no LLM cost. Add "client tool" as a
   first-class dimension.
2. **The report is mostly about developer tooling**, not business-user agents. The
   PULSE/JIRA/Moco agent story is currently a rounding error in cost terms.
3. **`DailyTagSpend` is genuinely daily-grain and per-dimension correct** — Panels 1, 2
   and 4 can be computed from it alone, without touching `SpendLogs`. Significant
   simplification of the Phase 1 adapter.
4. **`DailyTagSpend.date` is `text`, not `date`.** The adapter must cast or compare as
   text (`left(date,7)` for month).
5. **`agent_id` covers only 2.1% of spend** — Panel 4's abandoned-agent metric is real
   but minor here; do not over-invest.
6. **`LiteLLM_UserTable` / `LiteLLM_TeamTable` appear empty** (pending confirmation once
   the load finishes). If confirmed, provisioned-user counts do not exist in LiteLLM —
   users live in Exulu — so Panel 4's **dormant-seat metric is not computable under the
   hard boundary**. Dormancy would have to be expressed as "active this month vs active
   in any prior month" instead.
7. **65 tables** in this LiteLLM, far newer than the vendored copy used for recon —
   including `WorkflowRun`, `MCPServerTable`, `SkillsTable`, `ClaudeCodePluginTable`.
   Worth re-checking before Phase 3.
