# Claim Check (Claimify-based answer verification) — Design

**Date:** 2026-10-13
**Status:** approved design, not yet planned
**Scope:** new EE module `ee/claim-check/`, one REST endpoint, one config option on the
agentic-retrieval tool, one chat panel in the frontend repo.

## 1. Context & goals

Exulu's approved IMP claims list advertises "Integrierte Halluzinationserkennung", and the
Hamburg-Tourismus architecture document specifies it as a "Claimify-Ansatz" (§7.2.1 there,
§8.2.1 in the shipped docx). Nothing of it exists in code. This design builds it.

The method comes from Microsoft Research's *Towards Effective Extraction and Evaluation of
Factual Claims* (ACL 2025, arXiv 2502.10855). Two things about that paper shape this design:

1. **Claimify is claim *extraction*, not verification.** It turns a question-answer pair into
   standalone, decontextualized claims. The grounding check, the score and the thresholds are
   ours to design; they are not in the paper.
2. **Microsoft's implementation is research-only and not commercially available.** We implement
   the published method with our own prompts, written to the rules the paper describes. The
   appendix prompts are a reference for behaviour, not text to copy.

### Goals

- An answer-level verification pass that extracts the claims an answer makes and reports, per
  claim, whether the sources support it, contradict it, or say nothing about it.
- Visible in the chat under the answer: a score, the extracted claims, and explicit flags where
  the evidence contradicts the answer.
- Available as a standalone API to clients who do not use IMP knowledge bases at all, provided
  they post the right structure.
- Honest numbers. A score that counts opinions and summaries as unsupported is worse than no
  score, because it will be read as a hallucination rate.

### Non-goals

Blocking or rewriting answers; replacing the reranker's relevance judgement; fact-checking
against the open web.

### Decisions taken (with the user, 2026-10-13)

| # | Decision |
|---|---|
| 1 | **Non-blocking.** The answer streams exactly as today. The frontend triggers the check after the stream finishes. Nothing in the generation path waits on it. |
| 2 | **Evidence = the turn's passages first**, then one targeted re-retrieval for claims that came back unsupported (IMP callers only). |
| 3 | **Automatic, retrieval-backed answers only.** No retrieval that turn → no check, no score, no spend. |
| 4 | **The request payload is trusted.** The caller posts answer + sources; the backend checks one against the other. This is deliberate: the endpoint is a product for clients with their own sources. |
| 5 | **A1 (single-shot JSON) now.** A progressive stream (A2) is a later addition; the response is shaped so A2's events are its sub-objects. |
| 6 | **Model is per-agent configuration**, chosen with a model picker when claim checking is enabled, and overridable per request. |
| 7 | **~18 LLM calls per check, not ~100.** Stages are merged and batched. Provider instability makes call count a correctness concern, not just a cost one. |
| 8 | **Benchmark ~30 fixtures**, not the full 556 available. |

## 2. Backend architecture

New module `ee/claim-check/`, license-gated through `ee/entitlements.ts` (`"claim-check"`),
the same way `agentic-retrieval` is. One file per stage, each a pure function over plain data so
it can be tested without a provider.

| File | Responsibility |
|---|---|
| `types.ts` | `Sentence`, `Claim`, `Verdict`, `CheckRequest`, `CheckResult` |
| `split.ts` | `Intl.Segmenter` sentence segmentation (no NLTK on Node) + per-stage context windows + Markdown heading path as metadata |
| `selection.ts` | per sentence: contains a specific, verifiable proposition? → drop / rewrite to verifiable-only / keep |
| `disambiguation.ts` | referential + structural ambiguity; resolvable from question + context? → clarified sentence or `cannot_disambiguate` |
| `decomposition.ts` | standalone claims, essential context in `[brackets]`, inferred content flagged |
| `evidence.ts` | slice sources into overlapping passages, score them per claim lexically, select the top 3–5 with source ids |
| `verify.ts` | claims of one sentence-neighbourhood against selected evidence → `supported` / `contradicted` / `unsupported` + evidence ids + one-line rationale |
| `score.ts` | aggregation, thresholds, per-sentence rollup for highlighting |
| `run.ts` | orchestration: batching, concurrency, bisect-on-failure, circuit breaker, caps, caching |
| `prompts/*.ts` | our prompt text per stage, structured output via `microCall` |

### 2.1 Stage parameters

Following the paper, exposed as config: `maxPrecedingSentences` = 5 for all stages,
`maxFollowingSentences` = 5 for Selection and 0 for the later stages, `maxRetries` = 2
(i.e. `microCall`'s `maxAttempts: 3`),
`completions` = 1 (the paper's 3/3/1 majority voting available via `fidelity: "paper"`),
temperature 0 — 0.2 when `completions > 1`, as the paper specifies.

All calls go through the existing `micro-call.ts` wrapper, which already carries the settings
these calls need (temperature 0, structured output, `maxRetries: 0` so `withRetry` owns retries,
and the Gemini `reasoningEffort: "disable"` workaround). One change is required there: the
2000-token output cap is too low for chain-of-thought stages over a batch of sentences, so
claim-check calls pass their own higher cap (8000).

### 2.2 Why `evidence.ts` exists

Measured on NEWLIFT's live data (read-only): an answer with retrieval averages **3,714 chars
(~30 sentences)**, and the turn's evidence averages **89,404 chars across ~6 chunks** (page-window
expansion), max 603k. Passing the whole evidence set into every verification call would cost more
than every extraction stage combined and would overflow context on long turns.

So evidence is sliced and selected per claim with a lexical scorer — the same keyword/prefilter
idiom the retrieval pipeline already uses, deliberately without an embedder so that external
callers who bring their own sources get identical behaviour. Embedding-based selection is out of
scope for v1.

### 2.3 Call budget and batching

A faithful one-sentence-per-call implementation costs ~100 LLM calls on a NEWLIFT-sized answer.
At a realistic 2% provider error rate, ~87% of checks would hit at least one failure. The fast
path therefore merges and batches, following the pipeline's own `engine: "v2"` precedent
(`mergedMemoryCall`, `mergedRoutingCall`):

- Selection + Disambiguation **merged**, ~10 sentences per call → ~3 calls
- Decomposition, ~5 sentences per call → ~6 calls
- Verification, 2–3 sentence-neighbourhoods per call → ~9 calls

**≈18 calls, three hops deep, ~5–8 s at concurrency 6**, ~115k input / ~25k output tokens,
≈ €0.02 per check on a flash-class utility model. `fidelity: "paper"` restores one sentence per
call and the 3/3/1 voting, for benchmarking and for callers who want maximum precision. The
benchmark (§8) sets the final batch sizes; the numbers above are the starting point.

### 2.4 Scoring semantics

Three rules, each of which exists to keep the number honest:

1. **Dropped sentences are not hallucinations.** `no_verifiable_content` (introductions,
   conclusions, opinions) and `cannot_disambiguate` sentences are excluded from the denominator
   and reported as not checked, with the reason. The paper's own rates for context:
   ≤5.4% cannot-disambiguate, 0.8% yielding no claims.
2. **`contradicted` and `unsupported` are reported separately.** "The sources say otherwise" is
   the hallucination signal; "the sources don't cover this" is a coverage gap. The combined share
   `(contradicted + unsupported) / checkedClaims` drives the label against configurable thresholds
   defaulting to the Hamburg document's 0.1 and 0.3: `ok` below `warn`, `warn` from `warn` up to
   `alert`, `alert` at or above `alert`. The label enum is `ok | warn | alert | n/a`.
3. **No checkable claims → no score.** An answer with nothing verifiable reports `label: "n/a"`,
   never 0%, which would read as total failure.

The second-chance pass applies only when the request names an agent: unsupported claims get one
targeted retrieval each (capped, default 10 per check) and may flip to `supported`, marked
`rechecked: true` — the evidence existed, the answer just was not shown it. External callers with
their own sources skip this entirely.

## 3. Config schema

A 15th option on the `agentic_context_search` tool, `claim_check`, type `json`:

```jsonc
{
  "enabled": false,
  "model": "",
  "fidelity": "fast",
  "thresholds": { "warn": 0.1, "alert": 0.3 },
  "reRetrieve": true,
  "showToExternalUsers": false,
  "caps": { "maxSentences": 120, "maxClaims": 200, "maxReRetrievals": 10 }
}
```

Parsed by `parsePipelineConfig` through the existing `jsonVal` helper, so a malformed blob falls
back to defaults with a warning instead of breaking retrieval. Default `enabled: false`: the
feature costs money and changes the UI, so it is opt-in per agent.

**The frontend half is not optional.** `serializeWizardConfig` emits a fixed list of entries, so
any key the knowledge-search wizard does not know is silently deleted the next time an admin saves
that wizard. `claim_check` must be added to `WizardConfig`, `parseWizardConfig` and
`serializeWizardConfig` (14 entries → 15, and the test asserting the count) in the same change as
the backend option. This is the failure that killed `tuning.engine: "v2"` in NEWLIFT production,
and `suppress_duplicate_passages` is currently in the same state.

Model resolution order, first hit wins:

1. the request's `model`, resolved **without** `rbacBypass` — an API caller must not be able to
   reach a model they are not entitled to;
2. `claim_check.model` from the named agent, resolved the way `utility_model` already is;
3. the retrieval tool's `utility_model` on that agent;
4. the agent's own model;
5. for agent-less API calls, the platform setting `claim_check.default_model`
   (`src/exulu/platform-setting.ts`).

If none resolves, the endpoint answers 400 naming the missing configuration rather than silently
picking a model the operator never chose.

## 4. API contract

`POST /claims/check`, alongside the existing REST handlers in `src/exulu/routes.ts`.

```jsonc
// request
{
  "question": "…",                     // required
  "answer": "…",                       // required, markdown as streamed
  "sources": [ { "id": "…", "name": "…", "content": "…" } ],
  "agent": "uuid",                     // optional: config + model + second-chance retrieval
  "session": "uuid", "messageId": "…", // optional provenance
  "model": "…",                        // optional override, caller RBAC
  "locale": "de",
  "options": { "fidelity": "fast", "completions": 1, "reRetrieve": true,
               "thresholds": { "warn": 0.1, "alert": 0.3 } }
}
```

```jsonc
// response
{
  "status": "ok",                      // or "partial"
  "score": { "claims": 60, "supported": 51, "contradicted": 2, "unsupported": 7,
             "unsupportedShare": 0.15, "label": "warn" },
  "sentences": [ { "index": 0, "start": 0, "end": 118,
                   "state": "checked|no_verifiable_content|cannot_disambiguate|not_checked",
                   "reason": "…", "claimIds": ["c1"] } ],
  "claims": [ { "id": "c1", "sentenceIndex": 0, "text": "Die FST-2XT [Steuerung] …",
                "inferred": true, "verdict": "contradicted",
                "evidence": [ { "sourceId": "…", "quote": "…" } ],
                "rationale": "…", "rechecked": false } ],
  "usage": { "calls": 18, "inputTokens": 114203, "outputTokens": 24880 },
  "timings": { "splitMs": 12, "selectDisambigMs": 2140, "decomposeMs": 1980,
               "evidenceMs": 60, "verifyMs": 3310, "totalMs": 7502 },
  "limits": { "truncated": false, "sentencesSkipped": 0 },
  "notes": []
}
```

`sentences[].start/end` are character offsets into the exact `answer` string the caller sent; the
UI highlight depends on `answer.slice(start, end)` reproducing the sentence verbatim.
`sources[].id` must be unique within a request and is echoed back verbatim in
`claims[].evidence[].sourceId`, so a caller can map evidence to its own source records.
Request `options` override the agent's configuration for that call; omitted keys fall back to the
agent's values, then to the defaults in §3.

**Auth and abuse controls.** `requestValidators.authenticate(req)` as every other handler;
`isExternalUser` → `externalRateLimitExceeded`; `checkApiKeyScope` + `checkRecordAccess` when
`agent` is passed. On top of that, because one request can cost ~18 LLM calls on arbitrary input:

- a per-user claim-check limiter for **every** role, default 30/min and 300/h, configurable;
- a global in-flight cap, default 20 concurrent checks per instance, so a burst cannot drain the
  provider quota the chat itself needs;
- payload caps with per-source truncation (a 600k-char evidence set is never sent whole), 413 on
  over-limit requests. Sentences beyond `caps.maxSentences` and claims beyond `caps.maxClaims` are
  returned as `not_checked` with reason `cap_exceeded`, counted in `limits.sentencesSkipped`, and
  set `status: "partial"` — a long answer degrades, it does not fail;
- a 60 s request timeout.

Status codes: 400 validation, 401/403 auth or scope, 404 unlicensed (the endpoint does not
advertise a feature the deployment has not bought), 413 oversized, 429 limited, 500 engine
failure. Spend rides the caller's existing LiteLLM tags. The contract is
documented in `mintlify-docs`.

## 5. Chat integration

At `finish`, next to `recalledMemoriesMetadata`, a `claimCheckMetadata({ cfg, toolResults,
isGuest })` fragment carrying **ids only**:

```jsonc
{ "claimCheck": { "enabled": true, "sourceIds": ["…"], "toolCallIds": ["…"] } }
```

The client already holds the full tool output — it renders source cards from it — so re-sending
~22k tokens of evidence through metadata would be pure waste. The frontend assembles `sources[]`
from what it has. When the agent has the feature off, or the viewer is a guest/external user and
`showToExternalUsers` is false, the fragment is absent and no check ever runs.

### 5.1 Frontend (separate repo, sibling worktree)

Mirrors the recalled-memories pattern exactly: `chat/components/claim-check.tsx` +
`claim-check-data.ts`, rendered from `message-column.tsx` in the same slot under the message.

- **Running:** "Antwort wird geprüft…" with a claim counter.
- **Done:** a compact bar — *"48 von 52 Aussagen belegt · 2 widersprochen · 2 ohne Belegstelle"* —
  coloured by label, expanding into the claim list with verdict, rationale and evidence links into
  the existing source viewer.
- **Highlighting at sentence granularity** using the response offsets. Claim-exact highlighting
  inside rendered Markdown is fragile; hovering a claim highlights its sentence. Contradicted
  sentences get a distinct marker. `no_verifiable_content` and `cannot_disambiguate` sentences stay
  neutral with the reason on hover — they are not failures and must not look like failures.
- German copy through the existing i18n keys.

Wizard: a new `steps/verification-step.tsx` in the knowledge-search wizard (enable, model picker as
used for `utility_model` in `behavior-step.tsx`, fidelity, thresholds, external visibility), plus a
line in `review-step.tsx` and `summary-card.tsx`.

### 5.2 Persistence

A reload must not lose the panel. One table `claim_checks` (`session`, `message_id`, `payload`
jsonb, `created_at`), written by the endpoint and returned with the session's messages. Created
through the `core-schema` / initdb path with a column-existence guard — never a standalone
migration script.

A Redis result cache keyed by a hash of (question, answer, sources, options, model), 24 h, makes a
frontend retry, a double-fire or a reload free.

## 6. Error handling & resilience

- **Partial beats failing.** A sentence batch that fails after retries is marked `not_checked` with
  a reason; `status` becomes `partial` and the score covers what was checked.
- **Bisect on batch failure.** A failed batch is split in half and retried once, so one bad call
  costs 2–3 sentences rather than 10.
- **Stage circuit breaker.** Above 40% call failure in a stage, the check stops and returns what it
  has. No hammering a struggling provider.
- **Known trap:** after a 429 cooldown, LiteLLM can surface *"Not allowed to access model due to
  tags configuration"*. That is a 429 aftershock, not a misconfiguration; the classifier must treat
  it as retryable and must not report a config error.
- **Concurrency capped at 6** in flight per check, so we do not manufacture our own 429s.
- A failed check never touches the answer — it has already streamed. Worst case the panel reports
  that verification was not possible.

## 7. Testing

TDD per stage, with a stubbed `microCall`:

- `split`: German abbreviations (`z. B.`, `Nr.`, `Abs.`), headings and lists, and the invariant
  `answer.slice(start, end) === sentence.text`.
- `selection` / `disambiguation` / `decomposition`: batch bisect, `min_successes` voting,
  `cannot_disambiguate` exclusion.
- `evidence`: snippet selection, truncation caps, zero-source case.
- `verify`: verdict mapping, neighbourhood batching, evidence ids echoed back.
- `score`: dropped sentences excluded from the denominator, label thresholds, "no checkable claims"
  → `n/a`.
- `run`: circuit breaker, caps → `partial`, cache-hit path.
- HTTP: 400 / 401 / 403 / 413 / 429, license gate, model-resolution order (no `rbacBypass` from a
  request body), `partial` status.
- Frontend: `claim-check-data.test.ts` for metadata parsing and the absent-fragment case.

The backend typecheck gate stays an **equality** at the known error count, with error identities
compared — a drop is as suspicious as a rise.

## 8. Benchmark

Fixtures come from NEWLIFT's live database, which is their production database: **read-only
access, `SELECT` only, session pinned to `default_transaction_read_only=on`.**

The pool: 416 assistant messages with `feedback.score = 1` and 140 with `score = 0` that have both
retrieval output and an answer over 200 chars. **We sample 30** — 20 positive, 10 negative — chosen
with a fixed seed and stratified by answer length so reruns are comparable. The rest of the pool
stays available if a wider run is ever wanted.

- **Extraction:** a read-only SQL script writing JSON into a gitignored local directory. This is
  customer content; it never enters the repo.
- **Runner:** one process, bounded internal concurrency (6), `--limit / --fidelity / --model`,
  JSONL results plus a summary table. Explicitly not a fan-out of worker processes.
- **Discriminative signal:** flagged-claim rate on thumbs-up vs thumbs-down answers. With 10
  negatives this indicates direction, not significance — enough to tune prompts and catch gross
  failure, not enough for a statistical claim.
- **Hand triage:** every flagged claim from the positive set, classified as *real miss the user did
  not notice* vs *false alarm*, with false alarms attributed to a stage (evidence selection,
  extraction, verifier). False-alarm rate is the number we tune down.
- **`fast` vs `paper`** on 10 of the 30: verdict agreement and cost delta. This sets the final
  batch sizes.
- **Caveat stated in the write-up:** `feedback = 1` means the user said the answer was correct, not
  that every claim is accurate; a thumbs-down may be about tone or latency. The set is a prior and
  a contrast, never ground truth. No precision/recall claims from it.

Results to `docs/superpowers/evals/2026-10-13-claim-check-baseline.md`.

## 9. Delivery order

Three stages, each independently useful, so the plan can stop at any boundary:

1. **Engine + endpoint.** `ee/claim-check/` with all stages, `POST /claims/check`, the
   `claim_check` config option in both repos, license gate, limiter, cache. Verifiable through the
   API alone, with no UI.
2. **Benchmark + tuning.** Fixture extraction, the 30-fixture run, triage, `fast` vs `paper`
   comparison, final batch sizes and thresholds, eval write-up.
3. **Chat surface.** `claimCheckMetadata`, the panel and sentence highlighting, the wizard
   verification step, the `claim_checks` table and its load path.

Stage 2 before stage 3 deliberately: the panel should not ship with thresholds nobody measured.

## 10. Out of scope

- Blocking, withholding or rewriting answers (explicitly rejected: the stream must not wait).
- The progressive stream (A2) — a follow-up spec; this response shape is designed to carry it.
- Embedding-based evidence selection.
- Per-claim retrieval for external callers (they bring their own sources).
- Claim-exact highlighting inside rendered Markdown.
- An `ExuluEval` test-case integration for continuous scoring in the evals UI.
- Fixing `suppress_duplicate_passages`' missing wizard entry — noted here because this design
  shares its failure mode, but it is a separate change.
