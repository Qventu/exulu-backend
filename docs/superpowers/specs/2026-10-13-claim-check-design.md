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

At `finish`, next to `recalledMemoriesMetadata`, a `claimCheckMetadata({ config, toolResults,
isGuest, … })` fragment carrying **ids only**:

```jsonc
{ "claimCheck": { "enabled": true, "sourceIds": ["…"], "toolCallIds": ["…"] } }
```

The client already holds the full tool output — it renders source cards from it — so re-sending
~22k tokens of evidence through metadata would be pure waste. The frontend assembles `sources[]`
from what it has. When the agent has the feature off, or the viewer is a guest/external user and
`showToExternalUsers` is false, the fragment is absent and no check ever runs.

The accumulate-then-emit pair is **one function**, `claimCheckStreamMetadata`: the chat route hands
it the turn's context once (the parsed `claim_check` config, the viewer, the pre-inlining messages,
the recall collector) and then feeds it every raw stream part. It collects each retrieval call's
final tool result — `messageMetadata` is the only hook with access to tool outputs before the
`finish` part needs them — and returns the fragment on `finish`. One function rather than two
statements 20 lines apart in a 5,000-line route factory, because this is the feature's switch and
nothing failed when it was silently broken. `pipeUIMessageStreamToResponse<ChatUIMessage>` carries
the metadata type, so the fragment's shape is checked against `ClaimCheckTrigger` rather than
against nothing.

`isGuest` is `treatAsGuest(req, user)`, not a role test: the public surface renders in guest mode
even for a signed-in internal visitor, so the surface and the role are ORed. The endpoint's own
403 applies the same OR — one product rule, two enforcement points. (Stage 3 built the role half
only and the task review caught it; recorded here because the plan, not the spec, was wrong.)

Two more gates keep the fragment from promising a check that cannot run, because the chat stream
also serves **fully anonymous** guests: no `user.id` means no fragment, whatever
`showToExternalUsers` says (`POST /claims/check` needs an id that coerces to a finite number and
answers 401 without one, and neither storage path can key a row), and an unlicensed deployment
emits nothing either (the endpoint 404s). `showToExternalUsers` serves the signed-in guest-surface
visitor and the external role, not an anonymous one.

**A fragment is emitted only when every source the answer could have drawn on is one the check
will receive.** `sourceIds` can only name knowledge-base item ids, and the frontend assembles
`sources[]` from the retrieval tool's chunks alone, so any other evidence the model was given this
turn is invisible to the check. Scoring an answer against a subset of the evidence it actually used
returns `unsupported` for claims that are in fact grounded, and `score.ts` puts `unsupported` in
the numerator of the label share — so the panel renders an **alert** for a correct answer. §2.4's
honesty invariants exist to prevent exactly that. A missing panel is the safe failure; when in
doubt between emitting and staying silent, the fragment stays absent.

The whole class, all of it suppressing in `finish-metadata.ts`:

| Invisible evidence | How it reaches the model | Attached when |
|---|---|---|
| `createSessionItemsRetrievalTool` | `{ result: JSON.stringify(array) }`, no `chunks` key | any session with knowledge items attached |
| `read_session_file` | prose from a session file | **every** session with `fileUploads.s3Bucket` configured — no agent opt-in |
| `parse_document` | extracted document text | same |
| `view_document_page` | a rendered page image | same |
| `internet_search` | web results | per agent, via its tool config |
| A document attached to the message | `processFilePartsInMessages` inlines the extracted text as a **text part of the user message** | always — "upload a PDF and ask about it" |
| A recalled memory | `memoryRecall.promptBlock`, injected into the **system prompt** | any agent with `agent.memory` |

Each tool's part type is derived from that tool's own exported display-name literal
(`tool-${sanitizeToolName(NAME)}`), never a second hardcoded spelling, so a rename fails the test
suite instead of silently turning a suppression off. For the session-items tool a **cleanly-parsed
empty array** still emits — proven empty is proven harmless — and anything else (a non-empty array,
an unparseable payload, an offloaded `{ truncated, notice, preview }` object) suppresses: "cannot
prove it empty" is not "empty". The other tools have no empty shape to prove, so presence of the
call suppresses. The attachment signal is the **pre-inlining** `file` part on a message of the
turn, which is the only marker that cannot be mistaken for text the user typed; the post-inlining
`<file file name = "…">` wrapper is ordinary text and is not used.

**The functional cost is deliberate: an agent with memory enabled and a non-empty recall produces
no claim check at all.** A false "your answer was unfounded" about a correct answer is the worst
output this system can produce, and that outweighs the panel. The real fix is coverage-aware
scoring, listed in §10 — not a narrower suppression here.

**An external viewer with `show_sources_to_external_users: false` never gets a fragment either**,
whatever `claim_check.showToExternalUsers` says: `serializeOutput` strips `item_id` from every
chunk for that viewer, so there are no source ids to send. That is the right outcome (the check
would have no evidence to verify against) but it is a consequence of the other flag, not of this
one — an admin who enables `showToExternalUsers` while sources are hidden gets silence, and that
is pinned by a test in `finish-metadata.test.ts`.

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
jsonb, `score_label`, `user`, `created_at`), written by the endpoint whenever a request names both
`session` and `messageId`. Row uniqueness is **(session, message_id, user)** and the write is an
`onConflict(...).merge()` upsert, never a delete-then-insert: a destructive statement that has to
remember to carry a user scope is a defect waiting to recur. Created through the `core-schema` /
initdb path with a column-existence guard — never a standalone migration script.

Checks are read back through **`GET /claims/check/:session`**, not alongside the session's
messages: the payload holds the answer's sentences and verbatim source quotes, so it gets one
deliberate read path, scoped to the authenticated caller in the query itself (`session` AND `user`,
never a fetch-by-session with a JS filter), and the table has no GraphQL surface at all. The chat
loads it when a session opens. (The spec originally said "returned with the session's messages";
the separate route is the better choice and this is the amendment, not a deviation.)

The same row is also consulted by the POST before any model call, so a double-fire, a re-check or a
retry is free — see §9 for what that leaves of the Redis result cache keyed by a hash of
(question, answer, sources, options, model).

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
   `claim_check` config option on the backend tool, license gate and limiter. Verifiable through
   the API alone, with no UI.

   Two items originally listed in this stage moved to stage 3 during execution; the whole-branch
   review was right to flag their absence, and both are deliberate deferrals rather than
   oversights:
   - **The Redis result cache (§5.2).** Nothing fires a check repeatedly until the chat surface
     exists, so its absence costs only a double-fire paying twice. **That rationale expired with
     stage 3, and the cheap half shipped there instead of the Redis hash:** when a POST names both
     `session` and `messageId`, the stored row is consulted first (caller-scoped, exactly as the
     GET is) and returned instead of running ~8 provider calls again — so a double-fire, a
     user-initiated re-check and a retry after a transport hiccup are all free. A lookup failure
     falls through to running the check; a cache may never break the feature it accelerates.
     The Redis hash-keyed cache (question, answer, sources, options, model) stays deferred and now
     matters only for **agent-less API callers who name no session**, who have no row to find.
   - **The frontend `claim_check` plumbing (§3).** `WizardConfig` / `parseWizardConfig` /
     `serializeWizardConfig` do not know the key yet. **Until they do, no agent may hold a
     `claim_check` key** — the next save of the knowledge-search wizard silently deletes it, the
     same failure that killed `tuning.engine: "v2"` in NEWLIFT production. The option is
     `enabled: false` by default and there is no UI to set it, so nothing can be configured
     before stage 3 lands the plumbing alongside the verification step.
2. **Benchmark + tuning.** Fixture extraction, the 30-fixture run, triage, `fast` vs `paper`
   comparison, thresholds, eval write-up.

   Two things changed in stage 1 that reshape this stage's job:

   - **The batch sizes are already chosen**, so the benchmark **validates** them rather than
     picking them. Stage 1 raised `BATCH` from `{10, 5, 3}` to `{25, 15, 8}` on a cost objection,
     which took a 30-sentence answer from 19 provider calls to 8 (measured in a test, not
     estimated). What is unmeasured is the *quality* cost of the larger batches — that is the
     question for the 30 fixtures, and the answer may be to come back down.
   - **A verbatim short-circuit was built and then removed**; do not rebuild it the same way.
     The idea is sound: when an answer sentence appears literally in a source, every claim
     decomposed from it is entailed by that source, so it needs no model call. The implementation
     tested **contiguous substring containment**, and that is the part to avoid — reviewers found
     two Critical holes in it, each marking claims `supported` with no model reading them:
     a sentence that is only the *opening half* of a longer source sentence whose continuation
     adds a condition or negates it (reachable because the splitter emits markdown bullets as
     sentences with no terminal period, and German maintenance answers are bullet-heavy), and a
     source that quotes a sentence in order to refute it (`"Viele Monteure glauben, X. Das trifft
     nicht zu."`). Tightening the left boundary to "after a terminator and a space" did not close
     the family either: an abbreviation period (`z. B.`), a list numeral (`2. `) and an ASCII
     ellipsis (`... `) all read as sentence starts.

     **If this is rebuilt, the rule is exact sentence equality**: segment each source with
     `split.ts`'s own segmenter — the ICU segmentation plus the abbreviation suppression that
     already exist and are tested — and require the answer sentence to **equal** one of the
     source's sentences. That removes the boundary arithmetic the holes lived in.

     It was removed rather than fixed because the arithmetic does not support the risk: the whole
     19→8 saving comes from the batch sizes, the short-circuit's own contribution is 8→4 and only
     when every sentence is quoted, and its measured hit rate by source shape was 30/30 on prose,
     30/30 on numbered lists and **0/30 on markdown lists** — the shape a tenant KB of checklists
     and PDFs actually has. **Measure the hit rate on the 30 fixtures before building anything**;
     if it is near zero on real documents, the mechanism does not earn its place.
3. **Chat surface.** `claimCheckMetadata`, the panel and sentence highlighting, the wizard
   verification step **plus the `claim_check` serialisation plumbing moved from stage 1**, the
   Redis result cache (§5.2), the `claim_checks` table and its load path.

Stage 2 before stage 3 deliberately: the panel should not ship with thresholds nobody measured, and the cost work above should not be re-litigated without the fixtures to
settle it.

## 10. Out of scope

- Blocking, withholding or rewriting answers (explicitly rejected: the stream must not wait).
- The progressive stream (A2) — a follow-up spec; this response shape is designed to carry it.
- Embedding-based evidence selection.
- Per-claim retrieval for external callers (they bring their own sources).
- Claim-exact highlighting inside rendered Markdown.
- **In-body sentence highlighting, deferred with a measurement (Stage 3).** Two premises had to hold
  for whole-answer offsets to land on the rendered answer. The first holds: `streamdown`'s
  `parseMarkdownIntoBlocks` is lossless (`join("") === input`) across German text, lists, fenced
  code, tables and runs of blank lines — measured, and pinned by a test. The second does not:
  `message-renderer.tsx` renders **each text part through its own `Response` call** rather than the
  joined answer, and mutates the text first — stripping `<file>` tags and replacing citation-shaped
  blobs with `<cite-marker-*>` elements. So the rendered string is not character-identical to the
  string the backend segmented, and highlights would drift. The offset-mapping utility
  (`claim-check-highlight.ts`) is built and tested but deliberately **not wired**; wiring it needs a
  second measurement first (is the rendered string still character-identical to `answerTextOf`?) or
  a renderer that renders the joined answer once. The panel lists every claim with its evidence
  quote, so the feature is complete without this.
- An `ExuluEval` test-case integration for continuous scoring in the evals UI.
- **Evidence the fragment cannot represent, as claim-check evidence.** The whole class in §5's
  table: session-attached items, `read_session_file`, `parse_document`, `view_document_page`,
  `internet_search`, a document attached to the message, and a recalled memory. Each would need an
  output-shape (or prompt-block) handler in `finish-metadata.ts` **and** in the frontend's
  `collectSources` before it could be sent as a source; until then a turn that used any of them is
  suppressed rather than checked against partial evidence (see §5).
- **Coverage-aware scoring — the real fix for the above, and the one that would let those turns be
  checked again.** Today a claim whose evidence set could not include a source the answer used is
  scored as if the sources were complete, which is what makes a partial fragment dangerous and
  forces the all-or-nothing suppression. The rule: when the evidence given to the check is known to
  be incomplete for a claim, its label must be `n/a` with a stated reason — never `warn` or
  `alert`. That is an engine change plus a §2.4 amendment (a fourth honesty rule beside the three
  there), not a chat-surface change, so it is out of scope for the stage-3 branch that found this.
- Fixing `suppress_duplicate_passages`' missing wizard entry — noted here because this design
  shares its failure mode, but it is a separate change.
