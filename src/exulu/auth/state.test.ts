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
      orderBy: async (_col: string) => rows.filter((row) => matches(row, criteria)),
    }),
    insert: (values: Row) => ({
      onConflict: (_cols: string[]) => ({
        merge: async (mergeValues: Row) => {
          const existing = rows.find(
            (r) => r.provider === values.provider && r.user_id === values.user_id,
          );
          if (existing) Object.assign(existing, mergeValues);
          else rows.push({ ...values });
        },
      }),
    }),
  }),
};

jest.mock("@SRC/postgres/client", () => ({
  postgresClient: jest.fn(async () => ({ db: mockDb })),
}));

import { getValidUserCredentials } from "./state";
import { credentialStore } from "./credential-store";

beforeAll(() => {
  process.env.NEXTAUTH_SECRET = "test-secret";
});

beforeEach(async () => {
  rows.length = 0;
  await credentialStore.delete("test-p", 1);
});

describe("getValidUserCredentials", () => {
  it("returns null when no row exists", async () => {
    const got = await getValidUserCredentials(
      { authType: "user_credentials", provider: "test-p", fields: [] },
      1,
    );
    expect(got).toBeNull();
  });

  it("returns the stored data on hit", async () => {
    await credentialStore.upsert({
      provider: "test-p",
      userId: 1,
      authType: "user_credentials",
      data: { k: "v" },
    });
    const got = await getValidUserCredentials(
      {
        authType: "user_credentials",
        provider: "test-p",
        fields: [{ name: "k", label: "K", type: "password" }],
      },
      1,
    );
    expect(got).toEqual({ k: "v" });
  });

  it("returns null if the stored row is oauth-typed (defensive)", async () => {
    await credentialStore.upsert({
      provider: "test-p",
      userId: 1,
      authType: "oauth",
      data: { accessToken: "x" },
    });
    const got = await getValidUserCredentials(
      { authType: "user_credentials", provider: "test-p", fields: [] },
      1,
    );
    expect(got).toBeNull();
  });
});
