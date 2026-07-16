import type { BullMqJobData } from "@EE/queues/decorator";
import { bullmq } from "./bullmq";

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
