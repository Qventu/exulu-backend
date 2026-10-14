// ee/claim-check/run.ts
//
// Orchestration. Everything about cost and provider fragility lives here:
// batching (spec §2.3), bounded fan-out, one bisect per failed batch, a stage
// circuit breaker, and the caps that turn a huge answer into a partial result
// instead of a failure.
import type { LanguageModel } from "ai";
import {
  CLAIM_CHECK_DEFAULTS,
  type Claim,
  type ClaimCheckOptions,
  type ClaimCheckResult,
  type ClaimCheckSource,
  type DisambiguationOutcome,
  type EvidenceSnippet,
  type SelectionOutcome,
  type Sentence,
  type SentenceState,
  type SentenceWindow,
} from "./types";
import { buildWindows, localeFromText, splitIntoSentences } from "./split";
import {
  indexSourcesWithLimits,
  MAX_CHARS_PER_SOURCE,
  selectEvidence,
  type IndexedPassage,
  type SourceTruncation,
} from "./evidence";
import { runSelectAndDisambiguate } from "./stages/select-disambiguate";
import { runSelection } from "./stages/select";
import { runDisambiguation } from "./stages/disambiguate";
import { runDecomposition } from "./stages/decompose";
import { runVerification } from "./stages/verify";
import { scoreClaims, buildSentenceResults } from "./score";
import { addUsage, EMPTY_USAGE, type StageUsage } from "./stages/usage";
import { mapWithConcurrency } from "./concurrency";

export const BATCH = { selectDisambiguate: 10, decompose: 5, verifySentences: 3 };
/**
 * Evidence selection is a PER-CLAIM job (spec §2.2): score the passages for
 * one claim and take its best few. Pooling a whole verification group's claim
 * texts into one query starved the weaker-scoring claims — six to ten claims
 * shared four snippets — and the failure mode is a false "unsupported".
 */
export const EVIDENCE_PER_CLAIM = 3;
/** Ceiling on the union, so a group of ten claims cannot blow up one prompt. */
export const MAX_EVIDENCE_PER_CALL = 12;
export const MAX_IN_FLIGHT = 6;
export const STAGE_FAILURE_ABORT = 0.4;
/** Paper §D: 3 completions, 2 successes required, for Selection and Disambiguation. */
const MIN_SUCCESS_RATIO = 2 / 3;

const chunk = <T,>(items: T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
};

type StageState = {
  usage: StageUsage;
  notes: string[];
  states: Map<number, { state: SentenceState; reason?: string }>;
  partial: boolean;
};

/**
 * Run one batched stage over all batches with bounded concurrency. A rejected
 * batch is split in half and each half retried once, so a single bad call
 * costs 2-3 sentences instead of 10. Above STAGE_FAILURE_ABORT the stage stops
 * reporting and the caller degrades to a partial result.
 */
async function runBatched<R>(
  batches: SentenceWindow[][],
  label: string,
  state: StageState,
  call: (windows: SentenceWindow[]) => Promise<{ result: R; usage: StageUsage }>,
): Promise<R[]> {
  const settled = await mapWithConcurrency(batches, MAX_IN_FLIGHT, async (windows) => call(windows));
  const good: R[] = [];
  const retryable: SentenceWindow[][] = [];
  let failures = 0;

  settled.forEach((outcome, i) => {
    if (outcome.status === "fulfilled") {
      good.push(outcome.value.result);
      state.usage = addUsage(state.usage, outcome.value.usage);
      return;
    }
    failures += 1;
    const batch = batches[i]!;
    if (batch.length > 1) {
      const mid = Math.ceil(batch.length / 2);
      retryable.push(batch.slice(0, mid), batch.slice(mid));
    } else {
      markNotChecked(state, batch, `${label} failed for this sentence`);
    }
  });

  // A single failure is never systemic: it must get its bisect (that is the
  // point of bisect-once). The breaker exists for a provider failing broadly,
  // which takes at least two observed failures to establish.
  if (failures >= 2 && failures / batches.length > STAGE_FAILURE_ABORT) {
    state.partial = true;
    state.notes.push(
      `${label}: aborted after ${failures} of ${batches.length} calls failed; remaining sentences are not_checked`,
    );
    for (const batch of retryable) markNotChecked(state, batch, `${label} aborted`);
    return good;
  }

  if (retryable.length > 0) {
    const retried = await mapWithConcurrency(retryable, MAX_IN_FLIGHT, async (windows) => call(windows));
    retried.forEach((outcome, i) => {
      if (outcome.status === "fulfilled") {
        good.push(outcome.value.result);
        state.usage = addUsage(state.usage, outcome.value.usage);
      } else {
        markNotChecked(state, retryable[i]!, `${label} failed after bisect`);
      }
    });
  }

  return good;
}

/**
 * Per-claim selection, unioned and deduplicated by passage identity
 * (sourceId + text, which is what makes a passage the same passage; a source
 * id alone is not unique — a document is many passages).
 *
 * Filled by RANK, not by claim: every claim's best snippet lands before any
 * claim's second, so the ceiling cuts extra context rather than cutting a
 * claim's only supporting passage.
 */
export function selectGroupEvidence(claimTexts: string[], passages: IndexedPassage[]): EvidenceSnippet[] {
  const perClaim = claimTexts.map((text) => selectEvidence([text], passages, EVIDENCE_PER_CLAIM));
  const union: EvidenceSnippet[] = [];
  const seen = new Set<string>();

  for (let rank = 0; rank < EVIDENCE_PER_CLAIM; rank += 1) {
    for (const snippets of perClaim) {
      const snippet = snippets[rank];
      if (!snippet) continue;
      const key = `${snippet.sourceId}\u0000${snippet.text}`;
      if (seen.has(key)) continue;
      seen.add(key);
      union.push(snippet);
      if (union.length >= MAX_EVIDENCE_PER_CALL) return union;
    }
  }

  return union;
}

function markNotChecked(state: StageState, windows: SentenceWindow[], reason: string): void {
  state.partial = true;
  state.notes.push(`${windows.length} sentence(s) marked not_checked: ${reason}`);
  for (const w of windows) {
    if (!state.states.has(w.sentence.index)) {
      state.states.set(w.sentence.index, { state: "not_checked", reason });
    }
  }
}

/** Majority voting for paper fidelity: a sentence advances when at least 2 of 3 runs agree. */
function vote<T extends { index: number }>(
  runs: T[][],
  passes: (outcome: T) => boolean,
  completions: number,
): Map<number, { passed: boolean; sample: T }> {
  const byIndex = new Map<number, T[]>();
  for (const run of runs) {
    for (const outcome of run) {
      const list = byIndex.get(outcome.index) ?? [];
      list.push(outcome);
      byIndex.set(outcome.index, list);
    }
  }
  const required = Math.max(1, Math.ceil(completions * MIN_SUCCESS_RATIO));
  const voted = new Map<number, { passed: boolean; sample: T }>();
  for (const [index, outcomes] of byIndex) {
    const successes = outcomes.filter(passes);
    voted.set(index, {
      passed: successes.length >= required,
      sample: successes[0] ?? outcomes[0]!,
    });
  }
  return voted;
}

export async function runClaimCheck(args: {
  question: string;
  answer: string;
  sources: ClaimCheckSource[];
  model: LanguageModel;
  options?: ClaimCheckOptions;
  locale?: string;
  /** Supplied only for IMP callers with an agent scope (Task 13). */
  secondChance?: (claimText: string) => Promise<EvidenceSnippet[]>;
  /**
   * The HTTP handler's 60 s deadline (spec §4). Threaded to every provider
   * call so a hung provider is cancelled instead of holding one of the twenty
   * global in-flight slots until the transport gives up.
   */
  signal?: AbortSignal;
}): Promise<ClaimCheckResult> {
  const options = args.options ?? CLAIM_CHECK_DEFAULTS;
  const startedAt = Date.now();
  const timings: Record<string, number> = {};
  const lap = (name: string, from: number) => {
    timings[name] = Date.now() - from;
  };

  const state: StageState = { usage: { ...EMPTY_USAGE }, notes: [], states: new Map(), partial: false };
  // Hoisted so a failure anywhere past the split stage can still report
  // whatever was already determined, instead of losing it to the catch below.
  let allSentences: Sentence[] = [];
  let skipped: Sentence[] = [];
  // Finding 5: evidence past MAX_CHARS_PER_SOURCE is never searched, so what
  // was dropped has to reach `limits` and `notes` on every return path,
  // including the catch below.
  let truncation: SourceTruncation = { sources: 0, droppedChars: 0 };

  try {
    const locale = args.locale ?? localeFromText(args.answer);

    // ── Split ──────────────────────────────────────────────────────────────
    let tStage = Date.now();
    allSentences = splitIntoSentences(args.answer, locale);
    const sentences = allSentences.slice(0, options.caps.maxSentences);
    skipped = allSentences.slice(options.caps.maxSentences);
    for (const s of skipped) state.states.set(s.index, { state: "not_checked", reason: "cap_exceeded" });
    if (skipped.length > 0) {
      state.partial = true;
      state.notes.push(`maxSentences (${options.caps.maxSentences}) reached; ${skipped.length} sentence(s) not checked`);
    }
    lap("splitMs", tStage);

    // ── Selection + Disambiguation ─────────────────────────────────────────
    tStage = Date.now();
    const selectWindows = buildWindows(sentences, 5, 5);
    const laterWindows = new Map(buildWindows(sentences, 5, 0).map((w) => [w.sentence.index, w]));
    // Spec §2.3: paper fidelity "restores one sentence per call". Batching it
    // the same way as the fast path made §8's fast-vs-paper comparison — the
    // thing that is supposed to SET the final batch sizes — unable to answer
    // that question, because both arms batched identically.
    const paper = options.fidelity === "paper";
    // Only paper votes, so `completions` outside it bought nothing except a
    // raised temperature (0.2) — strictly less determinism for the same single
    // call per batch.
    const completions = paper ? options.completions : 1;
    const temperature = completions > 1 ? 0.2 : 0;
    const selectBatchSize = paper ? 1 : BATCH.selectDisambiguate;
    const decomposeBatchSize = paper ? 1 : BATCH.decompose;
    const batches = chunk(selectWindows, selectBatchSize);

    const selection: SelectionOutcome[] = [];
    const disambiguation: DisambiguationOutcome[] = [];

    if (paper) {
      const selectionRuns: SelectionOutcome[][] = [];
      for (let run = 0; run < completions; run += 1) {
        const results = await runBatched(batches, "selection", state, async (windows) => {
          const { outcomes, usage } = await runSelection({
            windows, question: args.question, model: args.model, temperature, ...(args.signal ? { signal: args.signal } : {}),
          });
          return { result: outcomes, usage };
        });
        selectionRuns.push(results.flat());
      }
      const selectionVote = vote(selectionRuns, (o) => o.verifiable, completions);
      for (const [index, { passed, sample }] of selectionVote) {
        selection.push({ ...sample, index, verifiable: passed });
      }

      const survivors = selection.filter((s) => s.verifiable).map((s) => laterWindows.get(s.index)!).filter(Boolean);
      // Correction 1: this map is built from the GLOBAL selection array above
      // (every sentence that has a rewrite), not from one batch's slice of it —
      // a window's preceding/following sentences routinely belong to other
      // batches, and excerptFor substitutes by index across the whole window.
      const texts = new Map(selection.filter((s) => s.rewritten).map((s) => [s.index, s.rewritten!]));
      const disambiguationRuns: DisambiguationOutcome[][] = [];
      for (let run = 0; run < completions; run += 1) {
        const results = await runBatched(chunk(survivors, selectBatchSize), "disambiguation", state, async (windows) => {
          const { outcomes, usage } = await runDisambiguation({
            windows, question: args.question, sentenceTexts: texts, model: args.model, temperature,
            ...(args.signal ? { signal: args.signal } : {}),
          });
          return { result: outcomes, usage };
        });
        disambiguationRuns.push(results.flat());
      }
      const disambiguationVote = vote(disambiguationRuns, (o) => o.resolvable, completions);
      for (const [index, { passed, sample }] of disambiguationVote) {
        disambiguation.push({ ...sample, index, resolvable: passed });
      }
    } else {
      const merged = await runBatched(batches, "selection+disambiguation", state, async (windows) => {
        const out = await runSelectAndDisambiguate({
          windows, question: args.question, model: args.model, temperature, ...(args.signal ? { signal: args.signal } : {}),
        });
        return { result: { selection: out.selection, disambiguation: out.disambiguation }, usage: out.usage };
      });
      for (const part of merged) {
        selection.push(...part.selection);
        disambiguation.push(...part.disambiguation);
      }
    }
    lap("selectDisambiguateMs", tStage);

    // Record the states these two stages decided.
    const selectionByIndex = new Map(selection.map((s) => [s.index, s]));
    const disambiguationByIndex = new Map(disambiguation.map((d) => [d.index, d]));
    const survivingIndexes: number[] = [];
    // Finding 4: a sentence the model never answered for is NOT the finding
    // "this sentence asserts nothing checkable" (no_verifiable_content) — that
    // would tell the user something about their text that nobody judged. The
    // stages set `answered: false` for exactly this case, so the two are
    // distinguishable here without matching on reason strings.
    const unanswered: number[] = [];
    for (const sentence of sentences) {
      const sel = selectionByIndex.get(sentence.index);
      const dis = disambiguationByIndex.get(sentence.index);
      if (!sel) continue; // not_checked was already recorded by runBatched
      if (sel.answered === false) {
        state.states.set(sentence.index, { state: "not_checked", reason: sel.reason });
        unanswered.push(sentence.index);
        continue;
      }
      if (!sel.verifiable) {
        state.states.set(sentence.index, { state: "no_verifiable_content", reason: sel.reason });
        continue;
      }
      if (dis?.answered === false) {
        state.states.set(sentence.index, { state: "not_checked", reason: dis.reason });
        unanswered.push(sentence.index);
        continue;
      }
      if (!dis?.resolvable) {
        state.states.set(sentence.index, {
          state: "cannot_disambiguate",
          reason: dis?.reason ?? "disambiguation did not report an outcome",
        });
        continue;
      }
      state.states.set(sentence.index, { state: "checked" });
      survivingIndexes.push(sentence.index);
    }
    if (unanswered.length > 0) {
      state.partial = true;
      state.notes.push(
        `selection/disambiguation returned no outcome for ${unanswered.length} sentence(s); they are not_checked`,
      );
    }

    // ── Decomposition ────────────────────────────────────────────────────────
    tStage = Date.now();
    const claims: Claim[] = [];
    if (survivingIndexes.length > 0) {
      // Correction 1: built from every surviving sentence, globally — same
      // reasoning as the `texts` map above.
      const decomposeTexts = new Map<number, string>();
      for (const index of survivingIndexes) {
        const clarified = disambiguationByIndex.get(index)?.clarified;
        const rewritten = selectionByIndex.get(index)?.rewritten;
        const text = clarified ?? rewritten;
        if (text) decomposeTexts.set(index, text);
      }
      const survivorWindows = survivingIndexes.map((i) => laterWindows.get(i)!).filter(Boolean);
      const decomposed = await runBatched(chunk(survivorWindows, decomposeBatchSize), "decomposition", state, async (windows) => {
        const { outcomes, usage } = await runDecomposition({
          windows, question: args.question, sentenceTexts: decomposeTexts, model: args.model, temperature: 0,
          ...(args.signal ? { signal: args.signal } : {}),
        });
        return { result: outcomes, usage };
      });

      const allowed = new Set(survivingIndexes);
      const flat = decomposed.flat().filter((o) => allowed.has(o.index)).sort((a, b) => a.index - b.index);
      // Finding 4: a sentence whose decomposition DID produce claims, but every
      // one of them landed past the maxClaims cap, must read as a resource cap
      // (cap_exceeded) — not as "decomposition found nothing to verify here",
      // which is what no_verifiable_content means.
      const capCutSentences = new Set<number>();
      for (const outcome of flat) {
        let pushedForThisOutcome = 0;
        for (const c of outcome.claims) {
          if (claims.length >= options.caps.maxClaims) break;
          claims.push({
            id: `c${claims.length + 1}`,
            sentenceIndex: outcome.index,
            text: c.text,
            inferred: c.inferred,
            verdict: "unsupported",
            evidence: [],
            rationale: "",
            rechecked: false,
          });
          pushedForThisOutcome += 1;
        }
        if (outcome.claims.length > 0 && pushedForThisOutcome === 0) {
          capCutSentences.add(outcome.index);
        }
      }
      const produced = flat.reduce((n, o) => n + o.claims.length, 0);
      if (produced > claims.length) {
        state.partial = true;
        state.notes.push(`maxClaims (${options.caps.maxClaims}) reached; ${produced - claims.length} claim(s) dropped`);
      }

      // Correction 2: a sentence decomposition REPORTED ON but found no claim in
      // ("no_verifiable_content") is a different fact from a sentence it never
      // answered for at all ("not_checked") — runDecomposition omits an entry
      // entirely in the latter case, so the two are distinguishable here, and a
      // reader deserves to know which one happened.
      const outcomeIndexes = new Set(flat.map((o) => o.index));
      const withClaims = new Set(claims.map((c) => c.sentenceIndex));
      const missingOutcome: number[] = [];
      for (const index of survivingIndexes) {
        if (withClaims.has(index)) continue;
        if (capCutSentences.has(index)) {
          state.states.set(index, { state: "not_checked", reason: "cap_exceeded" });
        } else if (outcomeIndexes.has(index)) {
          state.states.set(index, { state: "no_verifiable_content", reason: "decomposition extracted no claim" });
        } else {
          state.states.set(index, { state: "not_checked", reason: "decomposition did not report an outcome" });
          missingOutcome.push(index);
        }
      }
      if (missingOutcome.length > 0) {
        state.partial = true;
        state.notes.push(`decomposition did not report an outcome for ${missingOutcome.length} sentence(s)`);
      }
    }
    lap("decomposeMs", tStage);

    // ── Evidence + Verification ──────────────────────────────────────────────
    tStage = Date.now();
    const indexed = indexSourcesWithLimits(args.sources);
    const passages = indexed.passages;
    truncation = indexed.truncation;
    if (truncation.sources > 0) {
      state.notes.push(
        `${truncation.sources} source(s) were truncated at ${MAX_CHARS_PER_SOURCE} characters; ` +
          `${truncation.droppedChars} character(s) of evidence were not searched, so a claim supported only there reads as unsupported`,
      );
    }
    lap("evidenceMs", tStage);

    tStage = Date.now();
    // Correction 3: a verification group whose CALL FAILED must not leave its
    // claims standing as "unsupported" — that reports a provider outage as a
    // coverage gap in the customer's sources. Those claims are dropped from the
    // result entirely (never reaching scoreClaims), and their sentences become
    // not_checked instead.
    let finalClaims: Claim[] = claims;
    if (claims.length > 0) {
      const bySentence = new Map<number, Claim[]>();
      for (const claim of claims) {
        const list = bySentence.get(claim.sentenceIndex) ?? [];
        list.push(claim);
        bySentence.set(claim.sentenceIndex, list);
      }
      const groups = chunk([...bySentence.values()], BATCH.verifySentences).map((g) => g.flat());

      const verified = await mapWithConcurrency(groups, MAX_IN_FLIGHT, async (group) => {
        const evidence = selectGroupEvidence(group.map((c) => c.text), passages);
        return runVerification({
          claims: group.map((c) => ({ id: c.id, text: c.text })),
          evidence,
          model: args.model,
          ...(args.signal ? { signal: args.signal } : {}),
        });
      });

      const droppedClaimIds = new Set<string>();
      const byId = new Map(claims.map((c) => [c.id, c]));
      verified.forEach((outcome, i) => {
        const group = groups[i]!;
        if (outcome.status !== "fulfilled") {
          state.partial = true;
          state.notes.push(`verification failed for ${group.length} claim(s); they were dropped from the result`);
          const sentenceIndexes = new Set(group.map((c) => c.sentenceIndex));
          for (const c of group) droppedClaimIds.add(c.id);
          for (const index of sentenceIndexes) {
            state.states.set(index, { state: "not_checked", reason: "verification failed for this sentence" });
          }
          return;
        }
        state.usage = addUsage(state.usage, outcome.value.usage);
        for (const verdict of outcome.value.outcomes) {
          const claim = byId.get(verdict.claimId);
          if (!claim) continue;
          claim.verdict = verdict.verdict;
          claim.evidence = verdict.evidence;
          claim.rationale = verdict.rationale;
        }

        // Finding 4: the call succeeded but the model left claims out of its
        // array. Those claims carry no verdict anybody produced, so they are
        // dropped like the claims of a failed call — never reported
        // "unsupported", which would inflate the share with the model's
        // silence. A sentence whose every claim was dropped was not checked.
        const answered = new Set(outcome.value.outcomes.map((o) => o.claimId));
        const missing = group.filter((c) => !answered.has(c.id));
        if (missing.length === 0) return;
        state.partial = true;
        state.notes.push(
          `verification returned no verdict for ${missing.length} claim(s); they were dropped from the result`,
        );
        for (const c of missing) droppedClaimIds.add(c.id);
        const groupSentences = new Map<number, Claim[]>();
        for (const c of group) {
          const list = groupSentences.get(c.sentenceIndex) ?? [];
          list.push(c);
          groupSentences.set(c.sentenceIndex, list);
        }
        for (const [index, list] of groupSentences) {
          if (list.every((c) => droppedClaimIds.has(c.id))) {
            state.states.set(index, {
              state: "not_checked",
              reason: "verification returned no verdict for this sentence",
            });
          }
        }
      });

      finalClaims = droppedClaimIds.size > 0 ? claims.filter((c) => !droppedClaimIds.has(c.id)) : claims;

      // ── Second chance for unsupported claims (IMP callers only) ────────────
      if (options.reRetrieve && args.secondChance && options.caps.maxReRetrievals > 0) {
        const candidates = finalClaims.filter((c) => c.verdict === "unsupported");
        const budget = candidates.slice(0, options.caps.maxReRetrievals);
        if (candidates.length > budget.length) {
          state.notes.push(
            `maxReRetrievals (${options.caps.maxReRetrievals}) reached; ${candidates.length - budget.length} unsupported claim(s) were not re-retrieved`,
          );
        }
        await mapWithConcurrency(budget, MAX_IN_FLIGHT, async (claim) => {
          try {
            const extra = await args.secondChance!(claim.text);
            if (extra.length === 0) return;
            const { outcomes, usage } = await runVerification({
              claims: [{ id: claim.id, text: claim.text }],
              evidence: extra,
              model: args.model,
              ...(args.signal ? { signal: args.signal } : {}),
            });
            state.usage = addUsage(state.usage, usage);
            const verdict = outcomes[0];
            if (!verdict) return;
            claim.rechecked = true;
            claim.verdict = verdict.verdict;
            claim.evidence = verdict.evidence;
            claim.rationale = verdict.rationale;
          } catch {
            // A failed second chance leaves the first verdict standing.
            state.notes.push(`second-chance retrieval failed for ${claim.id}`);
          }
        });
      }
    }
    lap("verifyMs", tStage);

    // Finding 3 (spec §2.4 rule 3): with no usable passage at all, every claim
    // lands in verification's no-evidence branch and the result would read
    // "100% unsupported, status ok" — a confident hallucination verdict
    // produced without a byte of evidence having been read. Only claims that
    // WERE judged against evidence can carry a score; when a second-chance
    // retrieval supplied passages for some of them, those still count, and
    // when nothing was read at all this is scoreClaims([]) → label "n/a".
    const scorable = passages.length === 0 ? finalClaims.filter((c) => c.rechecked) : finalClaims;
    const unread = finalClaims.length - scorable.length;
    if (unread > 0) {
      state.partial = true;
      state.notes.push(
        `no usable evidence was supplied: ${unread} claim(s) are reported unsupported without any source having been read, and are excluded from the score`,
      );
    }

    timings.totalMs = Date.now() - startedAt;

    return {
      status: state.partial ? "partial" : "ok",
      score: scoreClaims(scorable, options.thresholds),
      sentences: buildSentenceResults(allSentences, state.states, finalClaims),
      claims: finalClaims,
      usage: state.usage,
      timings,
      limits: { truncated: skipped.length > 0 || truncation.sources > 0, sentencesSkipped: skipped.length },
      notes: state.notes,
    };
  } catch (err) {
    // "Partial beats failing": an uncaught error anywhere in the pipeline
    // (provider calls are already isolated per-call by mapWithConcurrency, so
    // this is for something like a bug in split/evidence/score) degrades to a
    // partial result instead of rejecting the caller's promise. The note
    // carries the error forward rather than swallowing it.
    timings.totalMs = Date.now() - startedAt;
    const message = err instanceof Error ? err.message : String(err);
    return {
      status: "partial",
      score: scoreClaims([], options.thresholds),
      sentences: buildSentenceResults(allSentences, state.states, []),
      claims: [],
      usage: state.usage,
      timings,
      limits: { truncated: skipped.length > 0 || truncation.sources > 0, sentencesSkipped: skipped.length },
      notes: [...state.notes, `claim check failed internally: ${message}`],
    };
  }
}
