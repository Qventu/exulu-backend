import { toWorkflowTriggerPayload } from "./resolver-helpers";
import type { WorkflowTriggerRow } from "./types";

const row: WorkflowTriggerRow = {
  id: "t1", workflow: "w1", type: "email", enabled: true,
  secret: "SECRET", signing_secret: "enc", last_fired_at: null,
  config: {}, run_as_user: 1, run_as_role: null,
};

describe("toWorkflowTriggerPayload", () => {
  it("exposes webhook_url to writers and hides it from readers", () => {
    process.env.BACKEND = "https://api.example.com";
    const writer = toWorkflowTriggerPayload(row, { canWrite: true });
    expect(writer.webhook_url).toBe("https://api.example.com/webhooks/routine/SECRET");
    expect(writer.has_webhook).toBe(true);
    expect(writer.has_signing_secret).toBe(true);
    const reader = toWorkflowTriggerPayload(row, { canWrite: false });
    expect(reader.webhook_url).toBeNull();
    expect(reader.has_webhook).toBe(true);
  });
  it("passes signing_secret_once only when provided", () => {
    expect(toWorkflowTriggerPayload(row, { canWrite: true }).signing_secret_once).toBeNull();
    expect(toWorkflowTriggerPayload(row, { canWrite: true, signingSecretOnce: "plain" }).signing_secret_once).toBe("plain");
  });
});
