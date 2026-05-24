import type { User } from "@EXULU_TYPES/models/user";

type ModelRowFixture = {
  id: string;
  name: string;
  provider: string;
  authvariable?: string;
  active: boolean;
  rights_mode: string;
  created_by: string;
};

type VariableFixture = {
  name: string;
  value: string;
  encrypted: boolean;
};

const fixtures = {
  models: new Map<string, ModelRowFixture>(),
  variables: new Map<string, VariableFixture>(),
};

const mockDb = {
  from: (table: string) => ({
    where: (criteria: any) => ({
      first: async () => {
        if (table === "models") {
          return fixtures.models.get(criteria.id);
        }
        if (table === "variables") {
          return fixtures.variables.get(criteria.name);
        }
        return undefined;
      },
    }),
  }),
};

jest.mock("@SRC/postgres/client", () => ({
  postgresClient: jest.fn(async () => ({ db: mockDb })),
}));

const mockCheckRecordAccess = jest.fn();
jest.mock("@SRC/utils/check-record-access", () => ({
  checkRecordAccess: (...args: any[]) => mockCheckRecordAccess(...args),
}));

jest.mock("crypto-js", () => ({
  __esModule: true,
  default: {
    AES: {
      decrypt: (value: string, _secret: string) => ({
        toString: () => value.replace(/^enc:/, ""),
      }),
    },
    enc: { Utf8: "utf8" },
  },
}));

const mockWaitForReady = jest.fn();
jest.mock("./litellm/supervisor", () => ({
  isLiteLLMEnabled: () => process.env.EXULU_USE_LITELLM === "true",
  waitForLiteLLMReady: (...args: any[]) => mockWaitForReady(...args),
}));

const mockLiteLLMModelFactory = jest.fn(
  (modelName: string) => ({ tag: "litellm-lm", modelName }),
);
jest.mock("@ai-sdk/openai-compatible", () => ({
  createOpenAICompatible: jest.fn(() => mockLiteLLMModelFactory),
}));

import {
  resolveModel,
  ResolveModelError,
  LITELLM_PROVIDER_SENTINEL,
  __resetLiteLLMProviderForTesting,
} from "./resolve-model";
import type { ExuluProvider } from "./provider";

const fakeProvider = (id: string, hasCreate = true): ExuluProvider =>
  ({
    id,
    config: hasCreate
      ? {
          model: {
            create: jest.fn(({ apiKey }: any) => ({ tag: "lm", apiKey })) as any,
          },
        }
      : ({} as any),
  }) as unknown as ExuluProvider;

const fakeUser = (overrides: Partial<User> = {}): User =>
  ({
    id: 1,
    email: "u@x",
    type: "user",
    super_admin: false,
    ...overrides,
  }) as User;

beforeEach(() => {
  fixtures.models.clear();
  fixtures.variables.clear();
  mockCheckRecordAccess.mockReset();
  mockCheckRecordAccess.mockResolvedValue(true);
  mockWaitForReady.mockReset();
  mockWaitForReady.mockResolvedValue(undefined);
  mockLiteLLMModelFactory.mockClear();
  __resetLiteLLMProviderForTesting();
  delete process.env.EXULU_USE_LITELLM;
  process.env.NEXTAUTH_SECRET = "test-secret";
});

describe("resolveModel", () => {
  test("happy path: returns languageModel, model, exuluProvider, apiKey", async () => {
    fixtures.models.set("m1", {
      id: "m1",
      name: "Vertex Flash",
      provider: "p1",
      authvariable: "var1",
      active: true,
      rights_mode: "public",
      created_by: "1",
    });
    fixtures.variables.set("var1", { name: "var1", value: "enc:secret123", encrypted: true });

    const provider = fakeProvider("p1");
    const result = await resolveModel({
      modelId: "m1",
      user: fakeUser(),
      providers: [provider],
    });

    expect(result.model.id).toBe("m1");
    expect(result.exuluProvider).toBe(provider);
    expect(result.apiKey).toBe("secret123");
    expect(result.languageModel).toEqual({ tag: "lm", apiKey: "secret123" });
  });

  test("MODEL_NOT_FOUND: model id does not exist", async () => {
    await expect(
      resolveModel({ modelId: "nope", user: fakeUser(), providers: [] }),
    ).rejects.toMatchObject({
      code: "MODEL_NOT_FOUND",
    });
  });

  test("MODEL_INACTIVE: model exists but active=false", async () => {
    fixtures.models.set("m2", {
      id: "m2",
      name: "Dead",
      provider: "p1",
      authvariable: "var1",
      active: false,
      rights_mode: "public",
      created_by: "1",
    });
    await expect(
      resolveModel({ modelId: "m2", user: fakeUser(), providers: [fakeProvider("p1")] }),
    ).rejects.toMatchObject({ code: "MODEL_INACTIVE" });
  });

  test("MODEL_FORBIDDEN: RBAC check denies access", async () => {
    fixtures.models.set("m3", {
      id: "m3",
      name: "Locked",
      provider: "p1",
      authvariable: "var1",
      active: true,
      rights_mode: "private",
      created_by: "999",
    });
    mockCheckRecordAccess.mockResolvedValueOnce(false);

    await expect(
      resolveModel({ modelId: "m3", user: fakeUser(), providers: [fakeProvider("p1")] }),
    ).rejects.toMatchObject({ code: "MODEL_FORBIDDEN" });
  });

  test("rbacBypass=true skips RBAC check", async () => {
    fixtures.models.set("m4", {
      id: "m4",
      name: "Locked",
      provider: "p1",
      authvariable: "var1",
      active: true,
      rights_mode: "private",
      created_by: "999",
    });
    fixtures.variables.set("var1", { name: "var1", value: "enc:k", encrypted: true });
    // checkRecordAccess would return false, but we bypass — no call expected
    mockCheckRecordAccess.mockResolvedValue(false);

    const result = await resolveModel({
      modelId: "m4",
      providers: [fakeProvider("p1")],
      rbacBypass: true,
    });
    expect(result.model.id).toBe("m4");
    expect(mockCheckRecordAccess).not.toHaveBeenCalled();
  });

  test("PROVIDER_NOT_FOUND: model.provider id not in providers array", async () => {
    fixtures.models.set("m5", {
      id: "m5",
      name: "Orphan",
      provider: "missing-provider",
      authvariable: "var1",
      active: true,
      rights_mode: "public",
      created_by: "1",
    });

    await expect(
      resolveModel({ modelId: "m5", user: fakeUser(), providers: [fakeProvider("other")] }),
    ).rejects.toMatchObject({ code: "PROVIDER_NOT_FOUND" });
  });

  test("PROVIDER_NO_MODEL: provider has no config.model.create", async () => {
    fixtures.models.set("m6", {
      id: "m6",
      name: "Vertex",
      provider: "p1",
      authvariable: "var1",
      active: true,
      rights_mode: "public",
      created_by: "1",
    });
    fixtures.variables.set("var1", { name: "var1", value: "enc:k", encrypted: true });

    await expect(
      resolveModel({
        modelId: "m6",
        user: fakeUser(),
        providers: [fakeProvider("p1", false)],
      }),
    ).rejects.toMatchObject({ code: "PROVIDER_NO_MODEL" });
  });

  test("AUTH_VAR_NOT_FOUND: model.authvariable refers to missing variable", async () => {
    fixtures.models.set("m7", {
      id: "m7",
      name: "Vertex",
      provider: "p1",
      authvariable: "missing-var",
      active: true,
      rights_mode: "public",
      created_by: "1",
    });

    await expect(
      resolveModel({ modelId: "m7", user: fakeUser(), providers: [fakeProvider("p1")] }),
    ).rejects.toMatchObject({ code: "AUTH_VAR_NOT_FOUND" });
  });

  test("AUTH_VAR_NOT_ENCRYPTED: variable found but encrypted=false", async () => {
    fixtures.models.set("m8", {
      id: "m8",
      name: "Vertex",
      provider: "p1",
      authvariable: "plain-var",
      active: true,
      rights_mode: "public",
      created_by: "1",
    });
    fixtures.variables.set("plain-var", {
      name: "plain-var",
      value: "secret",
      encrypted: false,
    });

    await expect(
      resolveModel({ modelId: "m8", user: fakeUser(), providers: [fakeProvider("p1")] }),
    ).rejects.toMatchObject({ code: "AUTH_VAR_NOT_ENCRYPTED" });
  });

  test("model with no authvariable: apiKey is undefined, languageModel still built", async () => {
    fixtures.models.set("m9", {
      id: "m9",
      name: "No auth needed",
      provider: "p1",
      active: true,
      rights_mode: "public",
      created_by: "1",
    });

    const provider = fakeProvider("p1");
    const result = await resolveModel({
      modelId: "m9",
      user: fakeUser(),
      providers: [provider],
    });
    expect(result.apiKey).toBeUndefined();
    expect(result.languageModel).toEqual({ tag: "lm", apiKey: undefined });
  });

  test("ResolveModelError instances carry the code on the .code property", async () => {
    fixtures.models.set("m10", {
      id: "m10",
      name: "Inactive",
      provider: "p1",
      authvariable: "var1",
      active: false,
      rights_mode: "public",
      created_by: "1",
    });
    try {
      await resolveModel({
        modelId: "m10",
        user: fakeUser(),
        providers: [fakeProvider("p1")],
      });
      fail("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ResolveModelError);
      expect((err as ResolveModelError).code).toBe("MODEL_INACTIVE");
    }
  });

  test("write request: passes 'write' to checkRecordAccess", async () => {
    fixtures.models.set("m11", {
      id: "m11",
      name: "Test",
      provider: "p1",
      authvariable: "var1",
      active: true,
      rights_mode: "public",
      created_by: "1",
    });
    fixtures.variables.set("var1", { name: "var1", value: "enc:k", encrypted: true });

    await resolveModel({
      modelId: "m11",
      user: fakeUser(),
      providers: [fakeProvider("p1")],
      rbacRequest: "write",
    });
    expect(mockCheckRecordAccess).toHaveBeenCalledWith(
      expect.objectContaining({ id: "m11" }),
      "write",
      expect.any(Object),
    );
  });
});

describe("resolveModel in LiteLLM mode", () => {
  beforeEach(() => {
    process.env.EXULU_USE_LITELLM = "true";
    process.env.LITELLM_MASTER_KEY = "sk-test";
  });

  test("happy path: returns language model built from openai-compatible factory", async () => {
    const result = await resolveModel({
      modelId: "vertex-flash",
      user: fakeUser(),
      providers: [],
    });

    expect(mockWaitForReady).toHaveBeenCalledTimes(1);
    expect(mockLiteLLMModelFactory).toHaveBeenCalledWith("vertex-flash");
    expect(result.languageModel).toEqual({
      tag: "litellm-lm",
      modelName: "vertex-flash",
    });
    expect(result.model.id).toBe("vertex-flash");
    expect(result.model.name).toBe("vertex-flash");
    expect(result.exuluProvider).toBe(LITELLM_PROVIDER_SENTINEL);
    expect(result.apiKey).toBeUndefined();
  });

  test("does NOT call checkRecordAccess (RBAC bypass at resolver level)", async () => {
    await resolveModel({
      modelId: "vertex-flash",
      user: fakeUser(),
      providers: [],
    });
    expect(mockCheckRecordAccess).not.toHaveBeenCalled();
  });

  test("does NOT query the models DB table", async () => {
    // Fail the test if the DB is touched.
    fixtures.models.set("vertex-flash", {
      id: "vertex-flash",
      name: "Should not be read",
      provider: "p1",
      active: false, // would normally trigger MODEL_INACTIVE
      rights_mode: "public",
      created_by: "1",
    } as any);

    const result = await resolveModel({
      modelId: "vertex-flash",
      providers: [],
    });
    // If the catalog branch had run, MODEL_INACTIVE would have thrown.
    expect(result.languageModel).toBeDefined();
  });

  test("LITELLM_NOT_CONFIGURED: master key missing", async () => {
    delete process.env.LITELLM_MASTER_KEY;
    await expect(
      resolveModel({ modelId: "vertex-flash", providers: [] }),
    ).rejects.toMatchObject({ code: "LITELLM_NOT_CONFIGURED" });
  });

  test("LITELLM_NOT_READY: waitForLiteLLMReady rejects", async () => {
    mockWaitForReady.mockRejectedValueOnce(new Error("/health timeout"));
    await expect(
      resolveModel({ modelId: "vertex-flash", providers: [] }),
    ).rejects.toMatchObject({ code: "LITELLM_NOT_READY" });
  });

  test("LITELLM_PROVIDER_SENTINEL.id returns 'litellm', other props throw", () => {
    expect(LITELLM_PROVIDER_SENTINEL.id).toBe("litellm");
    expect(() => (LITELLM_PROVIDER_SENTINEL as any).capabilities).toThrow(
      /not available in LiteLLM mode/,
    );
    expect(() => (LITELLM_PROVIDER_SENTINEL as any).workflows).toThrow(
      /not available in LiteLLM mode/,
    );
  });
});
