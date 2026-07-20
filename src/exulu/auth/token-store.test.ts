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

import { oauthTokenStore } from "./token-store";

beforeAll(() => {
  process.env.NEXTAUTH_SECRET = "test-secret";
});

beforeEach(() => {
  rows.length = 0;
});

describe("oauthTokenStore", () => {
  it("returns null when no row exists", async () => {
    expect(await oauthTokenStore.get("jira", 1)).toBeNull();
  });

  it("encrypts tokens at rest and decrypts them on read", async () => {
    await oauthTokenStore.upsert("jira", 1, "jira_search", {
      accessToken: "plain-access",
      refreshToken: "plain-refresh",
      tokenType: "Bearer",
      scopes: "read:a",
      expiresAt: new Date("2030-01-01T00:00:00Z"),
    });

    const row = rows[0];
    expect(row.access_token).not.toContain("plain-access");
    expect(row.refresh_token).not.toContain("plain-refresh");
    expect(
      CryptoJS.AES.decrypt(row.access_token, "test-secret").toString(CryptoJS.enc.Utf8),
    ).toBe("plain-access");
    expect(row.provider).toBe("jira");
    expect(row.tool_id).toBe("jira_search");

    const record = await oauthTokenStore.get("jira", 1);
    expect(record).toEqual({
      accessToken: "plain-access",
      refreshToken: "plain-refresh",
      tokenType: "Bearer",
      scopes: "read:a",
      expiresAt: new Date("2030-01-01T00:00:00Z"),
    });
  });

  it("updates the existing row instead of inserting a duplicate", async () => {
    await oauthTokenStore.upsert("jira", 1, "jira_search", { accessToken: "first" });
    await oauthTokenStore.upsert("jira", 1, "jira_get", { accessToken: "second" });
    expect(rows).toHaveLength(1);
    expect((await oauthTokenStore.get("jira", 1))!.accessToken).toBe("second");
    // tool_id column reflects the latest writer for audit
    expect(rows[0].tool_id).toBe("jira_get");
  });

  it("preserves the stored refresh token when a new response omits it", async () => {
    await oauthTokenStore.upsert("jira", 1, "jira_search", {
      accessToken: "first",
      refreshToken: "keep-me",
    });
    await oauthTokenStore.upsert("jira", 1, "jira_search", { accessToken: "second" });
    const record = await oauthTokenStore.get("jira", 1);
    expect(record!.accessToken).toBe("second");
    expect(record!.refreshToken).toBe("keep-me");
  });

  it("scopes rows to the (provider, userId) pair", async () => {
    await oauthTokenStore.upsert("jira", 1, "jira_search", { accessToken: "user-1" });
    await oauthTokenStore.upsert("jira", 2, "jira_search", { accessToken: "user-2" });
    await oauthTokenStore.upsert("google", 1, "google_calendar", { accessToken: "other-provider" });
    expect(rows).toHaveLength(3);
    expect((await oauthTokenStore.get("jira", 2))!.accessToken).toBe("user-2");
  });

  it("deletes a row", async () => {
    await oauthTokenStore.upsert("jira", 1, "jira_search", { accessToken: "bye" });
    await oauthTokenStore.delete("jira", 1);
    expect(await oauthTokenStore.get("jira", 1)).toBeNull();
  });
});
