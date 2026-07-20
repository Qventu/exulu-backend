import CryptoJS from "crypto-js";

type Row = Record<string, any>;
const rows: Row[] = [];

const matches = (row: Row, criteria: Row) =>
  Object.entries(criteria).every(([key, value]) => row[key] === value);

const mockDb = {
  from: (_table: string) => ({
    where: (criteria: Row) => ({
      first: async () => rows.find((row) => matches(row, criteria)),
      update: async (values: Row) => {
        const row = rows.find((r) => matches(r, criteria));
        if (row) Object.assign(row, values);
      },
      del: async () => {
        const index = rows.findIndex((row) => matches(row, criteria));
        if (index >= 0) rows.splice(index, 1);
      },
    }),
    insert: async (values: Row) => {
      rows.push({ ...values });
    },
  }),
};

jest.mock("@SRC/postgres/client", () => ({
  postgresClient: jest.fn(async () => ({ db: mockDb })),
}));

import { credentialStore } from "./credential-store";

beforeAll(() => {
  process.env.NEXTAUTH_SECRET = "test-secret";
});

beforeEach(() => {
  rows.length = 0;
});

describe("credentialStore", () => {
  it("returns null when no row exists", async () => {
    expect(await credentialStore.get("test-p", 1)).toBeNull();
  });

  it("round-trips an oauth blob", async () => {
    await credentialStore.upsert({
      provider: "test-p",
      userId: 1,
      authType: "oauth",
      data: {
        accessToken: "at",
        refreshToken: "rt",
        tokenType: "Bearer",
        scopes: "read:a",
        expiresAt: "2030-01-01T00:00:00.000Z",
      },
    });
    const got = await credentialStore.get("test-p", 1);
    expect(got?.data).toEqual({
      accessToken: "at",
      refreshToken: "rt",
      tokenType: "Bearer",
      scopes: "read:a",
      expiresAt: "2030-01-01T00:00:00.000Z",
    });
    expect(got?.authType).toBe("oauth");
    expect(got?.provider).toBe("test-p");
    expect(got?.userId).toBe(1);
  });

  it("round-trips a user_credentials blob", async () => {
    await credentialStore.upsert({
      provider: "test-p",
      userId: 2,
      authType: "user_credentials",
      data: { subdomain: "acme", apiKey: "secret" },
    });
    const got = await credentialStore.get("test-p", 2);
    expect(got?.data).toEqual({ subdomain: "acme", apiKey: "secret" });
    expect(got?.authType).toBe("user_credentials");
  });

  it("encrypts blob at rest (stored value is not plaintext)", async () => {
    await credentialStore.upsert({
      provider: "test-p",
      userId: 3,
      authType: "oauth",
      data: { accessToken: "plain-access", refreshToken: "plain-refresh" },
    });

    const row = rows[0];
    // The stored data field must not contain the plaintext values
    expect(row.data).not.toContain("plain-access");
    expect(row.data).not.toContain("plain-refresh");
    // But it must be correctly decryptable
    const decrypted = CryptoJS.AES.decrypt(row.data, "test-secret").toString(CryptoJS.enc.Utf8);
    const parsed = JSON.parse(decrypted);
    expect(parsed.accessToken).toBe("plain-access");
    expect(parsed.refreshToken).toBe("plain-refresh");
  });

  it("upsert overwrites on (provider, userId) collision", async () => {
    await credentialStore.upsert({ provider: "test-p", userId: 4, authType: "oauth", data: { v: 1 } });
    await credentialStore.upsert({ provider: "test-p", userId: 4, authType: "oauth", data: { v: 2 } });
    expect(rows).toHaveLength(1);
    const got = await credentialStore.get("test-p", 4);
    expect(got?.data).toEqual({ v: 2 });
  });

  it("scopes rows to (provider, userId) pair", async () => {
    await credentialStore.upsert({ provider: "test-p", userId: 5, authType: "oauth", data: { v: "user-5" } });
    await credentialStore.upsert({ provider: "test-p", userId: 6, authType: "oauth", data: { v: "user-6" } });
    await credentialStore.upsert({ provider: "other", userId: 5, authType: "oauth", data: { v: "other-provider" } });
    expect(rows).toHaveLength(3);
    expect((await credentialStore.get("test-p", 6))?.data).toEqual({ v: "user-6" });
  });

  it("delete removes the row", async () => {
    await credentialStore.upsert({ provider: "test-p", userId: 7, authType: "oauth", data: { v: 1 } });
    await credentialStore.delete("test-p", 7);
    expect(await credentialStore.get("test-p", 7)).toBeNull();
  });
});
