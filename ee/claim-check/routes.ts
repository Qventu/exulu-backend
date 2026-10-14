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
import { type ClaimCheckOptions, type ClaimCheckResult } from "./types";
import type { ClaimCheckRateLimiter } from "./rate-limit";
import { parsePipelineConfig } from "@EE/agentic-retrieval/pipeline/config";

export const CLAIM_CHECK_PATH = "/claims/check";

/** Payload caps: an answer is prose, evidence is documents. Beyond these, 413. */
const MAX_ANSWER_CHARS = 200_000;
const MAX_EVIDENCE_CHARS = 2_000_000;
const MAX_SOURCES = 200;

const requestSchema = z.object({
  question: z.string().min(1),
  answer: z.string().min(1),
  sources: z
    .array(z.object({ id: z.string().min(1), name: z.string().optional(), content: z.string() }))
    .default([]),
  agent: z.string().optional(),
  session: z.string().optional(),
  messageId: z.string().optional(),
  model: z.string().optional(),
  locale: z.string().optional(),
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
  }) => Promise<ClaimCheckResult>;
  isLicensed: () => boolean;
  limiter: ClaimCheckRateLimiter;
  platformDefaultModel: () => Promise<string>;
  /** Supplied by Task 13; absent means no second-chance retrieval. */
  secondChanceFor?: (args: { agent: any; user?: User; model: LanguageModel; cap: number }) =>
    | ((claimText: string) => Promise<any[]>)
    | undefined;
};

/**
 * The agent's agentic_context_search tool config as a plain record, so it can
 * be run through task 2's `parsePipelineConfig` (the same parser the
 * retrieval tool itself uses) instead of a second, independently-maintained
 * parser for the same `claim_check` blob.
 */
function toolConfigOf(agent: any): Record<string, unknown> {
  const tool = (agent?.tools ?? []).find((t: any) => t?.id === "agentic_context_search");
  const out: Record<string, unknown> = {};
  for (const entry of tool?.config ?? []) if (entry?.name) out[entry.name] = entry.variable;
  return out;
}

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

    if (body.answer.length > MAX_ANSWER_CHARS) {
      res.status(413).json({ detail: `answer exceeds ${MAX_ANSWER_CHARS} characters.` });
      return;
    }
    if (body.sources.length > MAX_SOURCES) {
      res.status(413).json({ detail: `more than ${MAX_SOURCES} sources.` });
      return;
    }
    const evidenceChars = body.sources.reduce((n, s) => n + s.content.length, 0);
    if (evidenceChars > MAX_EVIDENCE_CHARS) {
      res.status(413).json({ detail: `source content exceeds ${MAX_EVIDENCE_CHARS} characters in total.` });
      return;
    }

    const auth = await deps.authenticate(req);
    if (!auth.user?.id) {
      res.status(auth.code ?? 401).json({ detail: auth.message ?? "Unauthorized." });
      return;
    }
    const user = auth.user;

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

    let agent: any | undefined;
    if (body.agent) {
      const scope = deps.checkApiKeyScope(user, body.agent);
      if (!scope.allowed) {
        res.status(scope.code).json({ detail: scope.reason });
        return;
      }
      agent = await deps.getAgent(body.agent);
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
    const cfg = parsePipelineConfig(toolConfigOf(agent));
    const candidates = [
      body.model,
      cfg.claimCheck.model,
      cfg.utilityModel,
      agent?.model,
      await deps.platformDefaultModel(),
    ].filter((id): id is string => Boolean(id));

    if (candidates.length === 0) {
      res.status(400).json({
        detail:
          "No model to run the check with: pass `model`, configure claim_check.model on the agent, " +
          "or set the platform setting claim_check.default_model.",
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
      caps: {
        maxSentences: body.options?.caps?.maxSentences ?? cfg.claimCheck.caps.maxSentences,
        maxClaims: body.options?.caps?.maxClaims ?? cfg.claimCheck.caps.maxClaims,
        maxReRetrievals: body.options?.caps?.maxReRetrievals ?? cfg.claimCheck.caps.maxReRetrievals,
      },
    };

    const slot = deps.limiter.take(String(user.id));
    if (!slot.ok) {
      res.status(429).json({ detail: slot.reason ?? "Too many requests. Try again later." });
      return;
    }

    try {
      const secondChance =
        agent && options.reRetrieve && deps.secondChanceFor
          ? deps.secondChanceFor({ agent, user, model, cap: options.caps.maxReRetrievals })
          : undefined;

      const result = await deps.runCheck({
        question: body.question,
        answer: body.answer,
        sources: body.sources,
        model,
        options,
        ...(body.locale ? { locale: body.locale } : {}),
        ...(secondChance ? { secondChance } : {}),
      });
      res.status(200).json(result);
    } catch (err) {
      console.error("[EXULU] claim check failed.", err);
      res.status(500).json({ detail: "The claim check failed." });
    } finally {
      // Always release: an unreleased slot leaks the global in-flight budget.
      deps.limiter.release();
    }
  });
}
