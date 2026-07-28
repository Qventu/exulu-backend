const rows: any[] = [];
const mockDb = {
  from: () => ({
    where: (criteria: any) => ({
      first: async () => rows.find((r) => r.provider === criteria.provider && r.user_id === criteria.user_id),
    }),
  }),
};
jest.mock("@SRC/postgres/client", () => ({ postgresClient: jest.fn(async () => ({ db: mockDb })) }));

import CryptoJS from "crypto-js";
import { describeCredentialIdentity } from "./describe";

const seedOauth = (provider: string, userId: number, blob: object) => {
  process.env.NEXTAUTH_SECRET = "test-secret";
  rows.push({
    provider,
    user_id: String(userId),
    auth_type: "oauth",
    data: CryptoJS.AES.encrypt(JSON.stringify(blob), "test-secret").toString(),
  });
};

beforeEach(() => { rows.length = 0; });

describe("describeCredentialIdentity", () => {
  it("returns non-secret oauth identity (never the token)", async () => {
    seedOauth("google", 42, {
      accessToken: "SECRET", refreshToken: "SECRET2", tokenType: "Bearer",
      scopes: "a b c", expiresAt: "2030-01-01T00:00:00.000Z",
    });
    const out = await describeCredentialIdentity(
      { authType: "oauth", provider: "google", authorizationUrl: "", tokenUrl: "", clientId: "", clientSecret: "", scopes: [] },
      42,
    );
    expect(out).toEqual({
      provider: "google", authType: "oauth", account: "42",
      scopes: ["a", "b", "c"], expiresAt: "2030-01-01T00:00:00.000Z",
    });
    expect(JSON.stringify(out)).not.toContain("SECRET");
  });

  it("returns identity from config when no token is stored yet", async () => {
    const out = await describeCredentialIdentity(
      { authType: "user_credentials", provider: "moco", fields: [] },
      7,
    );
    expect(out).toEqual({ provider: "moco", authType: "user_credentials", account: "7" });
  });
});
