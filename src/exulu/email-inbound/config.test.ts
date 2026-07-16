process.env.NEXTAUTH_SECRET = "test-secret-for-email-inbound";

import {
  EMAIL_INBOUND_CONFIG_KEY,
  bumpLastWebhookAt,
  getEmailInboundConfig,
  updateEmailInboundConfig,
} from "./config";

type FakeDbState = {
  row: { config_value: unknown } | undefined;
  inserted: any[];
  merged: any[];
};

// Chainable fake for the platform_configurations read/write pattern
// (.where().first() reads; .insert().onConflict().merge() writes).
const makeDb = (initialValue?: Record<string, unknown>) => {
  const state: FakeDbState = {
    row: initialValue !== undefined ? { config_value: initialValue } : undefined,
    inserted: [],
    merged: [],
  };
  const builder: any = {
    where: jest.fn(() => builder),
    first: jest.fn(async () => state.row),
    insert: jest.fn((values: any) => {
      state.inserted.push(values);
      return {
        onConflict: jest.fn(() => ({
          merge: jest.fn(async (merged: any) => {
            state.merged.push(merged);
            // emulate the upsert so subsequent reads see the new value
            state.row = { config_value: JSON.parse(merged.config_value) };
          }),
        })),
      };
    }),
  };
  const db: any = { from: jest.fn(() => builder) };
  return { db, state };
};

describe("email inbound platform config", () => {
  it("returns safe defaults when the row is missing", async () => {
    const { db } = makeDb();
    const config = await getEmailInboundConfig(db);
    expect(config).toEqual({
      provider: null,
      inbound_domain: null,
      enabled: false,
      last_webhook_at: null,
      signing_key: null,
    });
  });

  it("encrypts the signing key at rest and decrypts on read", async () => {
    const { db, state } = makeDb();
    await updateEmailInboundConfig(db, {
      provider: "mailgun-eu",
      inbound_domain: "mail.client.com",
      enabled: true,
      signing_key: "mg-signing-key-123",
    });
    const stored = JSON.parse(state.merged[0].config_value);
    expect(stored.signing_key).toBeDefined();
    expect(stored.signing_key).not.toContain("mg-signing-key-123");

    const roundtrip = await getEmailInboundConfig(db);
    expect(roundtrip.signing_key).toBe("mg-signing-key-123");
    expect(roundtrip.provider).toBe("mailgun-eu");
    expect(roundtrip.inbound_domain).toBe("mail.client.com");
    expect(roundtrip.enabled).toBe(true);
    expect(state.inserted[0].config_key).toBe(EMAIL_INBOUND_CONFIG_KEY);
  });

  it("merges partial patches without dropping the stored signing key", async () => {
    const { db } = makeDb();
    await updateEmailInboundConfig(db, {
      inbound_domain: "mail.client.com",
      signing_key: "keep-me",
    });
    await updateEmailInboundConfig(db, { enabled: true });
    const config = await getEmailInboundConfig(db);
    expect(config.enabled).toBe(true);
    expect(config.inbound_domain).toBe("mail.client.com");
    expect(config.signing_key).toBe("keep-me");
  });

  it("bumpLastWebhookAt stamps an ISO timestamp and keeps other fields", async () => {
    const { db } = makeDb({ provider: "mailgun-eu", enabled: true });
    await bumpLastWebhookAt(db);
    const config = await getEmailInboundConfig(db);
    expect(config.provider).toBe("mailgun-eu");
    expect(config.last_webhook_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
