import { createAuditS3Writer } from "./s3-writer";

const target = { s3region: "r", s3key: "k", s3secret: "s", s3Bucket: "b", s3prefix: "audit/" };

describe("createAuditS3Writer", () => {
  it("PUTs the NDJSON body to the bucket/key", async () => {
    const sent: any[] = [];
    const client = { send: async (cmd: any) => { sent.push(cmd.input ?? cmd); } };
    const writer = createAuditS3Writer(target, client as any);
    await writer.putNdjson("audit/dt=2026-07-28/12/1-x.ndjson", "{\"a\":1}\n");
    expect(sent).toHaveLength(1);
    expect(sent[0].Bucket).toBe("b");
    expect(sent[0].Key).toBe("audit/dt=2026-07-28/12/1-x.ndjson");
    expect(sent[0].ContentType).toBe("application/x-ndjson");
    expect(Buffer.from(sent[0].Body).toString()).toBe("{\"a\":1}\n");
  });

  it("retries once on SignatureDoesNotMatch then succeeds", async () => {
    let calls = 0;
    const client = {
      send: async () => {
        calls += 1;
        if (calls === 1) { const e: any = new Error("sig"); e.name = "SignatureDoesNotMatch"; throw e; }
      },
    };
    const writer = createAuditS3Writer(target, client as any, { backoffMs: () => 0 });
    await writer.putNdjson("k", "body");
    expect(calls).toBe(2);
  });

  it("throws immediately on a non-auth error", async () => {
    const client = { send: async () => { throw new Error("boom"); } };
    const writer = createAuditS3Writer(target, client as any, { backoffMs: () => 0 });
    await expect(writer.putNdjson("k", "body")).rejects.toThrow("boom");
  });

  it("rejects after exhausting all retries on persistent SignatureDoesNotMatch and calls send exactly maxRetries times", async () => {
    let calls = 0;
    const client = {
      send: async () => {
        calls += 1;
        const e: any = new Error("sig");
        e.name = "SignatureDoesNotMatch";
        throw e;
      },
    };
    const writer = createAuditS3Writer(target, client as any, { maxRetries: 3, backoffMs: () => 0 });
    await expect(writer.putNdjson("k", "body")).rejects.toMatchObject({ name: "SignatureDoesNotMatch" });
    expect(calls).toBe(3);
  });
});
