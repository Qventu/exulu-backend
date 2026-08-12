# Value Ledger — classifier validation against the live gateway

**Date:** 2026-08-12
**Endpoint:** Exulu LiteLLM passthrough `https://backend.ai.open.de/litellm/DEFAULT`
**Data:** 45 human session openers, June 2026, from the local production restore
**Model:** `vertex_ai/gemini-3.5-flash`

## Three defects found only by calling the real gateway

Unit tests use a fake classifier, so none of these were reachable by testing.

**1. Reasoning-token starvation (Critical).** `max_tokens: 200` with no reasoning control.
On the median real prompt (2,293 chars) Gemini 3.5 Flash spent **192 of 200 tokens on
reasoning, leaving 4 for text** — the reply truncated to ```` ```json\n{" ````, JSON.parse
failed, `classify()` returned null, session stored unclassified. Silent and indistinguishable
from low confidence: shipped as-is the panel would have read ~100% unclassified, or worse
classified only the shortest prompts and shown a biased sample as data.
Fixed `7b296ce` — `reasoning_effort: "disable"` plus `max_tokens: 512` as a backstop.

**2. Wrong auth header.** The classifier sent `Authorization: Bearer`; the Exulu passthrough
reads `exulu-api-key`/`x-api-key` (`src/validators/requests.ts`). Measured: Bearer → 401,
x-api-key → 200. Fixed `8eda409` — send both, so one code path works against the passthrough
and a direct LiteLLM proxy.

**3. The exclusion tag does not survive the passthrough (open).**
`src/exulu/routes.ts:2242` does `upstreamHeaders["x-litellm-tags"] = tags.join(",")` — an
unconditional overwrite with the caller's user/role/project tags. Our
`value_ledger_internal_classification` tag is discarded, so the classifier's own spend is
logged as ordinary usage and the report's `NOT EXISTS` exclusion never matches.
**The meter moves the meter.** Needs a decision; see below.

## Results — 45 sessions, 78s, zero parse failures

| Label | n | % |
|---|---|---|
| other | 12 | 26.7% |
| code_change | 12 | 26.7% |
| code_understanding | 5 | 11.1% |
| ops | 5 | 11.1% |
| (below 0.6 threshold) | 4 | 8.9% |
| analysis | 4 | 8.9% |
| document_drafting | 2 | 4.4% |
| data_lookup | 1 | 2.2% |

Confidence: min 0.10, median 0.90, max 1.00. Below threshold 4/45. No null results.

## Taxonomy findings

- **`other` is mostly "greeting only"** — roughly 9 of the 12. These are agentic sessions
  whose opener is "hey" with context attached; the real intent arrives in later turns.
  Classifying the *opening* message assumes the opener carries intent. True for chat, often
  false for agent sessions. This is a method limit, not a model error.
- **Three sessions look like unfiltered plumbing**: two `document_drafting` /
  "summarize conversation transcript" and one `analysis` / "analyze session transcript".
  The Task 8 filter matches `Summarize conversation chunk` and missed these variants.
- **`ui_automation` and `design_to_code` never fired** in this PHP/SugarCRM week, though the
  deterministic tool spine shows heavy Playwright and Figma use in the same month — evidence
  the sample week is not representative rather than that the categories are dead.
- Sub-labels are specific and useful ("revert code change", "add localization strings",
  "seed local database", "debug layout rendering").

## Honest note

Because of defect 3, these 45 validation calls were tagged to the worker key's user and will
appear as ordinary usage in any report covering today. Cents, but it is exactly the failure
the tag was meant to prevent.
