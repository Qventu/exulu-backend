// ee/claim-check/routes.ts
//
// POST /claims/check. The payload is trusted on purpose (spec decision 4):
// the endpoint is a product for clients who bring their own sources and never
// touch an IMP knowledge base. What that buys in reach it pays for in abuse
// surface, so every guard here is load-bearing.
import type { Express, Request, Response } from "express";
import { z } from "zod";
import type { LanguageModel } from "ai";
import type { User } from "@EXULU_TYPES/models/user";
import type { ScopeCheckResult } from "@SRC/utils/check-api-key-scope";
import { isExternalOrAnonymousUser } from "@SRC/exulu/resolve-max-steps";
import { treatAsGuest } from "@SRC/exulu/public-surface";
import { type ClaimCheckOptions, type ClaimCheckResult, type ClaimCheckSource, type ClaimCheckSourceType } from "./types";
import type { ClaimCheckRateLimiter } from "./rate-limit";
import { pipelineConfigFor } from "./agent-config";

export const CLAIM_CHECK_PATH = "/claims/check";
export const CLAIM_CHECK_SESSION_PATH = "/claims/check/:session";

/** Rejects anything that is not a v4-shaped uuid before the database sees it. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `auth.user.id` must not just be truthy, it must coerce to a finite number:
 * the `claim_checks.user` column is a float, knex keeps a `NaN` binding alive
 * rather than dropping it, `pg` sends it as the literal string `"NaN"`, and
 * Postgres evaluates `NaN = NaN` as true — so a future auth path that ever
 * produced a truthy non-numeric principal id would read and write one shared
 * bucket instead of erroring. Not reachable today (every auth branch yields a
 * numeric id); this is a guard against that never happening, not a fix for a
 * live bug.
 */
function hasNumericUserId(user: { id?: unknown } | undefined): boolean {
  return Boolean(user?.id) && Number.isFinite(Number(user?.id));
}

/**
 * The status for a request that failed the gate above.
 *
 * `auth.code` describes the authentication ATTEMPT, not this gate: when a
 * principal came back but its id is unusable, the attempt may well have
 * "succeeded" (`code: 200`, or a `0` a future branch might leave unset), and
 * echoing that would answer a 200 — or a nonsensical 0 — with an
 * "Unauthorized." body. A principal we refuse to key a row by is a 401,
 * whatever the attempt said. Only a genuine auth failure's own code (403 on a
 * disabled key, say) is passed through.
 */
function unauthorizedStatus(auth: { user?: unknown; code?: number }): number {
  if (auth.user) return 401;
  return (auth.code ?? 0) || 401;
}

/** Payload caps: an answer is prose, evidence is documents. Beyond these, 413. */
const MAX_ANSWER_CHARS = 200_000;
const MAX_EVIDENCE_CHARS = 2_000_000;
const MAX_SOURCES = 200;

/**
 * Request deadline (spec §4). Without it, a hung provider holds one of the 20
 * global in-flight slots until the transport gives up, and twenty such
 * requests 429 the endpoint deployment-wide. The engine races a timer: the
 * signal cancels the provider calls, the slot is released either way, and the
 * caller gets a 504 rather than an open socket.
 *
 * This is the fallback default, and stays the module's own ceiling when
 * `CLAIM_CHECK_TIMEOUT_MS` is unset or unusable — see
 * `resolveClaimCheckTimeoutMs` below, which is what the handler actually
 * races against.
 */
export const CLAIM_CHECK_TIMEOUT_MS = 60_000;

/**
 * `CLAIM_CHECK_TIMEOUT_MS` the env var, read fresh per request (not cached at
 * module load) so a deployment can raise it without a restart of this
 * module's test doubles, and so the garbage-value fallback below is testable
 * without re-importing the module. Parsed defensively: an operator raising
 * `claim_check.caps.maxSentences` without raising this would otherwise spend
 * hundreds of provider calls and still get a 504, which is strictly worse
 * than the cap's own "partial" degradation — so a non-numeric or
 * non-positive value falls back to the default rather than disabling the
 * deadline (e.g. turning it into `NaN`, which never fires).
 */
export function resolveClaimCheckTimeoutMs(): number {
  const raw = process.env.CLAIM_CHECK_TIMEOUT_MS;
  if (raw === undefined) return CLAIM_CHECK_TIMEOUT_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : CLAIM_CHECK_TIMEOUT_MS;
}

/** Thrown by the deadline race only, so the catch can tell 504 from 500. */
class ClaimCheckTimeoutError extends Error {}

/**
 * A locale the engine can actually segment with. An unusable tag used to reach
 * `new Intl.Segmenter` inside the engine and throw into its outer catch, so
 * garbage produced 200 + an empty partial result instead of §4's 400.
 */
function localeIsUsable(locale: string): boolean {
  try {
    new Intl.Segmenter(locale, { granularity: "sentence" });
    return true;
  } catch {
    return false;
  }
}

/**
 * requested ?? configured, floored by the configured value.
 *
 * A request can only ever TIGHTEN a cap, so an authenticated non-admin cannot
 * buy itself thousands of provider calls and thousands of full retrievals by
 * posting a bigger number. There is deliberately no absolute module ceiling on
 * top (ruling R33): a ceiling clamps the OPERATOR's own configured value too,
 * which is how a 44,000-character NEWLIFT answer (568 sentences after list
 * segmentation) ended up 21% checked with no configuration path to raise it.
 * An operator configuring their own agent is trusted, because they pay for it,
 * as with every other retrieval knob. `configured` comes from the agent's
 * `claim_check.caps`, whose schema defaults are CLAIM_CHECK_DEFAULTS.caps — so
 * the agent-less caller still gets the engine defaults, from one definition.
 */
function clampCap(requested: number | undefined, configured: number): number {
  return Math.min(requested ?? configured, configured);
}

/**
 * Spelled once, derived from the one declaration of `ClaimCheckSourceType`
 * (./types) rather than re-spelled here: `satisfies` below catches an entry
 * that is not a member of that union, and the type-level check right after
 * catches the opposite drift — a union member missing from this array. Two
 * independently hand-spelled lists would drift silently the day a seventh
 * type is added there: the enum would just reject a type the rest of the
 * system emits, with no compile error pointing at why.
 */
const SOURCE_TYPES = [
  "knowledge_base",
  "document",
  "memory",
  "web",
  "session_item",
  "other",
] as const satisfies readonly ClaimCheckSourceType[];
type _SourceTypesCoverTheWholeUnion = ClaimCheckSourceType extends (typeof SOURCE_TYPES)[number] ? true : never;
const _sourceTypesCoverTheWholeUnion: _SourceTypesCoverTheWholeUnion = true;

const requestSchema = z.object({
  question: z.string().min(1),
  answer: z.string().min(1),
  sources: z
    .array(
      z.object({
        content: z.string(),
        name: z.string().optional(),
        // Accepted, and deliberately dropped before the engine sees it — see
        // assignSourceIds below. Validated here anyway so a caller gets a 400
        // naming the bad value instead of the field being silently ignored.
        type: z.enum(SOURCE_TYPES).optional(),
        id: z.string().min(1).optional(),
      }),
    )
    .default([]),
  agent: z.string().optional(),
  session: z.string().optional(),
  messageId: z.string().optional(),
  model: z.string().optional(),
  locale: z
    .string()
    .refine(localeIsUsable, { message: "locale is not a usable BCP 47 language tag" })
    .optional(),
  options: z
    .object({
      fidelity: z.enum(["fast", "paper"]).optional(),
      completions: z.number().int().min(1).max(3).optional(),
      reRetrieve: z.boolean().optional(),
      thresholds: z.object({ warn: z.number().min(0).max(1), alert: z.number().min(0).max(1) }).partial().optional(),
      caps: z
        .object({
          maxSentences: z.number().int().positive(),
          maxClaims: z.number().int().positive(),
          maxReRetrievals: z.number().int().min(0),
        })
        .partial()
        .optional(),
    })
    .optional(),
});

type RequestSource = { content: string; name?: string; type?: ClaimCheckSourceType; id?: string };

/**
 * One id per source, because `evidence[].sourceId` has to resolve to exactly
 * one document. A caller may supply ids for some sources, none, or all — so a
 * generated id gets `_` suffixes until it stops colliding with a supplied
 * one, and two sources supplying the SAME id are refused outright: an
 * evidence quote that cannot be traced to exactly one document is worse than
 * a rejected request, since the panel shows a quote to a reader as the
 * justification for a verdict.
 *
 * `type` is accepted on the request (spec §3-4: it lets a UI label and group
 * sources, and makes a request self-describing in a log) and deliberately
 * dropped right here, before the engine ever sees a source. The engine
 * (run.ts, evidence.ts) treats every source identically regardless of where
 * it came from — spec §2 rejects trust tiers, so a web page and a
 * knowledge-base document carry the same evidentiary weight. Do not thread
 * this field through to the engine "to not lose it": the engine's source
 * type is `{ id, name?, content }` on purpose, and stays that way.
 */
function assignSourceIds(
  sources: RequestSource[],
): { ok: true; sources: ClaimCheckSource[] } | { ok: false; detail: string } {
  const supplied = new Set<string>();
  for (const s of sources) {
    if (!s.id) continue;
    if (supplied.has(s.id)) return { ok: false, detail: `duplicate source id "${s.id}"` };
    supplied.add(s.id);
  }
  const used = new Set(supplied);
  return {
    ok: true,
    sources: sources.map((s, i) => {
      let id = s.id;
      if (!id) {
        id = `s${i + 1}`;
        while (used.has(id)) id = `${id}_`;
      }
      used.add(id);
      return s.name ? { id, name: s.name, content: s.content } : { id, content: s.content };
    }),
  };
}

export type ClaimCheckRouteDeps = {
  authenticate: (req: Request) => Promise<{ user?: User; error?: boolean; code?: number; message?: string }>;
  checkApiKeyScope: (user: User | undefined, agentId: string) => ScopeCheckResult;
  checkRecordAccess: (record: any, request: "read" | "write", user?: User) => Promise<boolean>;
  getAgent: (id: string) => Promise<any | undefined>;
  resolveModel: (input: { modelId: string; user?: User }) => Promise<{ languageModel?: LanguageModel }>;
  runCheck: (args: {
    question: string;
    answer: string;
    sources: { id: string; name?: string; content: string }[];
    model: LanguageModel;
    options: ClaimCheckOptions;
    locale?: string;
    secondChance?: (claimText: string) => Promise<any[]>;
    signal?: AbortSignal;
  }) => Promise<ClaimCheckResult>;
  isLicensed: () => boolean;
  limiter: ClaimCheckRateLimiter;
  /** src/exulu/external-rate-limit.ts — the same pair every sibling handler uses. */
  isExternalUser: (user: User | undefined) => boolean;
  externalRateLimitExceeded: (userId: string) => boolean;
  platformDefaultModel: () => Promise<string>;
  /** Supplied by Task 13; absent means no second-chance retrieval. */
  secondChanceFor?: (args: { agent: any; user?: User; model: LanguageModel; cap: number }) =>
    | ((claimText: string) => Promise<any[]>)
    | undefined;
  /** Upsert one stored check. Absent in tests that do not exercise persistence. */
  saveClaimCheck?: (args: {
    session: string;
    messageId: string;
    userId: number;
    result: ClaimCheckResult;
  }) => Promise<void>;
  /** Stored checks for a session, keyed by message id, scoped to the caller. */
  listClaimChecks?: (args: { session: string; userId: number }) => Promise<Record<string, ClaimCheckResult>>;
  /**
   * The stored check for ONE message, scoped to the caller — consulted before
   * the engine runs (spec §5.2). Absent means no lookup and no caching, which
   * is the pre-stage-3 behaviour.
   */
  findClaimCheck?: (args: {
    session: string;
    messageId: string;
    userId: number;
  }) => Promise<ClaimCheckResult | undefined>;
};

export function registerClaimCheckRoutes(app: Express, deps: ClaimCheckRouteDeps): void {
  app.post(CLAIM_CHECK_PATH, async (req: Request, res: Response) => {
    // An unlicensed deployment does not advertise a feature it has not bought.
    if (!deps.isLicensed()) {
      res.status(404).json({ detail: "Not found." });
      return;
    }

    const parsed = requestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ detail: `Invalid request body: ${parsed.error.issues[0]?.message ?? "unknown"}` });
      return;
    }
    const body = parsed.data;

    // `type` is validated above and discarded here, before anything else
    // touches `sources` — see assignSourceIds's own doc comment.
    const assigned = assignSourceIds(body.sources);
    if (!assigned.ok) {
      res.status(400).json({ detail: assigned.detail });
      return;
    }
    const sources = assigned.sources;

    if (body.answer.length > MAX_ANSWER_CHARS) {
      res.status(413).json({ detail: `answer exceeds ${MAX_ANSWER_CHARS} characters.` });
      return;
    }
    if (sources.length > MAX_SOURCES) {
      res.status(413).json({ detail: `more than ${MAX_SOURCES} sources.` });
      return;
    }
    const evidenceChars = sources.reduce((n, s) => n + s.content.length, 0);
    if (evidenceChars > MAX_EVIDENCE_CHARS) {
      res.status(413).json({ detail: `source content exceeds ${MAX_EVIDENCE_CHARS} characters in total.` });
      return;
    }

    const auth = await deps.authenticate(req);
    if (!hasNumericUserId(auth.user)) {
      res.status(unauthorizedStatus(auth)).json({ detail: auth.message ?? "Unauthorized." });
      return;
    }
    const user = auth.user as User;

    // Spec §4: the external/guest budget applies here as everywhere else, so
    // an external identity does not get a fresh 30/min on the most expensive
    // endpoint in the product. This is on TOP of the claim-check limiter
    // below, which applies to every role.
    if (deps.isExternalUser(user) && deps.externalRateLimitExceeded(String(user.id))) {
      res.status(429).json({ detail: "Too many requests. Try again later." });
      return;
    }

    // R22: `resolveModel`'s `rbacBypass`/`rbacRequest` are declared but read
    // nowhere, and `MODEL_FORBIDDEN` is never thrown (src/exulu/resolve-model.ts)
    // — there is no per-user model entitlement check to lean on there. Without
    // a gate here, any authenticated caller could name an arbitrary (and
    // arbitrarily expensive) model on an endpoint that is deliberately fed
    // arbitrary text. So a request-supplied `model` is honoured only for a
    // super admin; everyone else must configure claim_check.model on the agent.
    if (body.model && !user.super_admin) {
      res.status(403).json({
        detail:
          "Choosing the model per request requires a super-admin key; configure claim_check.model on the agent instead.",
      });
      return;
    }

    // Same reasoning as the model gate, for the two knobs that multiply the
    // call count rather than the price per call: `paper` unmerges every stage
    // and batches one sentence per call, and `completions` votes each of those
    // stages N times. Both are benchmark instruments (spec §8), and our own
    // benchmark runs with an admin key.
    if ((body.options?.fidelity === "paper" || (body.options?.completions ?? 1) > 1) && !user.super_admin) {
      res.status(403).json({
        detail:
          "`options.fidelity: \"paper\"` and `options.completions` above 1 require a super-admin key; " +
          "configure claim_check.fidelity and claim_check.completions on the agent instead.",
      });
      return;
    }

    let agent: any | undefined;
    if (body.agent) {
      const scope = deps.checkApiKeyScope(user, body.agent);
      if (!scope.allowed) {
        res.status(scope.code).json({ detail: scope.reason });
        return;
      }
      // A malformed id (not a UUID) makes the lookup throw rather than return
      // undefined, which used to surface as a 500. "No such agent" is the same
      // fact either way, so it answers 404.
      try {
        agent = await deps.getAgent(body.agent);
      } catch (err) {
        console.warn(
          `[EXULU] claim check: agent lookup for "${body.agent}" failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      if (!agent) {
        res.status(404).json({ detail: `Agent ${body.agent} not found.` });
        return;
      }
      if (!(await deps.checkRecordAccess(agent, "read", user))) {
        res.status(403).json({ detail: "You don't have access to this agent." });
        return;
      }
    }

    // R1: task 2's zod parser, not a hand-rolled one — one parser for the
    // claim_check blob, never two that can drift apart.
    const cfg = pipelineConfigFor(agent);

    // Spec §3/§5: claim_check is opt-in per agent because the feature costs
    // money, and no check ever runs for an agent whose admin left it off —
    // otherwise naming that agent here would spend its model's tokens and run
    // second-chance retrieval against its knowledge bases anyway.
    if (agent && !cfg.claimCheck.enabled) {
      res.status(403).json({
        detail: "Claim check is not enabled for this agent; set claim_check.enabled on its knowledge-search tool.",
      });
      return;
    }

    // Spec §5: a guest or external viewer sees no claim check unless the agent
    // says they may. isExternalOrAnonymousUser is the helper the sibling
    // show_sources_to_external_users flag uses, and this is the same
    // visibility question about the same kind of viewer. treatAsGuest adds
    // the public surface: a signed-in internal user viewing a public agent
    // link renders in guest mode, so the endpoint must refuse them the same
    // way the chat's finish-part fragment does (src/exulu/claim-check/finish-metadata.ts).
    if (agent && (treatAsGuest(req, user) || isExternalOrAnonymousUser(user)) && !cfg.claimCheck.showToExternalUsers) {
      res.status(403).json({
        detail:
          "Claim check is not available to external users for this agent; " +
          "set claim_check.showToExternalUsers to allow it.",
      });
      return;
    }

    // A verdict already on disk is not bought twice (spec §5.2's result cache,
    // in this branch's shape). A double-fire, a user-initiated re-check or a
    // retry after a transport hiccup would otherwise pay ~8 provider calls
    // again for an answer that is already stored.
    //
    // Three properties this must keep:
    //  - It sits AFTER every gate above, so a stored row can never become a
    //    way to read a verdict for an agent whose admin turned the check off,
    //    or an agent the caller may not use.
    //  - It is scoped by the authenticated caller exactly as the GET is —
    //    (session, message_id, user) in one query, never a request-supplied
    //    identity (see src/exulu/claim-check/store.ts).
    //  - A lookup failure falls THROUGH to running the check. A cache that
    //    can break the feature it accelerates is worse than no cache.
    //
    // §9 keeps the Redis hash-keyed cache deferred: it now only matters for
    // agent-less API callers who name no session, who have no row to find.
    if (deps.findClaimCheck && body.session && body.messageId && UUID_RE.test(body.session)) {
      try {
        const stored = await deps.findClaimCheck({
          session: body.session,
          messageId: body.messageId,
          userId: Number(user.id),
        });
        if (stored) {
          res.status(200).json(stored);
          return;
        }
      } catch (err) {
        console.warn(
          "[EXULU claim-check] could not read the stored check for this message; running the check.",
          err,
        );
      }
    }

    const candidates = [
      body.model,
      cfg.claimCheck.model,
      cfg.utilityModel,
      agent?.model,
      await deps.platformDefaultModel(),
    ].filter((id): id is string => Boolean(id));

    if (candidates.length === 0) {
      // The platform default comes from the CLAIM_CHECK_DEFAULT_MODEL env var
      // (see src/exulu/routes.ts). The DB-backed platform setting the spec
      // sketched does not exist and is a recorded deferral, so naming it here
      // was a first-run dead end for the agent-less API client.
      res.status(400).json({
        detail:
          "No model to run the check with: pass `model`, configure claim_check.model on the agent, " +
          "or set the CLAIM_CHECK_DEFAULT_MODEL environment variable on the backend.",
      });
      return;
    }

    // No rbacBypass is passed here (unlike the retrieval tool's utility_model) —
    // that flag is inert in resolveModel today, but the super-admin gate above
    // is what actually keeps a non-admin caller off an arbitrary model.
    let model: LanguageModel | undefined;
    let lastError: unknown;
    for (const modelId of candidates) {
      try {
        const resolved = await deps.resolveModel({ modelId, user });
        if (resolved.languageModel) {
          model = resolved.languageModel;
          break;
        }
      } catch (err) {
        lastError = err;
        // A transient infra failure on an early candidate must stay visible
        // even when a later candidate resolves and the request succeeds.
        console.warn(
          `[EXULU] claim check: model "${modelId}" failed to resolve: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    if (!model) {
      res.status(400).json({
        detail: `Could not resolve a model for the claim check${lastError instanceof Error ? `: ${lastError.message}` : ""}.`,
      });
      return;
    }

    const options: ClaimCheckOptions = {
      fidelity: body.options?.fidelity ?? cfg.claimCheck.fidelity,
      completions: body.options?.completions ?? cfg.claimCheck.completions,
      reRetrieve: typeof body.options?.reRetrieve === "boolean" ? body.options.reRetrieve : cfg.claimCheck.reRetrieve,
      thresholds: {
        warn: body.options?.thresholds?.warn ?? cfg.claimCheck.thresholds.warn,
        alert: body.options?.thresholds?.alert ?? cfg.claimCheck.thresholds.alert,
      },
      // Caps CLAMP, they do not override: a caller may tighten a check (cheaper,
      // narrower) but never loosen one.
      caps: {
        maxSentences: clampCap(body.options?.caps?.maxSentences, cfg.claimCheck.caps.maxSentences),
        maxClaims: clampCap(body.options?.caps?.maxClaims, cfg.claimCheck.caps.maxClaims),
        maxReRetrievals: clampCap(body.options?.caps?.maxReRetrievals, cfg.claimCheck.caps.maxReRetrievals),
      },
    };

    // A warn above alert makes every label "alert" — a misconfiguration that
    // would be read as a hallucination finding, so it is refused, not applied.
    if (options.thresholds.warn > options.thresholds.alert) {
      res.status(400).json({
        detail:
          `thresholds.warn (${options.thresholds.warn}) must not exceed thresholds.alert ` +
          `(${options.thresholds.alert}); check the request options and the agent's claim_check.thresholds.`,
      });
      return;
    }

    const slot = deps.limiter.take(String(user.id));
    if (!slot.ok) {
      res.status(429).json({ detail: slot.reason ?? "Too many requests. Try again later." });
      return;
    }

    const controller = new AbortController();
    const timeoutMs = resolveClaimCheckTimeoutMs();
    let deadline: ReturnType<typeof setTimeout> | undefined;
    // Set only on the success path, and read only after the slot is released
    // below — persistence must never hold the global in-flight budget open,
    // and the write needs its own deadline, not one that raced a
    // Promise.race the response already settled.
    let completedResult: ClaimCheckResult | undefined;
    try {
      const secondChance =
        agent && options.reRetrieve && deps.secondChanceFor
          ? deps.secondChanceFor({ agent, user, model, cap: options.caps.maxReRetrievals })
          : undefined;

      const timedOut = new Promise<never>((_resolve, reject) => {
        deadline = setTimeout(() => {
          controller.abort();
          reject(new ClaimCheckTimeoutError());
        }, timeoutMs);
      });

      const result = await Promise.race([
        deps.runCheck({
          question: body.question,
          answer: body.answer,
          sources,
          model,
          options,
          signal: controller.signal,
          ...(body.locale ? { locale: body.locale } : {}),
          ...(secondChance ? { secondChance } : {}),
        }),
        timedOut,
      ]);
      // Recorded BEFORE the response is sent: if the client has gone away and
      // res.json throws, the check was already paid for, and discarding it
      // then is the one case where persistence matters most — the next load
      // of that session would re-buy a verdict we already had.
      completedResult = result;
      res.status(200).json(result);
    } catch (err) {
      if (err instanceof ClaimCheckTimeoutError) {
        console.warn(`[EXULU] claim check exceeded the ${timeoutMs} ms deadline.`);
        res.status(504).json({
          detail: `The claim check did not finish within ${timeoutMs / 1000} seconds and was cancelled.`,
        });
      } else {
        console.error("[EXULU] claim check failed.", err);
        res.status(500).json({ detail: "The claim check failed." });
      }
    } finally {
      // Always release: an unreleased slot leaks the global in-flight budget —
      // including on the timeout path, where the engine may still be unwinding.
      if (deadline) clearTimeout(deadline);
      deps.limiter.release();
    }

    // Persistence is a convenience, not part of the verdict, and runs ONLY
    // after the slot is released and the deadline timer is cleared above: a
    // database write that hangs must never pin the deployment-wide in-flight
    // budget that 429s this endpoint for every other caller. The response
    // was already sent inside the try block; a reload losing the panel is
    // worse than nothing, but a database hiccup here must not turn a
    // completed check into an error the caller has already paid for — so
    // this runs outside any try/catch that could still touch `res`, in its
    // own try/catch that only logs.
    if (completedResult && body.session && body.messageId && UUID_RE.test(body.session)) {
      if (!deps.saveClaimCheck) {
        // A missing dep is a deployment wiring defect, not "nothing to store".
        // The GET refuses loudly for exactly this reason; skipping silently
        // here meant a panel that never survived a reload, with no signal
        // anywhere that the wiring had been dropped.
        console.error(
          "[EXULU claim-check] saveClaimCheck is not wired; this check cannot survive a reload.",
        );
      } else {
        try {
          await deps.saveClaimCheck({
            session: body.session,
            messageId: body.messageId,
            userId: Number(user.id),
            result: completedResult,
          });
        } catch (err) {
          console.warn("[EXULU claim-check] could not store the check for this message.", err);
        }
      }
    }
  });

  // GET /claims/check/:session — the only read path to the claim_checks
  // table (it has no GraphQL surface: see ee/schemas.ts's claimChecksSchema).
  // The stored payload holds the answer's sentences and verbatim source
  // quotes, so scoping here is the only thing standing between one user and
  // another user's stored answers: the query itself filters by session AND
  // the authenticated caller's id, never by session alone with a JS filter,
  // and a request-supplied user id is never trusted.
  app.get(CLAIM_CHECK_SESSION_PATH, async (req: Request, res: Response) => {
    if (!deps.isLicensed()) {
      res.status(404).json({ detail: "Not found." });
      return;
    }
    const session = req.params.session ?? "";
    if (!UUID_RE.test(session)) {
      res.status(400).json({ detail: "session must be a uuid." });
      return;
    }
    const auth = await deps.authenticate(req);
    if (!hasNumericUserId(auth.user)) {
      res.status(unauthorizedStatus(auth)).json({ detail: auth.message ?? "Unauthorized." });
      return;
    }
    if (!deps.listClaimChecks) {
      // A missing dep is a deployment wiring defect, not "nothing stored":
      // answering 200 here would make a future regression that drops the
      // wiring read as an empty, legitimate result instead of failing loudly.
      console.error("[EXULU claim-check] listClaimChecks is not wired; refusing to answer as if nothing were stored.");
      res.status(500).json({ detail: "Could not read stored checks." });
      return;
    }
    try {
      const checks = await deps.listClaimChecks({ session, userId: Number((auth.user as User).id) });
      res.status(200).json({ checks });
    } catch (err) {
      console.error("[EXULU claim-check] could not read stored checks.", err);
      res.status(500).json({ detail: "Could not read stored checks." });
    }
  });
}
