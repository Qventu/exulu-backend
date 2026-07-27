import { createHmac } from "node:crypto";
import { createRoutineWebhookHandler, type RoutineWebhookDeps } from "./webhook";
import type { WorkflowTriggerRow } from "./types";

const trigger = (over: Partial<WorkflowTriggerRow> = {}): WorkflowTriggerRow => ({
  id: "trg-1", workflow: "wf-1", type: "email", enabled: true,
  secret: "s3cr3t", signing_secret: null, last_fired_at: null,
  config: {}, run_as_user: 1, run_as_role: null, ...over,
});

const makeRes = () => {
  const res: any = { statusCode: 0, body: null };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: any) => { res.body = b; return res; };
  return res;
};

const makeReq = (over: any = {}) => ({
  params: { secret: "s3cr3t" },
  headers: { "content-type": "application/json" },
  body: Buffer.from(JSON.stringify({ from: "a@b.com" }), "utf8"),
  ...over,
});

const makeDeps = (over: Partial<RoutineWebhookDeps> = {}): RoutineWebhookDeps => ({
  licensedForQueues: () => true,
  getDb: async () => ({}),
  getRedis: async () => ({ set: async () => "OK" }),
  resolveTrigger: async () => trigger(),
  decryptSigningSecret: (v) => v,
  putRawPayload: jest.fn(async () => "inbound-webhook/x.json") as any,
  enqueueIntake: jest.fn(async () => undefined) as any,
  stampLastFiredAt: async () => undefined,
  rateLimitExceeded: () => false,
  ...over,
});

describe("createRoutineWebhookHandler", () => {
  it("404s on an unknown/disabled secret", async () => {
    const res = makeRes();
    await createRoutineWebhookHandler(makeDeps({ resolveTrigger: async () => undefined }))(makeReq() as any, res);
    expect(res.statusCode).toBe(404);
  });

  it("fires: persists + enqueues a json job and ACKs 200", async () => {
    const deps = makeDeps();
    const res = makeRes();
    await createRoutineWebhookHandler(deps)(makeReq() as any, res);
    expect(res.statusCode).toBe(200);
    expect((deps.enqueueIntake as jest.Mock)).toHaveBeenCalledWith(
      expect.objectContaining({ triggerId: "trg-1", format: "json" }),
    );
  });

  it("401s when signing is enabled and the signature is missing", async () => {
    const res = makeRes();
    await createRoutineWebhookHandler(makeDeps({ resolveTrigger: async () => trigger({ signing_secret: "enc" }) }))(
      makeReq() as any, res,
    );
    expect(res.statusCode).toBe(401);
  });

  it("200s when signing is enabled and the signature is valid", async () => {
    const body = Buffer.from(JSON.stringify({ from: "a@b.com" }), "utf8");
    const sig = "sha256=" + createHmac("sha256", "plain").update(body).digest("hex");
    const res = makeRes();
    await createRoutineWebhookHandler(
      makeDeps({ resolveTrigger: async () => trigger({ signing_secret: "enc" }), decryptSigningSecret: () => "plain" }),
    )(makeReq({ body, headers: { "content-type": "application/json", "x-exulu-signature": sig } }) as any, res);
    expect(res.statusCode).toBe(200);
  });

  it("503s without the queues entitlement", async () => {
    const res = makeRes();
    await createRoutineWebhookHandler(makeDeps({ licensedForQueues: () => false }))(makeReq() as any, res);
    expect(res.statusCode).toBe(503);
  });
});
