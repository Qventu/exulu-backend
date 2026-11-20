import type { BullMqJobData } from "@EE/queues/decorator";
import { bullmq } from "./bullmq";
import { channelJobOptions } from "@SRC/exulu/channels/act";

const base: BullMqJobData = {
  label: "Email intake",
  type: "email_intake",
  trigger: "api",
  timeoutInSeconds: 300,
  inputs: { s3Key: "email-inbound/raw-1.eml" },
};

describe("bullmq.validate", () => {
  it("accepts email_intake jobs without a workflow/embedder/processor target", () => {
    expect(() => bullmq.validate("job-1", base)).not.toThrow();
  });

  it("accepts import jobs without a workflow/embedder/processor target", () => {
    expect(() =>
      bullmq.validate("job-1", {
        ...base,
        type: "import",
        inputs: {},
        jobResultId: "jr-1",
        context: "ctx-1",
      }),
    ).not.toThrow();
  });

  it("accepts channel_message jobs without a workflow/embedder/processor target", () => {
    expect(() =>
      // the job id as channels/act.ts builds it: a hash, never the raw message id
      bullmq.validate(channelJobOptions("wamid.1").jobId, {
        ...base,
        label: "WhatsApp message",
        type: "channel_message",
        timeoutInSeconds: 600,
        inputs: { channelId: "c", threadId: "t", identity: "i", userId: 7, messageId: "m", text: "x", newSession: false },
      }),
    ).not.toThrow();
  });

  it("still rejects unknown job types", () => {
    expect(() => bullmq.validate("job-1", { ...base, type: "bogus" })).toThrow(
      /must be of value/,
    );
  });

  it("still requires a target for other job types", () => {
    expect(() => bullmq.validate("job-1", { ...base, type: "workflow" })).toThrow(
      /must be set/,
    );
  });

  it("still requires inputs", () => {
    expect(() =>
      bullmq.validate("job-1", { ...base, inputs: undefined } as unknown as BullMqJobData),
    ).toThrow(/inputs/);
  });
});
