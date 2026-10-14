// ee/claim-check/routes.test.ts
import express from "express";
import request from "supertest";
import {
  registerClaimCheckRoutes,
  CLAIM_CHECK_PATH,
  CLAIM_CHECK_SESSION_PATH,
  CLAIM_CHECK_TIMEOUT_MS,
  resolveClaimCheckTimeoutMs,
  type ClaimCheckRouteDeps,
} from "./routes";
import { claimCheckRateLimiter } from "./rate-limit";
import { PUBLIC_SURFACE_HEADER } from "@SRC/exulu/public-surface";

const RESULT = {
  status: "ok" as const,
  score: { claims: 2, supported: 2, contradicted: 0, unsupported: 0, unsupportedShare: 0, label: "ok" as const },
  sentences: [],
  claims: [],
  usage: { calls: 3, inputTokens: 10, outputTokens: 2 },
  timings: { totalMs: 5 },
  limits: { truncated: false, sentencesSkipped: 0 },
  notes: [],
};

const BODY = {
  question: "Womit arbeitet die FST-2XT?",
  answer: "Die FST-2XT arbeitet mit 230 Volt.",
  sources: [{ id: "s1", content: "Die FST-2XT arbeitet mit 230 Volt." }],
};

function buildApp(overrides: Partial<ClaimCheckRouteDeps> = {}) {
  const runCheck = jest.fn().mockResolvedValue(RESULT);
  const deps: ClaimCheckRouteDeps = {
    authenticate: async () => ({ user: { id: 7, type: "user" } as any }),
    checkApiKeyScope: () => ({ allowed: true, code: 200, reason: "" }),
    checkRecordAccess: async () => true,
    getAgent: async () => ({ id: "agent-1", model: "agent-model", tools: [] }) as any,
    resolveModel: async ({ modelId }: any) => ({ languageModel: { modelId } }) as any,
    runCheck,
    isLicensed: () => true,
    limiter: claimCheckRateLimiter({ perMinute: 100, perHour: 1000, maxInFlight: 10 }),
    isExternalUser: () => false,
    externalRateLimitExceeded: () => false,
    platformDefaultModel: async () => "platform-model",
    saveClaimCheck: jest.fn().mockResolvedValue(undefined),
    listClaimChecks: jest.fn().mockResolvedValue({}),
    // Nothing stored unless a test says otherwise, so every existing
    // assertion still exercises the engine path.
    findClaimCheck: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  const app = express();
  app.use(express.json({ limit: "20mb" }));
  registerClaimCheckRoutes(app, deps);
  return { app, deps, runCheck: deps.runCheck as jest.Mock };
}

function post(app: ReturnType<typeof express>, body: unknown) {
  return request(app).post(CLAIM_CHECK_PATH).send(body);
}

describe(`POST ${CLAIM_CHECK_PATH}`, () => {
  it("returns the engine's result for a valid request", async () => {
    const { app, runCheck } = buildApp();
    const res = await request(app).post(CLAIM_CHECK_PATH).send(BODY);
    expect(res.status).toBe(200);
    expect(res.body.score.label).toBe("ok");
    expect(runCheck).toHaveBeenCalledTimes(1);
    expect(runCheck.mock.calls[0][0].question).toBe(BODY.question);
  });

  it("404s when the deployment is not licensed, without running anything", async () => {
    const authenticate = jest.fn(async () => ({ user: { id: 7, type: "user" } as any }));
    const checkApiKeyScope = jest.fn(() => ({ allowed: true, code: 200, reason: "" }));
    const checkRecordAccess = jest.fn(async () => true);
    const getAgent = jest.fn(async () => ({ id: "agent-1", model: "agent-model", tools: [] }) as any);
    const { app, runCheck } = buildApp({
      isLicensed: () => false,
      authenticate,
      checkApiKeyScope,
      checkRecordAccess,
      getAgent,
    });
    const res = await request(app).post(CLAIM_CHECK_PATH).send({ ...BODY, agent: "agent-1" });
    expect(res.status).toBe(404);
    expect(runCheck).not.toHaveBeenCalled();
    // The licence check must run before anything else touches auth, scope or RBAC.
    expect(authenticate).not.toHaveBeenCalled();
    expect(checkApiKeyScope).not.toHaveBeenCalled();
    expect(checkRecordAccess).not.toHaveBeenCalled();
    expect(getAgent).not.toHaveBeenCalled();
  });

  it("401s when authentication fails", async () => {
    const { app } = buildApp({
      authenticate: async () => ({ error: true, code: 401, message: "no key" }),
    });
    const res = await request(app).post(CLAIM_CHECK_PATH).send(BODY);
    expect(res.status).toBe(401);
  });

  it("400s on a missing question, a missing answer and a non-array sources field", async () => {
    const { app } = buildApp();
    expect((await request(app).post(CLAIM_CHECK_PATH).send({ answer: "a", sources: [] })).status).toBe(400);
    expect((await request(app).post(CLAIM_CHECK_PATH).send({ question: "q", sources: [] })).status).toBe(400);
    expect((await request(app).post(CLAIM_CHECK_PATH).send({ question: "q", answer: "a", sources: "nope" })).status).toBe(400);
  });

  it("413s when the answer or the evidence exceeds the payload caps", async () => {
    const { app, runCheck } = buildApp();
    const huge = "a".repeat(200_001);
    const tooLongAnswer = await request(app).post(CLAIM_CHECK_PATH).send({ ...BODY, answer: huge });
    expect(tooLongAnswer.status).toBe(413);

    const tooMuchEvidence = await request(app)
      .post(CLAIM_CHECK_PATH)
      .send({ ...BODY, sources: [{ id: "s1", content: "b".repeat(2_000_001) }] });
    expect(tooMuchEvidence.status).toBe(413);
    expect(runCheck).not.toHaveBeenCalled();

    const tooManySources = await request(app)
      .post(CLAIM_CHECK_PATH)
      .send({ ...BODY, sources: Array.from({ length: 201 }, (_, i) => ({ id: `s${i}`, content: "x" })) });
    expect(tooManySources.status).toBe(413);
    expect(runCheck).not.toHaveBeenCalled();
  });

  it("429s when the limiter refuses, and releases the slot after a completed check", async () => {
    const limiter = claimCheckRateLimiter({ perMinute: 1, perHour: 10, maxInFlight: 10 });
    const { app } = buildApp({ limiter });
    expect((await request(app).post(CLAIM_CHECK_PATH).send(BODY)).status).toBe(200);
    const second = await request(app).post(CLAIM_CHECK_PATH).send(BODY);
    expect(second.status).toBe(429);
  });

  it("resolves a super admin's chosen model WITHOUT rbacBypass (rbacBypass is inert in this codebase — the real gate against a non-admin naming an arbitrary model is the super-admin check, see the 403 test below)", async () => {
    const resolveModel = jest.fn(async ({ modelId }: any) => ({ languageModel: { modelId } }) as any);
    const { app } = buildApp({
      resolveModel,
      authenticate: async () => ({ user: { id: 7, type: "user", super_admin: true } as any }),
    });
    const res = await request(app).post(CLAIM_CHECK_PATH).send({ ...BODY, model: "caller-choice" });
    expect(res.status).toBe(200);
    expect(resolveModel).toHaveBeenCalledWith(expect.objectContaining({ modelId: "caller-choice" }));
    expect(resolveModel.mock.calls[0][0].rbacBypass).toBeUndefined();
  });

  it("honours a super-admin caller's model override end to end", async () => {
    const { app, runCheck } = buildApp({
      authenticate: async () => ({ user: { id: 7, type: "user", super_admin: true } as any }),
    });
    const res = await request(app).post(CLAIM_CHECK_PATH).send({ ...BODY, model: "caller-choice" });
    expect(res.status).toBe(200);
    expect(runCheck).toHaveBeenCalledTimes(1);
  });

  it("403s a non-admin caller's `model` override, without resolving a model or running anything", async () => {
    const resolveModel = jest.fn(async ({ modelId }: any) => ({ languageModel: { modelId } }) as any);
    const { app, runCheck } = buildApp({ resolveModel });
    const res = await request(app).post(CLAIM_CHECK_PATH).send({ ...BODY, model: "caller-choice" });
    expect(res.status).toBe(403);
    expect(String(res.body.detail)).toContain("super-admin");
    expect(resolveModel).not.toHaveBeenCalled();
    expect(runCheck).not.toHaveBeenCalled();
  });

  // Finding 1: a request may TIGHTEN a cap, never loosen one. Without the
  // clamp, these three numbers would reach the engine verbatim and buy an
  // authenticated non-admin thousands of provider calls and up to 5,000 full
  // retrievals per request, repeatable at the limiter's 30/min.
  it("clamps request-supplied caps down to the configured values instead of honouring them", async () => {
    const { app, runCheck } = buildApp();
    const res = await request(app)
      .post(CLAIM_CHECK_PATH)
      .send({ ...BODY, options: { caps: { maxSentences: 5000, maxClaims: 5000, maxReRetrievals: 5000 } } });

    expect(res.status).toBe(200);
    // With no agent named, `configured` is the engine default
    // (CLAIM_CHECK_DEFAULTS.caps, via the claim_check config schema).
    expect(runCheck.mock.calls[0][0].options.caps).toEqual({
      maxSentences: 120,
      maxClaims: 200,
      maxReRetrievals: 10,
    });
  });

  it("honours a request cap that is lower than the configured one", async () => {
    const { app, runCheck } = buildApp();
    const res = await request(app)
      .post(CLAIM_CHECK_PATH)
      .send({ ...BODY, options: { caps: { maxSentences: 5, maxClaims: 7, maxReRetrievals: 0 } } });

    expect(res.status).toBe(200);
    expect(runCheck.mock.calls[0][0].options.caps).toEqual({
      maxSentences: 5,
      maxClaims: 7,
      maxReRetrievals: 0,
    });
  });

  // R33: the module ceilings are gone. They were meant to stop a REQUEST
  // demanding more work, but they also clamped the operator's own configured
  // value — which is why a 44,000-character NEWLIFT answer (568 sentences
  // after list segmentation) was 21% checked with no configuration path to
  // raise it. An operator configuring their own agent is trusted; they pay
  // for it.
  it("honours a configured cap above the engine default for an agent-scoped call", async () => {
    const agentWithRaisedCaps = {
      id: "agent-1",
      model: "agent-model",
      tools: [
        {
          id: "agentic_context_search",
          config: [
            {
              name: "claim_check",
              type: "json",
              variable: '{"enabled":true,"caps":{"maxSentences":600,"maxClaims":900,"maxReRetrievals":40}}',
            },
          ],
        },
      ],
    };
    const { app, runCheck } = buildApp({ getAgent: async () => agentWithRaisedCaps as any });
    const res = await request(app).post(CLAIM_CHECK_PATH).send({ ...BODY, agent: "agent-1" });

    expect(res.status).toBe(200);
    expect(runCheck.mock.calls[0][0].options.caps).toEqual({
      maxSentences: 600,
      maxClaims: 900,
      maxReRetrievals: 40,
    });
  });

  it("still refuses to let a request loosen a cap the operator configured above the default", async () => {
    const agentWithRaisedCaps = {
      id: "agent-1",
      model: "agent-model",
      tools: [
        {
          id: "agentic_context_search",
          config: [
            { name: "claim_check", type: "json", variable: '{"enabled":true,"caps":{"maxSentences":600}}' },
          ],
        },
      ],
    };
    const { app, runCheck } = buildApp({ getAgent: async () => agentWithRaisedCaps as any });
    const res = await request(app)
      .post(CLAIM_CHECK_PATH)
      .send({ ...BODY, agent: "agent-1", options: { caps: { maxSentences: 5000, maxClaims: 5000 } } });

    expect(res.status).toBe(200);
    expect(runCheck.mock.calls[0][0].options.caps).toEqual({
      maxSentences: 600,
      maxClaims: 200,
      maxReRetrievals: 10,
    });
  });

  // Finding 1: paper fidelity and voting multiply the call count, so they are
  // gated like `model` is — our own benchmark runs with an admin key.
  it("403s a non-admin caller asking for paper fidelity, without running anything", async () => {
    const { app, runCheck } = buildApp();
    const res = await request(app)
      .post(CLAIM_CHECK_PATH)
      .send({ ...BODY, options: { fidelity: "paper" } });

    expect(res.status).toBe(403);
    expect(String(res.body.detail)).toContain("super-admin");
    expect(String(res.body.detail)).toContain("claim_check.fidelity");
    expect(runCheck).not.toHaveBeenCalled();
  });

  it("403s a non-admin caller asking for more than one completion, without running anything", async () => {
    const { app, runCheck } = buildApp();
    const res = await request(app)
      .post(CLAIM_CHECK_PATH)
      .send({ ...BODY, options: { completions: 3 } });

    expect(res.status).toBe(403);
    expect(runCheck).not.toHaveBeenCalled();
  });

  it("lets a super admin ask for paper fidelity with voting", async () => {
    const { app, runCheck } = buildApp({
      authenticate: async () => ({ user: { id: 7, type: "user", super_admin: true } as any }),
    });
    const res = await request(app)
      .post(CLAIM_CHECK_PATH)
      .send({ ...BODY, options: { fidelity: "paper", completions: 3 } });

    expect(res.status).toBe(200);
    expect(runCheck.mock.calls[0][0].options.fidelity).toBe("paper");
    expect(runCheck.mock.calls[0][0].options.completions).toBe(3);
  });

  it("falls back through claim_check.model, utility_model and the agent model", async () => {
    const resolveModel = jest.fn(async ({ modelId }: any) => ({ languageModel: { modelId } }) as any);
    const agentWith = (config: Record<string, string>) => ({
      id: "agent-1",
      model: "agent-model",
      tools: [
        {
          id: "agentic_context_search",
          config: Object.entries(config).map(([name, variable]) => ({ name, variable, type: "json" })),
        },
      ],
    });

    const withClaimModel = buildApp({
      resolveModel,
      getAgent: async () => agentWith({ claim_check: '{"enabled":true,"model":"claim-model"}' }) as any,
    });
    await request(withClaimModel.app).post(CLAIM_CHECK_PATH).send({ ...BODY, agent: "agent-1" });
    expect(resolveModel.mock.calls[0][0].modelId).toBe("claim-model");

    resolveModel.mockClear();
    const withUtilityModel = buildApp({
      resolveModel,
      getAgent: async () =>
        agentWith({ claim_check: '{"enabled":true}', utility_model: "utility-model" }) as any,
    });
    await request(withUtilityModel.app).post(CLAIM_CHECK_PATH).send({ ...BODY, agent: "agent-1" });
    expect(resolveModel.mock.calls[0][0].modelId).toBe("utility-model");

    resolveModel.mockClear();
    const withAgentModel = buildApp({
      resolveModel,
      // claim_check must be enabled for the agent to be usable at all, but it
      // names no model, so resolution falls through to the agent's own model.
      getAgent: async () => agentWith({ claim_check: '{"enabled":true}' }) as any,
    });
    await request(withAgentModel.app).post(CLAIM_CHECK_PATH).send({ ...BODY, agent: "agent-1" });
    expect(resolveModel.mock.calls[0][0].modelId).toBe("agent-model");
  });

  it("400s naming the missing configuration when no model resolves at all", async () => {
    const { app, runCheck } = buildApp({
      getAgent: async () => undefined,
      platformDefaultModel: async () => "",
    });
    const res = await request(app).post(CLAIM_CHECK_PATH).send(BODY);
    expect(res.status).toBe(400);
    // Finding 12: the message used to name a platform setting
    // `claim_check.default_model` that does not exist in the codebase.
    expect(String(res.body.detail)).toContain("CLAIM_CHECK_DEFAULT_MODEL");
    expect(runCheck).not.toHaveBeenCalled();
  });

  it("403s when the API key is not scoped to the named agent", async () => {
    const { app, runCheck } = buildApp({
      checkApiKeyScope: () => ({ allowed: false, code: 403, reason: "key is scoped to another agent" }),
    });
    const res = await request(app).post(CLAIM_CHECK_PATH).send({ ...BODY, agent: "agent-1" });
    expect(res.status).toBe(403);
    expect(runCheck).not.toHaveBeenCalled();
  });

  it("403s when the caller cannot read the named agent", async () => {
    const { app } = buildApp({ checkRecordAccess: async () => false });
    const res = await request(app).post(CLAIM_CHECK_PATH).send({ ...BODY, agent: "agent-1" });
    expect(res.status).toBe(403);
  });

  // Finding 8: cfg.claimCheck.enabled and showToExternalUsers were parsed and
  // read nowhere, and the external limiter was missing entirely.
  it("403s when the named agent has claim check disabled, without running anything", async () => {
    const { app, runCheck } = buildApp({
      getAgent: async () =>
        ({
          id: "agent-1",
          model: "agent-model",
          tools: [
            {
              id: "agentic_context_search",
              config: [{ name: "claim_check", type: "json", variable: '{"enabled":false}' }],
            },
          ],
        }) as any,
    });
    const res = await request(app).post(CLAIM_CHECK_PATH).send({ ...BODY, agent: "agent-1" });
    expect(res.status).toBe(403);
    expect(String(res.body.detail)).toContain("claim_check.enabled");
    expect(runCheck).not.toHaveBeenCalled();
  });

  it("403s an external caller when the agent does not show claim check to external users", async () => {
    const agentWithClaimCheck = (variable: string) =>
      ({
        id: "agent-1",
        model: "agent-model",
        tools: [{ id: "agentic_context_search", config: [{ name: "claim_check", type: "json", variable }] }],
      }) as any;
    const external = {
      authenticate: async () => ({ user: { id: 9, type: "user", role: { name: "external" } } as any }),
    };

    const hidden = buildApp({ ...external, getAgent: async () => agentWithClaimCheck('{"enabled":true}') });
    const res = await request(hidden.app).post(CLAIM_CHECK_PATH).send({ ...BODY, agent: "agent-1" });
    expect(res.status).toBe(403);
    expect(String(res.body.detail)).toContain("showToExternalUsers");
    expect(hidden.runCheck).not.toHaveBeenCalled();

    // With the flag on, the same external caller is served.
    const shown = buildApp({
      ...external,
      getAgent: async () => agentWithClaimCheck('{"enabled":true,"showToExternalUsers":true}'),
    });
    const allowed = await request(shown.app).post(CLAIM_CHECK_PATH).send({ ...BODY, agent: "agent-1" });
    expect(allowed.status).toBe(200);
    expect(shown.runCheck).toHaveBeenCalledTimes(1);
  });

  // Fix round 1, Important 1: a signed-in INTERNAL user (no external role) on
  // the public surface renders in guest mode, so must be refused the same way
  // an external role is — the chat's finish-part fragment applies the same rule.
  it("403s a signed-in internal user on the public surface when the agent does not show claim check to external users", async () => {
    const agentWithClaimCheck = (variable: string) =>
      ({
        id: "agent-1",
        model: "agent-model",
        tools: [{ id: "agentic_context_search", config: [{ name: "claim_check", type: "json", variable }] }],
      }) as any;
    // Internal: id set, no external role — would pass isExternalOrAnonymousUser.
    const internalOnPublicSurface = {
      authenticate: async () => ({ user: { id: 9, type: "user" } as any }),
    };

    const hidden = buildApp({ ...internalOnPublicSurface, getAgent: async () => agentWithClaimCheck('{"enabled":true}') });
    const res = await request(hidden.app)
      .post(CLAIM_CHECK_PATH)
      .set(PUBLIC_SURFACE_HEADER, "1")
      .send({ ...BODY, agent: "agent-1" });
    expect(res.status).toBe(403);
    expect(String(res.body.detail)).toContain("showToExternalUsers");
    expect(hidden.runCheck).not.toHaveBeenCalled();

    // With the flag on, the same signed-in internal user on the public
    // surface is served.
    const shown = buildApp({
      ...internalOnPublicSurface,
      getAgent: async () => agentWithClaimCheck('{"enabled":true,"showToExternalUsers":true}'),
    });
    const allowed = await request(shown.app)
      .post(CLAIM_CHECK_PATH)
      .set(PUBLIC_SURFACE_HEADER, "1")
      .send({ ...BODY, agent: "agent-1" });
    expect(allowed.status).toBe(200);
    expect(shown.runCheck).toHaveBeenCalledTimes(1);

    // And off the public surface, the same user is unaffected.
    const normal = buildApp({ ...internalOnPublicSurface, getAgent: async () => agentWithClaimCheck('{"enabled":true}') });
    const notPublic = await request(normal.app).post(CLAIM_CHECK_PATH).send({ ...BODY, agent: "agent-1" });
    expect(notPublic.status).toBe(200);
    expect(normal.runCheck).toHaveBeenCalledTimes(1);
  });

  it("429s an external caller over the external rate-limit budget, before any model work", async () => {
    const resolveModel = jest.fn(async ({ modelId }: any) => ({ languageModel: { modelId } }) as any);
    const externalRateLimitExceeded = jest.fn(() => true);
    const { app, runCheck } = buildApp({
      resolveModel,
      isExternalUser: () => true,
      externalRateLimitExceeded,
    });
    const res = await request(app).post(CLAIM_CHECK_PATH).send(BODY);
    expect(res.status).toBe(429);
    expect(externalRateLimitExceeded).toHaveBeenCalledWith("7");
    expect(resolveModel).not.toHaveBeenCalled();
    expect(runCheck).not.toHaveBeenCalled();
  });

  it("does not consult the external budget for an internal caller", async () => {
    const externalRateLimitExceeded = jest.fn(() => true);
    const { app } = buildApp({ isExternalUser: () => false, externalRateLimitExceeded });
    const res = await request(app).post(CLAIM_CHECK_PATH).send(BODY);
    expect(res.status).toBe(200);
    expect(externalRateLimitExceeded).not.toHaveBeenCalled();
  });

  // Finding 14: an unusable locale used to reach new Intl.Segmenter inside the
  // engine and throw into its outer catch, so garbage yielded 200 plus an
  // empty partial result instead of a 400.
  it("400s an unusable locale at the edge, without running the engine", async () => {
    const { app, runCheck } = buildApp();
    const res = await request(app).post(CLAIM_CHECK_PATH).send({ ...BODY, locale: "💥not-a-locale💥" });
    expect(res.status).toBe(400);
    expect(String(res.body.detail)).toContain("locale");
    expect(runCheck).not.toHaveBeenCalled();

    const ok = await request(app).post(CLAIM_CHECK_PATH).send({ ...BODY, locale: "de" });
    expect(ok.status).toBe(200);
  });

  // Finding 14: warn above alert labels everything "alert", which reads as a
  // hallucination finding. It is refused, not applied.
  it("400s when the resolved thresholds have warn above alert", async () => {
    const { app, runCheck } = buildApp();
    const res = await request(app)
      .post(CLAIM_CHECK_PATH)
      .send({ ...BODY, options: { thresholds: { warn: 0.5, alert: 0.3 } } });
    expect(res.status).toBe(400);
    expect(String(res.body.detail)).toContain("thresholds.warn");
    expect(runCheck).not.toHaveBeenCalled();

    // Equal values are fine: everything at or above alert is "alert".
    const equal = await request(app)
      .post(CLAIM_CHECK_PATH)
      .send({ ...BODY, options: { thresholds: { warn: 0.3, alert: 0.3 } } });
    expect(equal.status).toBe(200);
  });

  it("400s when a request warn exceeds the agent's configured alert", async () => {
    const { app } = buildApp({
      getAgent: async () =>
        ({
          id: "agent-1",
          model: "agent-model",
          tools: [
            {
              id: "agentic_context_search",
              config: [
                {
                  name: "claim_check",
                  type: "json",
                  variable: '{"enabled":true,"showToExternalUsers":true,"thresholds":{"warn":0.1,"alert":0.2}}',
                },
              ],
            },
          ],
        }) as any,
    });
    const res = await request(app)
      .post(CLAIM_CHECK_PATH)
      .send({ ...BODY, agent: "agent-1", options: { thresholds: { warn: 0.4 } } });
    expect(res.status).toBe(400);
  });

  // Finding 14: a malformed agent id makes the lookup throw rather than return
  // undefined, which surfaced as a 500 outside any try/catch.
  it("404s a malformed agent id instead of 500ing", async () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    const { app, runCheck } = buildApp({
      getAgent: async () => {
        throw new Error('invalid input syntax for type uuid: "not-a-uuid"');
      },
    });
    const res = await request(app).post(CLAIM_CHECK_PATH).send({ ...BODY, agent: "not-a-uuid" });
    expect(res.status).toBe(404);
    expect(String(res.body.detail)).toContain("not found");
    expect(runCheck).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("passes a partial engine result through with 200", async () => {
    const { app } = buildApp({
      runCheck: jest.fn().mockResolvedValue({ ...RESULT, status: "partial", notes: ["selection aborted"] }),
    });
    const res = await request(app).post(CLAIM_CHECK_PATH).send(BODY);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("partial");
    expect(res.body.notes).toEqual(["selection aborted"]);
  });

  // Finding 7: spec §4 mandates a 60 s request timeout, and there was none
  // anywhere in the module — a hung provider held one of the twenty global
  // in-flight slots until the transport gave up, and twenty such requests
  // 429 the endpoint deployment-wide.
  it("504s a check that outlives the deadline, releases the slot and aborts the engine's signal", async () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    // Only setTimeout/clearTimeout are faked: faking setImmediate, nextTick or
    // queueMicrotask stalls Node's HTTP server and supertest never connects.
    jest.useFakeTimers({
      doNotFake: [
        "Date", "hrtime", "nextTick", "performance", "queueMicrotask",
        "requestAnimationFrame", "cancelAnimationFrame", "requestIdleCallback",
        "cancelIdleCallback", "setImmediate", "clearImmediate", "setInterval", "clearInterval",
      ],
    });
    try {
      let reached!: () => void;
      const started = new Promise<void>((resolve) => {
        reached = resolve;
      });
      let signal: AbortSignal | undefined;
      const runCheck = jest.fn((args: any) => {
        signal = args.signal;
        reached();
        return new Promise(() => {}) as Promise<any>;
      });
      const limiter = claimCheckRateLimiter({ perMinute: 100, perHour: 1000, maxInFlight: 1 });
      const { app } = buildApp({ runCheck, limiter });

      // .end() dispatches immediately and delivers the response through a
      // callback; superagent's promise form is lazy AND defers through
      // setTimeout, so it would never settle while the clock is faked.
      const pending = new Promise<{ status: number; body: any }>((resolve, reject) => {
        request(app)
          .post(CLAIM_CHECK_PATH)
          .send(BODY)
          .end((err, r) => (err ? reject(err) : resolve(r)));
      });
      await started;
      expect(signal!.aborted).toBe(false);

      await jest.advanceTimersByTimeAsync(CLAIM_CHECK_TIMEOUT_MS);
      // Back to real timers before reading the response: superagent defers its
      // own callbacks through setTimeout, which would never fire while faked.
      jest.useRealTimers();
      const res = await pending;

      expect(res.status).toBe(504);
      expect(String(res.body.detail)).toContain("60 seconds");
      // The engine's provider calls are cancelled, not left running.
      expect(signal!.aborted).toBe(true);
      // The in-flight slot was released on the timeout path too: maxInFlight
      // is 1, so an unreleased slot would make the next take() fail. (A second
      // HTTP request cannot test this here — this app's runCheck never
      // settles, so the request would simply hang.)
      expect(limiter.take("7").ok).toBe(true);
    } finally {
      jest.useRealTimers();
      warnSpy.mockRestore();
    }
  });

  // Fix round 2, parked item 6: this used to `await` supertest's PROMISE form
  // while setTimeout was faked. Superagent defers its own callbacks through
  // setTimeout, so settling that promise depended on a faked timer nobody
  // advanced — it passed only because of how node happened to schedule the
  // response, and flaked under load. A known flake in the suite that proves
  // the 429/413/403 gates on the most expensive endpoint in the product
  // trains people to re-run it, which is how a real failure gets re-run away.
  //
  // The fix removes the dependency instead of hiding it: dispatch with
  // `.end()` (immediate, callback-delivered), wait on a signal the HANDLER
  // raises — limiter.release(), which runs in its `finally` immediately after
  // `clearTimeout(deadline)` — and only then read the timer count. Nothing in
  // the test waits for a faked timer, so there is nothing left to race.
  // Request delivery itself needs no timers (it is socket I/O, which fake
  // timers do not touch); the 504 test above already relies on that.
  it("does not time out a check that finishes in time, and clears its timer", async () => {
    const inner = claimCheckRateLimiter({ perMinute: 100, perHour: 1000, maxInFlight: 10 });
    let handlerFinished!: () => void;
    const released = new Promise<void>((resolve) => (handlerFinished = resolve));
    const limiter = {
      ...inner,
      release: () => {
        inner.release();
        handlerFinished();
      },
    };

    jest.useFakeTimers({
      doNotFake: [
        "Date", "hrtime", "nextTick", "performance", "queueMicrotask",
        "requestAnimationFrame", "cancelAnimationFrame", "requestIdleCallback",
        "cancelIdleCallback", "setImmediate", "clearImmediate", "setInterval", "clearInterval",
      ],
    });
    try {
      const { app } = buildApp({ limiter });
      const pending = new Promise<{ status: number }>((resolve, reject) => {
        request(app)
          .post(CLAIM_CHECK_PATH)
          .send(BODY)
          .end((err, r) => (err ? reject(err) : resolve(r)));
      });

      // The handler has run to completion: its finally block cleared the
      // deadline and then released the slot, which is what resolves this.
      await released;
      // ...so no deadline timer is left behind. (Read while timers are still
      // faked — getTimerCount only sees the fake clock.)
      expect(jest.getTimerCount()).toBe(0);

      // Back to real timers before reading the response: superagent defers
      // its own callbacks through setTimeout, which would never fire while
      // faked.
      jest.useRealTimers();
      expect((await pending).status).toBe(200);
    } finally {
      jest.useRealTimers();
    }
  });

  // Finding 2: the docs tell a tenant who wants full coverage of a long
  // answer to raise claim_check.caps.maxSentences, but the 60s deadline was a
  // hard constant — raising the cap without raising this just moves the
  // 504 later, after more calls were spent. The deadline now reads
  // CLAIM_CHECK_TIMEOUT_MS so an operator can size both together.
  it("races the deadline from CLAIM_CHECK_TIMEOUT_MS instead of the hardcoded 60s default", async () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    const originalEnv = process.env.CLAIM_CHECK_TIMEOUT_MS;
    process.env.CLAIM_CHECK_TIMEOUT_MS = "500";
    jest.useFakeTimers({
      doNotFake: [
        "Date", "hrtime", "nextTick", "performance", "queueMicrotask",
        "requestAnimationFrame", "cancelAnimationFrame", "requestIdleCallback",
        "cancelIdleCallback", "setImmediate", "clearImmediate", "setInterval", "clearInterval",
      ],
    });
    try {
      let signal: AbortSignal | undefined;
      const runCheck = jest.fn((args: any) => {
        signal = args.signal;
        return new Promise(() => {}) as Promise<any>;
      });
      const limiter = claimCheckRateLimiter({ perMinute: 100, perHour: 1000, maxInFlight: 1 });
      const { app } = buildApp({ runCheck, limiter });

      const pending = new Promise<{ status: number; body: any }>((resolve, reject) => {
        request(app)
          .post(CLAIM_CHECK_PATH)
          .send(BODY)
          .end((err, r) => (err ? reject(err) : resolve(r)));
      });

      // The env-configured 500ms deadline has not elapsed yet — this would
      // still be well inside the hardcoded 60,000ms default too, so it only
      // proves the request is still pending, not which deadline is active.
      await jest.advanceTimersByTimeAsync(400);
      expect(signal?.aborted).toBeFalsy();

      // Crossing 500ms (but nowhere near 60,000ms) must trigger the timeout:
      // this is the assertion that fails if the module ignores the env var
      // and keeps racing the 60s constant.
      await jest.advanceTimersByTimeAsync(100);
      jest.useRealTimers();
      const res = await pending;

      expect(res.status).toBe(504);
      expect(String(res.body.detail)).toContain("0.5 seconds");
      expect(signal!.aborted).toBe(true);
    } finally {
      jest.useRealTimers();
      if (originalEnv === undefined) delete process.env.CLAIM_CHECK_TIMEOUT_MS;
      else process.env.CLAIM_CHECK_TIMEOUT_MS = originalEnv;
      warnSpy.mockRestore();
    }
  });

  it("500s and releases the limiter slot when the engine throws", async () => {
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const limiter = claimCheckRateLimiter({ perMinute: 2, perHour: 10, maxInFlight: 1 });
    const { app } = buildApp({ limiter, runCheck: jest.fn().mockRejectedValue(new Error("engine exploded")) });
    expect((await request(app).post(CLAIM_CHECK_PATH).send(BODY)).status).toBe(500);
    // The slot was released, so the next request is not blocked by maxInFlight.
    const second = await request(app).post(CLAIM_CHECK_PATH).send(BODY);
    expect(second.status).toBe(500);
    errorSpy.mockRestore();
  });
});

// Stage 4, Task B2: `content` is the only required field on a source. `id`
// becomes optional and positional, `type` is accepted but dropped before the
// engine sees it, and two sources naming the same id are a 400, not a merge.
describe("source normalisation", () => {
  it("accepts a source with only content, and assigns it a positional id", async () => {
    const runCheck = jest.fn().mockResolvedValue(RESULT);
    const { app } = buildApp({ runCheck });
    await post(app, { question: "q", answer: "a", sources: [{ content: "230 Volt." }] }).expect(200);
    expect(runCheck.mock.calls[0][0].sources).toEqual([{ id: "s1", content: "230 Volt." }]);
  });

  it("keeps a caller's own id and name, and carries type through without acting on it", async () => {
    const runCheck = jest.fn().mockResolvedValue(RESULT);
    const { app } = buildApp({ runCheck });
    await post(app, {
      question: "q", answer: "a",
      sources: [{ id: "memory:m_7", name: "Sprache", type: "memory", content: "Deutsch." }],
    }).expect(200);
    expect(runCheck.mock.calls[0][0].sources).toEqual([{ id: "memory:m_7", name: "Sprache", content: "Deutsch." }]);
  });

  it("does not let a generated id collide with one the caller supplied", async () => {
    const runCheck = jest.fn().mockResolvedValue(RESULT);
    const { app } = buildApp({ runCheck });
    await post(app, { question: "q", answer: "a", sources: [{ content: "first" }, { id: "s1", content: "second" }] }).expect(200);
    const ids = runCheck.mock.calls[0][0].sources.map((s: { id: string }) => s.id);
    expect(new Set(ids).size).toBe(2);
    expect(ids).toContain("s1");
  });

  // Review Focus 5
  it("rejects two sources that supply the same id rather than merging them", async () => {
    const { app } = buildApp({});
    const res = await post(app, {
      question: "q", answer: "a",
      sources: [{ id: "doc", content: "one" }, { id: "doc", content: "two" }],
    }).expect(400);
    expect(res.body.detail).toMatch(/duplicate source id/i);
  });

  it("rejects an unknown source type", async () => {
    const { app } = buildApp({});
    await post(app, { question: "q", answer: "a", sources: [{ content: "x", type: "guesswork" }] }).expect(400);
  });

  it("still accepts the Stage 1 shape, id and all", async () => {
    const runCheck = jest.fn().mockResolvedValue(RESULT);
    const { app } = buildApp({ runCheck });
    await post(app, { question: "q", answer: "a", sources: [{ id: "i1", name: "h.pdf", content: "x" }] }).expect(200);
    expect(runCheck.mock.calls[0][0].sources[0].id).toBe("i1");
  });
});

describe("resolveClaimCheckTimeoutMs", () => {
  const originalEnv = process.env.CLAIM_CHECK_TIMEOUT_MS;

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.CLAIM_CHECK_TIMEOUT_MS;
    else process.env.CLAIM_CHECK_TIMEOUT_MS = originalEnv;
  });

  it("falls back to the 60s default when the env var is unset", () => {
    delete process.env.CLAIM_CHECK_TIMEOUT_MS;
    expect(resolveClaimCheckTimeoutMs()).toBe(CLAIM_CHECK_TIMEOUT_MS);
  });

  it("reads a valid positive value from the env var", () => {
    process.env.CLAIM_CHECK_TIMEOUT_MS = "120000";
    expect(resolveClaimCheckTimeoutMs()).toBe(120_000);
  });

  // The deadline must never be disabled: a cap raise without a matching
  // deadline raise is strictly worse than the default's own "partial"
  // degradation, so garbage input has to land back on a real, finite
  // deadline rather than NaN (which never fires) or a negative/zero value
  // (which fires immediately or not at all).
  it.each([
    ["non-numeric", "not-a-number"],
    ["empty string", ""],
    ["zero", "0"],
    ["negative", "-5000"],
    ["a numeric prefix followed by garbage", "5000ms"],
  ])("falls back to the default for a %s value", (_label, raw) => {
    process.env.CLAIM_CHECK_TIMEOUT_MS = raw;
    expect(resolveClaimCheckTimeoutMs()).toBe(CLAIM_CHECK_TIMEOUT_MS);
  });
});

describe("persistence", () => {
  it("stores the result when the request names a session and a message", async () => {
    const saveClaimCheck = jest.fn().mockResolvedValue(undefined);
    const { app } = buildApp({ saveClaimCheck });
    const res = await request(app)
      .post(CLAIM_CHECK_PATH)
      .send({ ...BODY, session: "11111111-1111-4111-8111-111111111111", messageId: "msg_1" });
    expect(res.status).toBe(200);
    expect(saveClaimCheck).toHaveBeenCalledTimes(1);
    expect(saveClaimCheck.mock.calls[0][0]).toEqual(
      expect.objectContaining({ session: "11111111-1111-4111-8111-111111111111", messageId: "msg_1", userId: 7 }),
    );
  });

  it("does not store anything when the request names no session", async () => {
    const saveClaimCheck = jest.fn();
    const { app } = buildApp({ saveClaimCheck });
    expect((await request(app).post(CLAIM_CHECK_PATH).send(BODY)).status).toBe(200);
    expect(saveClaimCheck).not.toHaveBeenCalled();
  });

  it("still answers 200 when the write fails — a lost panel must not fail the check", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { app } = buildApp({ saveClaimCheck: jest.fn().mockRejectedValue(new Error("db down")) });
      const res = await request(app)
        .post(CLAIM_CHECK_PATH)
        .send({ ...BODY, session: "11111111-1111-4111-8111-111111111111", messageId: "msg_1" });
      expect(res.status).toBe(200);
      expect(res.body.score.label).toBe("ok");
    } finally {
      warn.mockRestore();
    }
  });

  // Review Focus 3
  it("calls saveClaimCheck again, with the same key, for a repeated check on the same message", async () => {
    const saveClaimCheck = jest.fn().mockResolvedValue(undefined);
    const { app } = buildApp({ saveClaimCheck });
    const body = { ...BODY, session: "11111111-1111-4111-8111-111111111111", messageId: "msg_1" };
    await request(app).post(CLAIM_CHECK_PATH).send(body);
    await request(app).post(CLAIM_CHECK_PATH).send(body);
    expect(saveClaimCheck).toHaveBeenCalledTimes(2);
    // This only proves the handler calls the dep again with the same
    // (session, messageId) key on a repeat — it says nothing about whether
    // the row is actually replaced rather than duplicated. That guarantee is
    // the dep's own contract (upsert by (session, message_id, user), never a
    // delete) and is proven against a real query builder in
    // src/exulu/claim-check/store.test.ts, not here.
    expect(saveClaimCheck.mock.calls[1][0].messageId).toBe("msg_1");
  });

  it("does not store anything when the named session is not a uuid", async () => {
    const saveClaimCheck = jest.fn();
    const { app } = buildApp({ saveClaimCheck });
    const res = await request(app)
      .post(CLAIM_CHECK_PATH)
      .send({ ...BODY, session: "not-a-uuid", messageId: "msg_1" });
    expect(res.status).toBe(200);
    expect(saveClaimCheck).not.toHaveBeenCalled();
  });
});

// Fix round 2, Important 5: §5.2's Redis result cache was deferred from stage
// 1 because "nothing fires a check repeatedly until the chat surface exists" —
// a rationale this branch expires. The stored row was never consulted, so a
// double-fire, a user-initiated re-check or a retry after a transport hiccup
// paid ~8 provider calls again for a verdict already on disk.
describe("stored-result lookup", () => {
  const SESSION = "11111111-1111-4111-8111-111111111111";
  const stored = { ...BODY, session: SESSION, messageId: "msg_1" };

  it("returns the stored check and never runs the engine", async () => {
    const findClaimCheck = jest.fn().mockResolvedValue(RESULT);
    const saveClaimCheck = jest.fn();
    const { app, runCheck } = buildApp({ findClaimCheck, saveClaimCheck });
    const res = await request(app).post(CLAIM_CHECK_PATH).send(stored);

    expect(res.status).toBe(200);
    expect(res.body).toEqual(RESULT);
    expect(runCheck).not.toHaveBeenCalled();
    // Nothing new to persist, and re-saving would touch updatedAt for no gain.
    expect(saveClaimCheck).not.toHaveBeenCalled();
    expect(findClaimCheck.mock.calls[0][0]).toEqual({ session: SESSION, messageId: "msg_1", userId: 7 });
  });

  it("serves a response byte-identical to the engine's", async () => {
    const live = await request(buildApp().app).post(CLAIM_CHECK_PATH).send(stored);
    const cached = await request(buildApp({ findClaimCheck: jest.fn().mockResolvedValue(RESULT) }).app)
      .post(CLAIM_CHECK_PATH)
      .send(stored);
    expect(cached.status).toBe(live.status);
    expect(cached.body).toEqual(live.body);
  });

  it("runs the check when nothing is stored for this message", async () => {
    const { app, runCheck } = buildApp({ findClaimCheck: jest.fn().mockResolvedValue(undefined) });
    expect((await request(app).post(CLAIM_CHECK_PATH).send(stored)).status).toBe(200);
    expect(runCheck).toHaveBeenCalledTimes(1);
  });

  it("falls through to running the check when the lookup fails", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { app, runCheck } = buildApp({
        findClaimCheck: jest.fn().mockRejectedValue(new Error("db down")),
      });
      const res = await request(app).post(CLAIM_CHECK_PATH).send(stored);
      expect(res.status).toBe(200);
      expect(res.body.score.label).toBe("ok");
      expect(runCheck).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it("does not look anything up when the request names no session and message", async () => {
    const findClaimCheck = jest.fn();
    const { app, runCheck } = buildApp({ findClaimCheck });
    expect((await request(app).post(CLAIM_CHECK_PATH).send(BODY)).status).toBe(200);
    expect(findClaimCheck).not.toHaveBeenCalled();
    expect(runCheck).toHaveBeenCalledTimes(1);
  });

  it("does not look anything up for a session id that is not a uuid", async () => {
    const findClaimCheck = jest.fn();
    const { app } = buildApp({ findClaimCheck });
    const res = await request(app)
      .post(CLAIM_CHECK_PATH)
      .send({ ...BODY, session: "not-a-uuid", messageId: "msg_1" });
    expect(res.status).toBe(200);
    expect(findClaimCheck).not.toHaveBeenCalled();
  });

  // The lookup sits AFTER every gate: a stored row must not become a way to
  // read a verdict for an agent whose admin has since turned the check off,
  // or one the caller may not use.
  it("still 403s for an agent with the check disabled, stored row or not", async () => {
    const findClaimCheck = jest.fn().mockResolvedValue(RESULT);
    const { app } = buildApp({
      findClaimCheck,
      getAgent: async () => ({ id: "agent-1", model: "m", tools: [] }) as any,
    });
    const res = await request(app).post(CLAIM_CHECK_PATH).send({ ...stored, agent: "agent-1" });
    expect(res.status).toBe(403);
    expect(findClaimCheck).not.toHaveBeenCalled();
  });

  it("is skipped entirely when the dep is not wired", async () => {
    const { app, runCheck } = buildApp({ findClaimCheck: undefined });
    expect((await request(app).post(CLAIM_CHECK_PATH).send(stored)).status).toBe(200);
    expect(runCheck).toHaveBeenCalledTimes(1);
  });
});

// Fix round 2, Minor 2 and Minor 3, and parked item 2.
describe("persistence edge cases", () => {
  const SESSION = "11111111-1111-4111-8111-111111111111";
  const stored = { ...BODY, session: SESSION, messageId: "msg_1" };

  // M2: completedResult used to be set AFTER res.json. If the client has gone
  // away and the send throws, the check had been paid for and was then
  // discarded — the one case where persisting matters most.
  it("persists the result even when sending the response throws", async () => {
    const saveClaimCheck = jest.fn().mockResolvedValue(undefined);
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { deps } = buildApp({ saveClaimCheck });
      const app = express();
      app.use(express.json());
      // One throwing res.json, as a client that disconnected mid-send looks
      // to the handler; the handler's own error path may still answer.
      app.use((_req, res, next) => {
        const original = res.json.bind(res);
        let thrown = false;
        res.json = ((body: unknown) => {
          if (!thrown) {
            thrown = true;
            throw new Error("client has gone away");
          }
          return original(body as never);
        }) as never;
        next();
      });
      registerClaimCheckRoutes(app, deps);

      await request(app).post(CLAIM_CHECK_PATH).send(stored);
      expect(saveClaimCheck).toHaveBeenCalledTimes(1);
      expect(saveClaimCheck.mock.calls[0][0].result).toEqual(RESULT);
    } finally {
      errorSpy.mockRestore();
    }
  });

  // M3: the GET 500s loudly on an unwired dep while this path skipped in
  // silence, so a dropped wiring showed up only as a panel that never
  // survived a reload.
  it("logs an error when saveClaimCheck is missing but a session and message were named", async () => {
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { app } = buildApp({ saveClaimCheck: undefined });
      expect((await request(app).post(CLAIM_CHECK_PATH).send(stored)).status).toBe(200);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("saveClaimCheck is not wired"));
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("stays silent about the missing dep when no session was named", async () => {
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { app } = buildApp({ saveClaimCheck: undefined });
      expect((await request(app).post(CLAIM_CHECK_PATH).send(BODY)).status).toBe(200);
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });
});

// Parked item 2: auth.code describes the authentication ATTEMPT. When a
// principal comes back whose id cannot key a row, that attempt may have
// "succeeded" — and echoing its code answered a 200 (or a future branch's 0)
// with an "Unauthorized." body.
describe("a principal with an unusable id is always 401", () => {
  const SESSION = "11111111-1111-4111-8111-111111111111";

  it.each([
    ["a successful attempt (code 200)", { user: { id: "not-a-number" } as any, code: 200 }],
    ["an attempt that left the code unset", { user: { id: "not-a-number" } as any }],
    ["a code of 0", { user: { id: "not-a-number" } as any, code: 0 }],
  ])("POST answers 401 for %s", async (_label, auth) => {
    const { app, runCheck } = buildApp({ authenticate: async () => auth });
    expect((await request(app).post(CLAIM_CHECK_PATH).send(BODY)).status).toBe(401);
    expect(runCheck).not.toHaveBeenCalled();
  });

  it.each([
    ["a successful attempt (code 200)", { user: { id: "not-a-number" } as any, code: 200 }],
    ["an attempt that left the code unset", { user: { id: "not-a-number" } as any }],
    ["a code of 0", { user: { id: "not-a-number" } as any, code: 0 }],
  ])("GET answers 401 for %s", async (_label, auth) => {
    const listClaimChecks = jest.fn();
    const { app } = buildApp({ authenticate: async () => auth, listClaimChecks });
    expect((await request(app).get(`/claims/check/${SESSION}`)).status).toBe(401);
    expect(listClaimChecks).not.toHaveBeenCalled();
  });

  it("still passes a genuine auth failure's own code through", async () => {
    const { app } = buildApp({
      authenticate: async () => ({ error: true, code: 403, message: "key disabled" }),
    });
    expect((await request(app).post(CLAIM_CHECK_PATH).send(BODY)).status).toBe(403);
    expect((await request(app).get(`/claims/check/${SESSION}`)).status).toBe(403);
  });
});

describe(`GET ${CLAIM_CHECK_SESSION_PATH}`, () => {
  it("returns stored checks keyed by message id", async () => {
    const listClaimChecks = jest.fn().mockResolvedValue({ msg_1: RESULT });
    const { app } = buildApp({ listClaimChecks });
    const res = await request(app).get("/claims/check/11111111-1111-4111-8111-111111111111");
    expect(res.status).toBe(200);
    expect(res.body.checks.msg_1.score.label).toBe("ok");
    expect(listClaimChecks.mock.calls[0][0]).toEqual(
      expect.objectContaining({ session: "11111111-1111-4111-8111-111111111111", userId: 7 }),
    );
  });

  it("404s when the deployment is not licensed", async () => {
    const { app } = buildApp({ isLicensed: () => false });
    expect((await request(app).get("/claims/check/11111111-1111-4111-8111-111111111111")).status).toBe(404);
  });

  it("401s when authentication fails", async () => {
    const { app } = buildApp({ authenticate: async () => ({ error: true, code: 401, message: "no key" }) });
    expect((await request(app).get("/claims/check/11111111-1111-4111-8111-111111111111")).status).toBe(401);
  });

  // Review Focus 4
  it("400s on a session id that is not a uuid, without touching the database or authenticating", async () => {
    const listClaimChecks = jest.fn();
    const authenticate = jest.fn();
    const { app } = buildApp({ listClaimChecks, authenticate });
    expect((await request(app).get("/claims/check/not-a-uuid")).status).toBe(400);
    expect(listClaimChecks).not.toHaveBeenCalled();
    // Pins the ordering: the uuid shape is checked before anything that
    // would touch auth or the database, so a junk path segment never reaches
    // either.
    expect(authenticate).not.toHaveBeenCalled();
  });

  // Review Focus 4
  it("scopes the lookup to the caller, so another tenant's checks cannot be read", async () => {
    const listClaimChecks = jest.fn().mockResolvedValue({});
    const { app } = buildApp({
      listClaimChecks,
      authenticate: async () => ({ user: { id: 99, type: "user" } as any }),
    });
    await request(app).get("/claims/check/11111111-1111-4111-8111-111111111111");
    expect(listClaimChecks.mock.calls[0][0].userId).toBe(99);
  });

  it("returns an empty object for a session with no checks", async () => {
    const { app } = buildApp({ listClaimChecks: jest.fn().mockResolvedValue({}) });
    const res = await request(app).get("/claims/check/11111111-1111-4111-8111-111111111111");
    expect(res.status).toBe(200);
    expect(res.body.checks).toEqual({});
  });

  it("500s when the stored-check lookup throws", async () => {
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { app } = buildApp({ listClaimChecks: jest.fn().mockRejectedValue(new Error("db down")) });
      const res = await request(app).get("/claims/check/11111111-1111-4111-8111-111111111111");
      expect(res.status).toBe(500);
    } finally {
      errorSpy.mockRestore();
    }
  });

  // A missing dep is a deployment wiring defect, not "nothing stored" — a
  // silent 200 {checks:{}} here would make a future regression that drops
  // the wiring read as an empty, legitimate result instead of failing loudly.
  it("500s when listClaimChecks is not wired, instead of silently answering empty", async () => {
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { app } = buildApp({ listClaimChecks: undefined });
      const res = await request(app).get("/claims/check/11111111-1111-4111-8111-111111111111");
      expect(res.status).toBe(500);
    } finally {
      errorSpy.mockRestore();
    }
  });
});
