const mockListByUser = jest.fn();
const mockDelete = jest.fn();
const mockAuthenticate = jest.fn();

jest.mock("./credential-store", () => ({
  credentialStore: {
    listByUser: (...args: any[]) => mockListByUser(...args),
    delete: (...args: any[]) => mockDelete(...args),
  },
}));

jest.mock("../../validators/requests", () => ({
  requestValidators: {
    authenticate: (...args: any[]) => mockAuthenticate(...args),
  },
}));

import { handleCredentialList, handleCredentialDelete } from "./manage-handlers";

const mockReq = (params: any = {}) => ({ params, body: {} }) as any;

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

beforeEach(() => {
  jest.resetAllMocks();
});

describe("handleCredentialList", () => {
  it("401s without a session user", async () => {
    mockAuthenticate.mockResolvedValue({ error: true, message: "no", code: 401 });
    const res = mockRes();
    await handleCredentialList(mockReq(), res);
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ ok: false, error: "authentication required" });
    expect(mockListByUser).not.toHaveBeenCalled();
  });

  it("returns the session user's credential metadata", async () => {
    mockAuthenticate.mockResolvedValue({ error: false, user: { id: 7 } });
    const stored = [
      {
        provider: "moco",
        authType: "user_credentials",
        createdAt: new Date("2026-07-22T10:00:00Z"),
        updatedAt: new Date("2026-07-22T10:00:00Z"),
      },
    ];
    mockListByUser.mockResolvedValue(stored);
    const res = mockRes();
    await handleCredentialList(mockReq(), res);
    expect(mockListByUser).toHaveBeenCalledWith(7);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true, credentials: stored });
  });
});

describe("handleCredentialDelete", () => {
  it("401s without a session user", async () => {
    mockAuthenticate.mockResolvedValue({ error: true, message: "no", code: 401 });
    const res = mockRes();
    await handleCredentialDelete(mockReq({ provider: "moco" }), res);
    expect(res.statusCode).toBe(401);
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it("400s without a provider param", async () => {
    mockAuthenticate.mockResolvedValue({ error: false, user: { id: 7 } });
    const res = mockRes();
    await handleCredentialDelete(mockReq({}), res);
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ ok: false, error: "provider is required" });
  });

  it("deletes for (provider, session user) and is idempotent-shaped", async () => {
    mockAuthenticate.mockResolvedValue({ error: false, user: { id: 7 } });
    mockDelete.mockResolvedValue(undefined);
    const res = mockRes();
    await handleCredentialDelete(mockReq({ provider: "moco" }), res);
    expect(mockDelete).toHaveBeenCalledWith("moco", 7);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });
});
