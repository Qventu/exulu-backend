// ee/claim-check/routes.test.ts
import express from "express";
import request from "supertest";
import {
  registerClaimCheckRoutes,
  CLAIM_CHECK_PATH,
  CLAIM_CHECK_TIMEOUT_MS,
  resolveClaimCheckTimeoutMs,
  type ClaimCheckRouteDeps,
} from "./routes";
import { claimCheckRateLimiter } from "./rate-limit";

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
    ...overrides,
  };
  const app = express();
  app.use(express.json({ limit: "20mb" }));
  registerClaimCheckRoutes(app, deps);
  return { app, deps, runCheck: deps.runCheck as jest.Mock };
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

  it("does not time out a check that finishes in time, and clears its timer", async () => {
    jest.useFakeTimers({
      doNotFake: [
        "Date", "hrtime", "nextTick", "performance", "queueMicrotask",
        "requestAnimationFrame", "cancelAnimationFrame", "requestIdleCallback",
        "cancelIdleCallback", "setImmediate", "clearImmediate", "setInterval", "clearInterval",
      ],
    });
    try {
      const { app } = buildApp();
      const res = await request(app).post(CLAIM_CHECK_PATH).send(BODY);
      expect(res.status).toBe(200);
      expect(jest.getTimerCount()).toBe(0);
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
