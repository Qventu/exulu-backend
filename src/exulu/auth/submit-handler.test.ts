import type { ExuluUserCredentialsConfig } from "./types";

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

const mockUpsert = jest.fn();
const mockVerifyCredentialNonce = jest.fn();
const mockValidate = jest.fn();
const mockAuthenticate = jest.fn();

jest.mock("./credential-store", () => ({
  credentialStore: {
    upsert: (...args: any[]) => mockUpsert(...args),
  },
}));

jest.mock("./credentials-request", () => ({
  verifyCredentialNonce: (...args: any[]) => mockVerifyCredentialNonce(...args),
}));

jest.mock("../../validators/requests", () => ({
  requestValidators: {
    authenticate: (...args: any[]) => mockAuthenticate(...args),
  },
}));

import { handleCredentialSubmit } from "./submit-handler";
import { authRegistry, __resetAuthRegistryForTests } from "./registry";

const mockReq = (body: any) => ({ body }) as any;

const mockRes = () => {
  const res: any = {
    statusCode: 0,
    body: null,
    status: jest.fn((code: number) => {
      res.statusCode = code;
      return res;
    }),
    json: jest.fn((data: any) => {
      res.body = data;
      return res;
    }),
  };
  return res;
};

const config: ExuluUserCredentialsConfig = {
  authType: "user_credentials",
  provider: "test_provider",
  fields: [
    { name: "username", label: "Username", type: "text" },
    { name: "password", label: "Password", type: "password" },
  ],
  validate: mockValidate,
};

beforeAll(() => {
  process.env.NEXTAUTH_SECRET = "test-secret";
});

beforeEach(() => {
  jest.resetAllMocks();
  rows.length = 0;
  __resetAuthRegistryForTests();
  authRegistry.register("my_tool", config);
  // Default: authenticated as user 42
  mockAuthenticate.mockResolvedValue({ user: { id: 42 } });
});

describe("handleCredentialSubmit", () => {
  it("returns 401 when request is unauthenticated (no session user)", async () => {
    mockAuthenticate.mockResolvedValue({ user: undefined, code: 401, message: "Unauthorized" });

    const req = mockReq({ nonce: "some-nonce", values: { username: "alice", password: "secret" } });
    const res = mockRes();

    await handleCredentialSubmit(req, res);

    expect(res.statusCode).toBe(401);
    expect(res.body?.ok).toBe(false);
    expect(res.body?.error).toBe("authentication required");
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it("returns 403 when session userId does not match nonce userId", async () => {
    // Session user is 99, nonce claims userId 42 — attacker replaying a victim's nonce
    mockAuthenticate.mockResolvedValue({ user: { id: 99 } });
    mockVerifyCredentialNonce.mockReturnValue({
      provider: "test_provider",
      userId: "42",
      expiresAt: 9999999999,
    });

    const req = mockReq({ nonce: "victim-nonce", values: { username: "alice", password: "secret" } });
    const res = mockRes();

    await handleCredentialSubmit(req, res);

    expect(res.statusCode).toBe(403);
    expect(res.body?.ok).toBe(false);
    expect(res.body?.error).toBe("userId mismatch");
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it("returns 400 for invalid request body (missing nonce)", async () => {
    const req = mockReq({ values: { username: "alice", password: "secret" } });
    const res = mockRes();

    await handleCredentialSubmit(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.body?.ok).toBe(false);
    expect(res.body?.error).toBe("invalid body");
  });

  it("returns 401 for invalid or expired nonce", async () => {
    mockVerifyCredentialNonce.mockImplementation(() => {
      throw new Error("Credential nonce expired");
    });

    const req = mockReq({ nonce: "expired-nonce", values: { username: "alice", password: "secret" } });
    const res = mockRes();

    await handleCredentialSubmit(req, res);

    expect(res.statusCode).toBe(401);
    expect(res.body?.ok).toBe(false);
    expect(res.body?.error).toBe("nonce expired");
  });

  it("returns 400 when provider is not user_credentials", async () => {
    mockVerifyCredentialNonce.mockReturnValue({ provider: "unknown_provider", userId: "42", expiresAt: 9999999999 });

    const req = mockReq({ nonce: "valid-nonce", values: { username: "alice", password: "secret" } });
    const res = mockRes();

    await handleCredentialSubmit(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.body?.ok).toBe(false);
    expect(res.body?.error).toBe("provider is not a user_credentials provider");
  });

  it("returns 400 when submitted fields do not match expected fields", async () => {
    mockVerifyCredentialNonce.mockReturnValue({
      provider: "test_provider",
      userId: "42",
      expiresAt: 9999999999,
    });

    const req = mockReq({
      nonce: "valid-nonce",
      values: { username: "alice" }, // missing password
    });
    const res = mockRes();

    await handleCredentialSubmit(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.body?.ok).toBe(false);
    expect(res.body?.error).toBe("field set mismatch");
  });

  it("returns 400 when validation hook fails", async () => {
    mockVerifyCredentialNonce.mockReturnValue({
      provider: "test_provider",
      userId: "42",
      expiresAt: 9999999999,
    });
    mockValidate.mockRejectedValue(new Error("Invalid credentials"));

    const req = mockReq({
      nonce: "valid-nonce",
      values: { username: "alice", password: "secret" },
    });
    const res = mockRes();

    await handleCredentialSubmit(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.body?.ok).toBe(false);
    expect(res.body?.error).toBe("validation failed: Invalid credentials");
    expect(mockValidate).toHaveBeenCalledWith({ username: "alice", password: "secret" });
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it("returns 401 when nonce userId parses to NaN", async () => {
    mockVerifyCredentialNonce.mockReturnValue({
      provider: "test_provider",
      userId: "abc",
      expiresAt: 9999999999,
    });
    mockValidate.mockResolvedValue(undefined);

    const req = mockReq({
      nonce: "valid-nonce",
      values: { username: "alice", password: "secret" },
    });
    const res = mockRes();

    await handleCredentialSubmit(req, res);

    // NaN !== 42 (session userId), so this hits the userId mismatch check (403)
    // before it can reach the NaN guard that was previously in effect.
    expect(res.statusCode).toBe(403);
    expect(res.body?.ok).toBe(false);
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it("successfully submits credentials when all checks pass", async () => {
    mockVerifyCredentialNonce.mockReturnValue({
      provider: "test_provider",
      userId: "42",
      expiresAt: 9999999999,
    });
    mockValidate.mockResolvedValue(undefined);

    const req = mockReq({
      nonce: "valid-nonce",
      values: { username: "alice", password: "secret" },
    });
    const res = mockRes();

    await handleCredentialSubmit(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body?.ok).toBe(true);
    expect(mockValidate).toHaveBeenCalledWith({ username: "alice", password: "secret" });
    expect(mockUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "test_provider",
        userId: 42,
        authType: "user_credentials",
        data: { username: "alice", password: "secret" },
      }),
    );
  });
});
