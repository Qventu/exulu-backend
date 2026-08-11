# Value Ledger — design

**Date:** 2026-08-11
**Status:** design approved, ready for implementation planning
**Author:** Daniel Claessen (with Claude)

## Problem

OPEN Digital Experience spends roughly $5,000/month on LLM tokens through the Exulu IMP
platform. Developers use the LiteLLM gateway to power agentic coding tools; business users
run custom agents (PULSE, JIRA, Moco, the Offer Generator). Management sees the invoice and
asks "how did it help us?"

Efficiency gains are hard to track. Developers are not candid about productivity gains
because they fear for their jobs, so self-reported numbers are worthless. Previous attempts
at a concept stalled on the idea of estimating time savings from prompts and outputs — an
approach that is hard to get right and easy to discredit.

The platform can answer two questions honestly: **is the spend defensible**, and **is
adoption real**. It cannot honestly answer "how many euros did we save". This design is
built around that distinction.

## Goals

1. Make the monthly spend defensible to management.
2. Prove adoption is real, or show honestly that it is not.
3. Show which use cases the platform is actually used for.

## Non-goals

- **Client rebilling.** Splitting client-billable from internal spend is handled outside
  this tool, per client instance, via exports. The tool provides project-tagged data;
  it does not model invoicing or markup.
- **Estimated savings.** The tool never asserts a euro of value created.
- **Individual performance measurement.** See "Trust" below.
- **Anything requiring Exulu.** See "Boundary".

## Constraints

These were decided during design and are load-bearing. Changing any of them invalidates
parts of the model.

| # | Constraint | Consequence |
|---|---|---|
| C1 | **Observe only.** Never ask a user anything — no surveys, no thumbs up/down, no "did this save you time?", no user-declared intent | Every signal is passively observed behaviour. Admin/tenant configuration is not "asking users" and is allowed |
| C2 | **Team-level only, minimum-N enforced.** No per-person figures reach management | Removes the incentive to perform usage, which keeps the observed behaviour honest. Costs the ability to spot individual champions |
| C3 | **The artifact is a monthly report that arrives**, not a dashboard someone must log into | The dashboard exists, but as a drill-down for follow-up questions. The email is the product |
| C4 | **LiteLLM is a hard boundary.** The tool reads only the LiteLLM server | Zero coupling to Exulu's release cycle, migrations or RBAC. Costs the Exulu-native signals (delivered work, knowledge retrieval, tool outcomes) |
| C5 | **Standalone deployable**, hosted alongside Exulu IMP, one customer initially | Iterate fast without touching core platform engineering |

C4 reverses an earlier decision to build this as a generic Exulu feature. The tool becomes
a LiteLLM-native product instead — it works against any LiteLLM deployment, which is a
larger surface than "Exulu tenants".

## Concept

**The Value Ledger.** Five panels, in a deliberate order: the bar, the proof, the
reliability, the waste, the use cases.

The central move: **the tool never claims savings. It states the break-even threshold and
lets management judge.** Instead of "we saved you €180,000" (an unfalsifiable counterfactual
that dies the first time someone checks an example), the report says:

> This month cost €4,847. At your €140/h rate that is 34.6 billable hours. Across 41 active
> people, the platform pays for itself if each saved 51 minutes.

Every input is an invoice figure, an observed count, or the customer's own rate. Nothing is
estimated. The burden of proof inverts: management answers a question they are qualified to
answer, rather than being asked to trust a number the vendor produced.

Credibility is the scarce resource, not numbers. A report that opens by naming its own
waste and its own blind spots earns the right to be believed about everything else.

## Metric model

### Panel 1 — The Bar

| Metric | Definition |
|---|---|
| Total spend | Sum of `spend` for the calendar month |
| Active people | Distinct `user_id_*` tags with ≥1 request in the month |
| Cost in hours | `total_spend / hourly_rate` (rate is tenant config) |
| Break-even per person | `cost_in_hours / active_people` |
| Sensitivity strip | Return multiple at 30 min / 1 h / 2 h saved per person, labelled explicitly as scenarios |
| **Attribution coverage** | % of spend carrying a resolvable team tag |

Coverage is on page one deliberately. Silent misattribution is the failure mode that would
destroy the report's credibility, so it is promoted to a headline metric and functions as a
self-check on the pipeline.

**Currency.** `LiteLLM_SpendLogs.spend` is denominated in **USD**, while the customer's rate
card is in EUR. The break-even calculation divides one by the other, so the units must be
reconciled explicitly or the headline number is silently wrong by the FX rate. Configuration
therefore carries `reporting_currency` and a `fx_rate_usd_to_reporting`, both of which are
**printed in the report appendix alongside the date the rate was set**. The tool does not
fetch live FX rates: a figure that changes when you re-run last month's report would break
snapshot immutability. The rate in force is frozen into the snapshot.

**Definitions.** "Active" means ≥1 request in the period. Minimum-N defaults to **5** active
users per team; teams below it roll into "Other". Both are configuration.

### Panel 2 — Adoption

The strongest evidence in the report, and it needs nothing beyond LiteLLM.

| Metric | Definition | Why this one |
|---|---|---|
| Active people, trend | Distinct user tags per month | Baseline |
| Median active **days** per person | Distinct dates with ≥1 request, median across active users | Habit vs. demo. Days-of-return is far harder to perform than request volume |
| **Retention cohorts** | Of users first active in month M, the % still active in M+1, M+2, M+3 | The flattening curve is the least gameable proof that exists |
| Breadth | Distinct agents / models / projects / **client tools** per active person | Woven in, or a single trick |
| Concentration | Share of spend and activity held by the top 10% of users | If it is one power user's hobby rather than a company capability, the report says so |

**Retention must count human-initiated activity only.** A scheduled routine retains itself
with no human involved; counting that as user retention would be a lie. Requests carrying a
`routine_id_*` tag are excluded from the user retention cohort and reported separately as
automation.

### Panel 3 — Reliability and automation

This panel replaces the "delivered work" panel from the pre-C4 design. Delivered-work
signals (completed routine runs, write-effect tool calls) live in Exulu's own tables and
audit bus, and are out of reach under C4.

| Metric | Definition |
|---|---|
| Success / failure rate | `successful_requests` and `failed_requests` from the daily tables |
| Unattended automation volume | Requests and spend carrying a `routine_id_*` tag. **Currently zero:** Phase 0 found 0 of 112,559 production requests carry this tag, while 8,951 carry `agent_id_*`. Either no scheduled routines run through the gateway, or they do not tag themselves. The report must render this as "no scheduled automation observed" rather than a bare `0`, which reads as a bug |
| MCP tool calls | From `mcp_namespaced_tool_name`, including results where available |
| Latency | `request_duration_ms`, and time-to-first-token via `completionStartTime` |
| Cache efficiency | `cache_hit`, `cache_read_input_tokens` — spend avoided |

### Panel 4 — The waste ledger

Not a garnish. This panel is the credibility engine, and it is the only part of the report
that gives management something to *do* — which is what makes a monthly artifact worth
receiving rather than filing.

| Metric | Definition |
|---|---|
| **Lapsed users** | Active in any of the three prior months, but not in this one |
| Dormant keys | `LiteLLM_VerificationToken` rows with no recent spend |
| Abandoned agents | `agent_id_*` tags with historical traffic and none in 30 days |
| Failing traffic | Spend on requests that failed |
| Concentration risk | Restated from Panel 2, in cost terms |
| Model mix | Spend by model with trend — surfaces drift toward expensive models |

Cold knowledge contexts (embedded but never retrieved) are **not** measurable here: vector
retrieval is not an LLM call and leaves no trace in LiteLLM.

**There is no seat roster, so there is no dormant-seat metric.** Phase 0 found
`LiteLLM_UserTable` holds 7 rows against 52 users seen in tags, and `LiteLLM_TeamTable` is
empty — the roster lives in Exulu, which is out of bounds under C4. Computing
"dormant ÷ provisioned" would have divided by 7 and reported a confidently wrong
percentage. Lapsed-user counts need only request history, and are honest.

### Panel 5 — Use cases

Two independent sources that cross-check each other. A single source you cannot validate is
a claim; two sources that agree are evidence.

**(a) Deterministic spine.** Complete coverage, no content access, no LLM cost.

- **Client tool, free and exact.** LiteLLM auto-tags every request with the caller's
  `User-Agent` — `User-Agent: claude-cli`, `User-Agent: Kilo-Code`, `User-Agent: OpenAI`,
  `User-Agent: ai-sdk` (Exulu's own backend). Phase 0 found 14 coarse variants and 130
  version-specific ones; the coarse tag is the reporting dimension, the versioned one is
  noise. This needs no prompt access and no classifier, so it belongs in **Phase 1**, not
  Phase 3. Note the format is `User-Agent: <value>` with a colon and space — it does *not*
  follow the `dimension_value` convention of Exulu's tags and needs its own parser.
- Tool popularity from the `tools` array in the request body (what was available) and
  `tool_calls` in the response (what the model chose).
- MCP tools are first-class: `mcp_namespaced_tool_name` is a column and a daily-table
  dimension, and `mcp_tool_call_metadata` carries name, arguments and result.
- Agent ranking from `agent_id_*` tags and `LiteLLM_DailyAgentSpend`.
- **Tool co-occurrence clustering** — which tools appear together within a session. This
  recovers use-case shapes from pure metadata: `{jira.search + moco.create_activity}` is
  timesheet reconciliation; `{crawl + research + render}` is customer analysis.

Tool *popularity* is measurable. Tool *success* is not, except for MCP tools — non-MCP tool
results are never stored.

**(b) Classified sample.** Tenant-level opt-in, enabled by the workspace admin.

- **Classify, never estimate.** "38% of sessions were document drafting" is checkable by
  sampling. "Saved 200 hours" is not. This line is why the panel stays defensible.
- **Read intent, not transcripts.** Classify from the opening user message plus the tool
  sequence. Intent lives there; the rest is execution detail. Far cheaper and a fraction of
  the privacy exposure.
- **Fixed top-level taxonomy, emergent sub-labels.** A generic top level (drafting /
  analysis / lookup / code / extraction / translation / other) keeps month-over-month
  trends comparable; discovered sub-labels underneath reflect what the customer actually
  does. Purely emergent categories drift and destroy trending.
- **Sampled, cheap model, confidence threshold.** Low-confidence lands in an honest
  `unclassified` bucket rather than being force-fit.
- **The meter must not move the meter.** Classification cost must stay a rounding error on
  the invoice it exists to justify. Budget it and report it in the appendix.

Opt-in is at **tenant level** (C1-compatible: the admin decides, users are informed, not
asked). Per-user opt-in was rejected because a self-selected sample makes "most popular use
case" mean "most popular among people comfortable being analysed" — biased in an unknown
direction.

**(a) validates (b).** If the classifier reports 22% timesheet work but the Moco tool
appears in 40% of sessions, something is wrong, and it surfaces before management sees it.

## Data foundation

Verified against the vendored LiteLLM package at
`backend/ee/python/.venv/lib/python3.12/site-packages/litellm/`.

### Tables

**`LiteLLM_SpendLogs`** — 31 columns. Relevant ones: `request_id`, `call_type`, `api_key`,
`spend`, `total_tokens`, `prompt_tokens`, `completion_tokens`, `startTime`, `endTime`,
`request_duration_ms`, `completionStartTime`, `model`, `model_group`,
`custom_llm_provider`, `user`, `metadata` (JSON), `cache_hit`, `cache_key`, `request_tags`
(JSON), `team_id`, `organization_id`, `end_user`, `requester_ip_address`, `messages`
(JSON), `response` (JSON), `session_id`, `status`, `mcp_namespaced_tool_name`, `agent_id`,
`proxy_server_request` (JSON).

**Six pre-aggregated daily tables** — `LiteLLM_Daily{User,Team,Organization,EndUser,Agent,
Tag}Spend`. Each carries `spend`, `prompt_tokens`, `completion_tokens`,
`cache_read_input_tokens`, `cache_creation_input_tokens`, `api_requests`,
`successful_requests`, `failed_requests`. Grain: per day per identity per `api_key` per
`model` per `custom_llm_provider` per `mcp_namespaced_tool_name` per `endpoint`.

**LiteLLM already does the daily rollup.** No ETL layer is needed for Panels 1, 2 and 4.

**Identity tables** — `LiteLLM_UserTable` (user_id, user_email, team_id, max_budget),
`LiteLLM_TeamTable` (team_id, team_alias, members, admins), `LiteLLM_VerificationToken`
(token, user_id, team_id, agent_id, project_id, organization_id), `LiteLLM_AgentsTable`,
`LiteLLM_TagTable`, `LiteLLM_BudgetTable`.

### The attribution spine is tags

Exulu's proxy passthrough (`backend/src/exulu/routes.ts:2130`) authenticates upstream with
the **master key**, so LiteLLM's own `user` column likely collapses to a single identity for
all Exulu traffic. Real attribution rides in the tags built by `buildTags()`
(`backend/src/exulu/tags.ts:30-102`): `user_id_*`, `user_name_*`, `role_id_*`,
`project_id_*`, `agent_id_*`, `team_id_*`, `routine_id_*`, `context_id_*`.

Therefore **`LiteLLM_DailyTagSpend` is the primary fact table**, not `DailyUserSpend`.

Two write paths deliver identity, and they differ:

- **Proxy passthrough** (`routes.ts:2130-2253`) sets both `x-litellm-tags` and
  `x-litellm-spend-logs-metadata` headers. Tags: user, role, project, team.
- **In-app chat** (`tags.ts:156-205` `createTaggedFetch`) sets no headers; it injects the
  same tag strings into the request **body**. Tags additionally include `agent_id` and
  `routine_id` (`resolve-model.ts:95`).

**Both paths land in `SpendLogs.request_tags`, and only there.** Phase 0 confirmed the
`x-litellm-spend-logs-metadata` header does *not* surface as queryable keys on the
`metadata` column — read tags, never metadata.

Neither path sends a session identifier, yet `session_id` is fully populated: LiteLLM
assigns it itself.

### Prompt and tool-call storage — two traps

1. **`store_prompts_in_spend_logs` defaults to `false`.** Until it is enabled, `messages`,
   `response` and `proxy_server_request` are all `'{}'`. Enabling it is a LiteLLM config
   change and therefore inside the C4 boundary.
2. **Even when enabled, the `messages` column stays empty for normal chat completions.**
   `_get_messages_for_spend_logs_payload()` (`proxy/spend_tracking/spend_tracking_utils.py:598-612`)
   only populates it when `call_type == '_arealtime'`. The prompt lands in
   **`proxy_server_request`** (the body snapshot, `proxy/litellm_pre_call_utils.py:1517`)
   and the model output in `response` (`spend_tracking_utils.py:1014-1071`).

Building against `messages` yields nothing. Use `proxy_server_request`.

Tool results are stored only for MCP tools, via `mcp_tool_call_metadata`
(name, arguments, result). Non-MCP tool outcomes are not recorded anywhere.

### Verified empirically — Phase 0, 2026-08-11

Settled against a production backup (112,559 `SpendLogs` rows, 2026-06-02 → 2026-08-09).
Full results: `2026-08-11-value-ledger-phase0-findings.md`.

| question | answer |
|---|---|
| Attribution coverage | **100%** for user / team / role. project 82.3%, agent 2.1% |
| `session_id` populated? | **Yes, 100%** — 30,086 sessions. No sessionisation heuristic needed |
| `DailyTagSpend` grain | Genuine daily grain; `date` is **`text`**, not `date` |
| `user` column collapse? | **Yes** — 97% `default_user_id`. `DailyUserSpend` is unusable |
| `status` vocabulary | Exactly `success` / `failure`. 7.5% failure |
| `SpendLogs` volume | 112,559 rows over ~10 weeks — small enough to query directly |

Two results changed the design rather than confirming it:

- **Exulu identity is absent from `metadata`.** `metadata ? 'user_id'` matches **0 of
  112,559** rows; only LiteLLM's own `user_api_key_user_id` is present. Any implementation
  reading `metadata->>'user_id'` returns nothing. `request_tags` is the sole attribution
  channel — which is what this design already assumed, and why it survived.
- **`messages` is always empty**, on every row, despite prompt storage being enabled in
  production. Prompts are in `proxy_server_request` (85% of rows) and outputs in `response`
  (82%). Phase 3 needs no configuration change to proceed.

## Architecture

A single Next.js application with its own Postgres schema, deployed as a container
alongside LiteLLM.

```
LiteLLM Postgres  (read-only connection)
  LiteLLM_Daily*Spend  ← Panels 1, 2, 3, 4
  LiteLLM_SpendLogs    ← Panel 5, sampled
  LiteLLM_UserTable / TeamTable / VerificationToken  ← identity
        │
        ▼
  Value Ledger app (Next.js)
    ├── monthly snapshot job   → value_month_snapshot   (frozen, immutable)
    ├── classification job     → session_use_case       (sampled, opt-in)
    ├── report generator       → HTML email + CSV
    └── dashboard              → four views over the snapshot
        │
        └── own Postgres schema: config, snapshots, classifications
```

**The report never queries a live source.** It reads a frozen snapshot. Every figure is
reproducible months later, auditable against the invoice, and immune to LiteLLM being down
on the 1st.

**Own-schema tables:**

- `config` — hourly rate, `reporting_currency`, `fx_rate_usd_to_reporting` and the date it
  was set, min-N threshold, taxonomy, classification opt-in and sampling rate, report
  recipients.
- `value_month_snapshot` — the frozen monthly figures. Written once, never recomputed.
- `session_use_case` — classification results with confidence and model used.
- `job_run` — execution log for the scheduled jobs.

**Delivery:** styled HTML email plus a CSV attachment, over SMTP. No PDF: nothing in the
stack renders HTML→PDF, and adding a headless browser for this is not worth it. The CSV
doubles as the client-billing-split export referenced in the non-goals.

## Delivery phases

This design describes more than one implementation plan's worth of work. It decomposes into
four phases, each independently useful, each getting its own plan.

**Phase 0 — Empirical verification. ✅ Done 2026-08-11.** Settled against a production
backup restored locally. It caught two defects that would each have produced a silently
empty or wrong Phase 1, and confirmed the gate: coverage is 100%, so Phase 1 proceeds.

**Phase 1 — Snapshot and report.** Own schema, monthly snapshot job, Panels 1, 2, 3 and 4,
HTML email plus CSV. This is the whole promise of the design: an artifact that arrives and
answers the question. Shippable on its own.

**Phase 2 — Dashboard.** The four views over the frozen snapshot, so follow-up questions
can be answered live rather than deferred to next month.

**Phase 3 — Use-case classification (Panel 5).** Requires `store_prompts_in_spend_logs` to
be enabled and a tenant opt-in decision. Deterministic spine (5a) first, since it needs no
content access and can validate the classifier; sampled classification (5b) after.

Phase 1 delivers the defensibility argument. Phase 3 delivers the "what is it for" answer.
If only one ships, it should be Phase 1.

## The monthly report

Page one carries only this:

> **August 2026 · €4,847 · 41 people · 34.6 hours**
> This month's platform cost equals **34.6 hours** of billable time at your €140 rate.
> Break-even: **51 minutes saved per active person.**
> *Coverage: 96% of spend attributable to a named team. 4% unattributed.*

Then, in order: Adoption → Reliability and automation → Use cases → Waste → Appendix
(method, definitions, and an explicit statement of what the report cannot see).

Every section carries a month-over-month delta. A monthly artifact without trend is a
snapshot that arrives repeatedly.

## Integrity and failure modes

**The snapshot is immutable.** Computed on the 1st, never recomputed. Late-arriving rows are
noted in the following month rather than silently backfilled, so August's figures re-derive
identically in December.

| Failure | Behaviour |
|---|---|
| LiteLLM DB unreachable | Retry, then alert. The report does **not** send with partial data — a quietly incomplete report is worse than a late one |
| Tags missing on some traffic | Spend lands in `unattributed`; coverage % on page one reflects it |
| Classifier low-confidence or erroring | `unclassified` bucket, shown honestly, never force-fit |
| Team below min-N | Rolls into "Other", enforced in the query layer rather than the template |
| Classification cost drifts up | Budgeted and reported in the appendix |

## Testing

- **Golden-dataset tests** — seed a synthetic `SpendLogs` and assert every metric to the cent.
- **Evidence-Lock** — the report fails to build if its prose contains any number absent from
  the snapshot. This is the `ALLOWED_PRICING_NUMBERS` pattern from the ai.open Offer
  Generator, applied to a new domain.
- **Classification eval** — a human-labelled sample as ground truth, so accuracy is a
  measured number rather than a hope.
- **Min-N and coverage assertions** as tests, not conventions.
- **Snapshot immutability test** — recomputing a frozen month must not alter it.

## Trust and privacy

C2 exists for a measurement reason as much as an ethical one: if people believe usage is
individually surveilled and reported upward, behaviour distorts and the data stops meaning
what it claims to mean. The design measures depth and return rather than raw volume,
aggregates to teams with a minimum-N floor, and publishes no individual rankings.

Operationally: a read-only database user, classification limited to a bounded prompt window
rather than full transcripts, and no per-person figures leaving the system.

## What this report will not claim

Stated in the appendix of every issue, because the refusals are what make the rest credible:

- No euro figure for value created.
- No productivity or time-saved estimate.
- No causal claim that the platform produced any business outcome.
- No individual performance measurement.
- No claim about work that never passed through LiteLLM.
