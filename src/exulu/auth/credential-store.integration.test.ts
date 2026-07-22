/**
 * Real-Postgres roundtrip for the credential store — the exact gap that let
 * the jsonb-ciphertext bug through (spec 2026-07-22 §1.1: every other test
 * mocks the DB). Guarded: only runs with EXULU_DB_INTEGRATION_TESTS=true.
 *
 * Run:
 *   EXULU_DB_INTEGRATION_TESTS=true POSTGRES_DB_HOST=localhost \
 *   POSTGRES_DB_PORT=5432 POSTGRES_DB_USER=postgres \
 *   POSTGRES_DB_PASSWORD=password POSTGRES_DB_NAME=exulu_cred_test \
 *   npx jest src/exulu/auth/credential-store.integration.test.ts
 */
const enabled = process.env.EXULU_DB_INTEGRATION_TESTS === "true";
const describeIf = enabled ? describe : describe.skip;

import { postgresClient } from "@SRC/postgres/client";
import { userCredentialsSchema } from "@SRC/postgres/core-schema";
import { migrateUserCredentialsDataColumn } from "@SRC/postgres/init-exulu-db";
import { credentialStore } from "./credential-store";

const TEST_PROVIDER = "cred_store_itest";
const TEST_USER_ID = 987654;

describeIf("credentialStore against real Postgres", () => {
  beforeAll(async () => {
    process.env.NEXTAUTH_SECRET ??= "integration-test-secret";
    const { db } = await postgresClient();
    await db.raw(userCredentialsSchema());
    await migrateUserCredentialsDataColumn(db);
    await credentialStore.delete(TEST_PROVIDER, TEST_USER_ID);
  });

  afterAll(async () => {
    const { db } = await postgresClient();
    await credentialStore.delete(TEST_PROVIDER, TEST_USER_ID);
    await db.destroy();
  });

  it("roundtrips insert → get with encrypted-at-rest values", async () => {
    await credentialStore.upsert({
      provider: TEST_PROVIDER,
      userId: TEST_USER_ID,
      authType: "user_credentials",
      data: { subdomain: "acme", apiKey: "secret-123" },
    });
    const record = await credentialStore.get(TEST_PROVIDER, TEST_USER_ID);
    expect(record?.data).toEqual({ subdomain: "acme", apiKey: "secret-123" });

    // At rest the row must NOT contain the plaintext value.
    const { db } = await postgresClient();
    const raw = await db
      .from("user_credentials")
      .where({ provider: TEST_PROVIDER, user_id: String(TEST_USER_ID) })
      .first();
    expect(String(raw.data)).not.toContain("secret-123");
  });

  it("updates in place on second upsert (ON CONFLICT path)", async () => {
    await credentialStore.upsert({
      provider: TEST_PROVIDER,
      userId: TEST_USER_ID,
      authType: "user_credentials",
      data: { subdomain: "acme", apiKey: "rotated-456" },
    });
    const record = await credentialStore.get(TEST_PROVIDER, TEST_USER_ID);
    expect(record?.data).toEqual({ subdomain: "acme", apiKey: "rotated-456" });

    const { db } = await postgresClient();
    const count = await db
      .from("user_credentials")
      .where({ provider: TEST_PROVIDER })
      .count("id as n");
    expect(Number((count[0] as any).n)).toBe(1);
  });

  it("lists metadata (never values) and deletes", async () => {
    const list = await credentialStore.listByUser(TEST_USER_ID);
    const entry = list.find((c) => c.provider === TEST_PROVIDER);
    expect(entry?.authType).toBe("user_credentials");
    expect(entry && "data" in (entry as object)).toBe(false);

    await credentialStore.delete(TEST_PROVIDER, TEST_USER_ID);
    expect(await credentialStore.get(TEST_PROVIDER, TEST_USER_ID)).toBeNull();
  });
});
