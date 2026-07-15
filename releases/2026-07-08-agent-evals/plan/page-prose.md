# Agent Evals release page — prose sections (verified against frontend code)

All facts below were verified by reading the frontend source. Paths are relative to
`/Users/daniel.claessen/Desktop/Projects/exulu/frontend`. All quoted UI strings are
verbatim from `messages/en.json` (the `evals.*` namespace) or from the component JSX.
ICU placeholders like `{count}` render as real numbers in the UI.

Brand: follow `../hyperframes-design.md` — light product UI, purple `#7033FF` accents only,
Inter body, JetBrains Mono for code, subtle 1px `#E7E7EE` borders.

---

## Section 1 — One home for every eval set

**Suggested title:** "Every eval set, one searchable home"

**Verified prose (2–3 sentences):**

The new **/evals** area gives eval suites a permanent address: a paginated table of eval
sets ("Test agents against expected behavior and track scores across runs.") with a
"Filter by name…" search box that filters server-side as you type, and a "Test case library"
shortcut in the toolbar. Creating a suite is one dialog — "New eval set" opens
"Create eval set" ("Create a new evaluation set. You can add test cases after creation.")
with just a name and description, so the empty state ("No eval sets yet — Create your first
eval set to start testing agents.") is two fields away from gone. Access is RBAC-gated on the
`evals` right: anyone without at least `evals: read` lands on a lock screen — "Access denied.
You don't have permission to access Evals. Contact your administrator to request access."

**Verified details for the writer:**
- Route: `/evals` — `app/(application)/evals/page.tsx`. Page title "Evals", description
  "Test agents against expected behavior and track scores across runs."
- Search: toolbar input, placeholder "Filter by name…", 200 ms debounce, server-side
  `name contains` filter via `GET_EVAL_SETS` (`eval_setsPagination`, 10 per page,
  30 s poll) — `components/data-table.tsx`.
- Rendered columns: Name, Description, Updated (relative time), plus a row-actions menu
  ("Open" / "Delete"). Rows click through to `/evals/[id]`. On phones the table becomes a
  card list.
- New eval set dialog (`components/create-eval-set-modal.tsx`): trigger "New eval set";
  dialog title "Create eval set"; fields "Name *" (placeholder "e.g., Customer Support
  Scenarios") and "Description" (placeholder "Describe what this eval set tests…");
  submit "Create eval set". Fires the `CREATE_EVAL_SET` mutation (`eval_setsCreateOne`).
- RBAC: `can(user, { area: "evals", level: "read" })` from `lib/rights.ts` — the same
  predicate as the sidebar nav, so nav and page never disagree. Read = super_admin or
  `role.evals ∈ {read, write}`. Denied users get `_shared/access-denied.tsx` (Lock icon,
  "Access denied" / "You don't have permission to access Evals. Contact your administrator
  to request access.") — the same screen on `/evals`, `/evals/cases`, and `/evals/[id]`.
- Delete is confirm-guarded: "Delete eval set?" — "This will permanently delete the eval
  set \"{name}\". This action cannot be undone."

---

## Section 2 — Global test-case library

**Suggested title:** "A test-case library that outlives any one suite"

**Verified prose (2–3 sentences):**

Test cases now live in their own library at **/evals/cases** — "Create and manage test cases
for evaluating agent performance." — where every case is a named, multi-turn conversation
with an expected output, not a throwaway fixture buried inside a suite. Each row shows a
Messages badge ("3 messages") that counts only the *user* turns you authored — the
auto-generated assistant placeholders between them don't inflate the number. From any eval
set you pull cases in via "Add existing test cases" ("Pick from unassigned test cases."),
so authoring and suite assembly are two separate, deliberate steps.

**Verified details for the writer:**
- Route: `/evals/cases` — `app/(application)/evals/cases/page.tsx`. Title "Test cases",
  breadcrumb back to "Evals", primary action "New test case" (write-gated:
  `user.super_admin || user.role?.evals === "write"`).
- Columns: Name, Description, Messages, Updated. Messages badge is ICU plural
  ("{count, plural, one {# message} other {# messages}}") and counts
  `inputs.filter(m => m.role === "user")` — `cases/components/columns.tsx` documents that
  counting all entries would show 4 for a 2-turn case.
- The case editor (`cases/components/test-case-modal.tsx` copy in en.json): tabs
  "Basic info" / "Conversation"; "Conversation flow" — "Add user messages in order. The
  agent will respond between each message automatically."; helper "Press Enter to add,
  Shift+Enter for new line. You can attach files to messages."; expected output is required —
  "This can be an exact expected response or a description of what the output should contain."
- Placeholder turn copy (verbatim, incl. emoji): "💬 Placeholder, generated agent response
  will be added here when the test case is run…"
- Set-side add flow (in `/evals/[id]`): "Add existing test cases" — "Pick from unassigned
  test cases. A case can belong to only one set."; sets cap at "{count}/500 cases"
  ("This set has reached the 500-case limit.").
- CAUTION for the writer: do NOT call this a "cross-suite" or shared bank — the shipped
  model is one set per case (see Excluded).

---

## Section 3 — Queue chip + queue console

**Suggested title:** "The run queue, one quiet chip away"

**Verified prose (2–3 sentences):**

Eval runs execute on a background queue, and its whole state now fits in one quiet chip
above the results matrix — "Queue: 4 active · 1 failed" — polling every 5 seconds, turning
the failed count red, and disappearing entirely when the queue is empty. Click it and a
full console slides in ("Queue: eval_runs"): status tabs (Active / Waiting / Failed /
Completed) with live counts, a jobs table with click-to-copy IDs, attempts and timestamps,
and bulk actions — "Retry 3 job(s)", "Delete 3 job(s)", with an optional "Delete the
original jobs after retrying" cascade. Queue-level controls — "Pause queue", "Resume queue",
"Drain queue" — are all confirm-guarded and, like every mutating action in the panel,
visible only to users with `evals: write`; readers can still open and inspect everything.

**Verified details for the writer:**
- Chip: `[id]/runs/components/queue-chip.tsx`, mounted in `[id]/runs/eval-runs.tsx`.
  Renders "Queue:" + "{count} active" + "·" + "{count} failed"; `GET_QUEUE` with
  `pollInterval: 5000`; hidden when active+waiting+failed+delayed+paused === 0; failed>0
  gets `text-destructive`; aria-label "Open queue"; queue name constant `"eval_runs"`.
  Opens a right-side Sheet (`sm:max-w-3xl`) titled "Queue: eval_runs".
- Console: `[id]/runs/components/queue-management.tsx`. Header status badge Paused /
  Maxed / Active; stats row "Max queue concurrency", "Max worker concurrency",
  "Job timeout", "Max rate limit" (unit "jobs/sec"). Tabs rendered: Active, Waiting,
  Failed, Completed — each with a live count badge. Footnote: "* Only the last 5,000
  successful and failed jobs are kept."
- Jobs table columns: Name, ID, Attempts, Created, Processed on, Finished on, Inputs,
  Outputs, Actions. Job ID cell is click-to-copy ("Copy job ID" tooltip; toast "Copied to
  clipboard"). Page sizes 20/50/100/200. Freshness shown as "Updated Ns ago" via
  RelativeTime (the old auto-refresh spinner is gone). Below `md` the table collapses to a
  card stack. Empty state: "No jobs in queue — Nothing scheduled or in flight for this
  status."
- Bulk retry/delete: checkbox selection (active jobs unselectable), buttons
  "Retry {count} job(s)" / "Delete {count} job(s)". Retry confirm: "This creates a new job
  with the same inputs as the original." plus checkbox "Delete the original job(s) after
  retrying". Retry re-schedules the test case under the same eval run via the `RUN_EVAL`
  mutation.
- Drain confirm (verbatim): "This removes all waiting and delayed jobs from eval_runs.
  Active, completed, and failed jobs are not removed. This action cannot be undone."
- RBAC: pause/resume/drain, bulk bar, per-row retry/delete, and selection checkboxes are
  all gated on `canWrite`; stale selections are cleared if write access flips off.

**GraphQL snippet (the one real developer surface — `queries/queries.ts`, `RUN_EVAL`):**

```graphql
mutation RunEval($id: ID!, $test_case_ids: [ID!]) {
  runEval(id: $id, test_case_ids: $test_case_ids) {
    jobs
    count
  }
}
```

Caption suggestion: "One mutation fans a run out into queue jobs — pass `test_case_ids`
to re-run just the cases that failed. It's the same call the console's Retry button makes."
(Verified: `runEval` returns `jobs` and `count`; the chip's retry handler calls it with
`{ id: evalRunId, test_case_ids: [testCaseId] }`.)

---

## Section 4 — Workers-not-configured guardrail

**Suggested title:** "A guardrail, not a dead end"

**Verified prose (2–3 sentences):**

If the deployment has no background workers, the evals area says so instead of failing
silently: an orange banner — "Background workers are not configured" — explains exactly
what still works: "Eval sets are viewable but runs can't execute. Configure Redis to enable
evaluation runs." It's deliberately a warning, not an error, because browsing and authoring
stay fully functional; and only super-admins — the people who can actually fix it — get the
"Configuration →" link.

**Verified details for the writer:**
- `_shared/workers-warning.tsx`, rendered across the /evals area (list, detail, runs).
- Condition: hidden when `config.workers.enabled && config.workers.redisHost` are both
  set; shown otherwise. Uses `<Alert variant="warning">` (orange) with an AlertTriangle
  icon — the file comment states this is a warning, not a failure, because sets remain
  viewable and only runs can't execute.
- "Configuration →" links to `/configuration` and renders only when `user.super_admin`.

---

## EXCLUDED (not shipped or not verifiable — do not claim on the page)

1. **"Cross-suite regression bank" framing for /evals/cases.** The shipped model is the
   opposite: a test case belongs to at most ONE set — verbatim UI copy: "Pick from
   unassigned test cases. A case can belong to only one set."
   (`evals.detail.selectExisting.description`). The library is global and cases survive
   independently of sets, but they are not reused across suites.
2. **"Cases" and "Last run" columns on the /evals list.** The i18n keys exist
   (`evals.list.columns.cases`, `.lastRun`) but the columns are not rendered — a code
   comment in `app/(application)/evals/components/columns.tsx` says the backend aggregate
   fields haven't shipped and the columns wait on them. Only Name / Description / Updated
   render today.
3. **"Stuck" status tab in the queue console.** `evals.queue.tabs.stuck` exists in
   en.json, but `queue-management.tsx` renders only Active, Waiting, Failed, and
   Completed tabs.
4. **`CREATE_EVAL_RUN` as the featured snippet.** The operation is real
   (`eval_runsCreateOne` in `queries/queries.ts`) but it's form plumbing for the run-config
   modal; per the one-snippet budget, `RUN_EVAL` is the operation that earns the spot
   (fans out queue jobs, powers per-case retry). Don't show both.
5. **Any claim that the queue chip appears on the /evals list page.** It is mounted only
   on the eval-set runs view (`[id]/runs/eval-runs.tsx`), above the results matrix.
