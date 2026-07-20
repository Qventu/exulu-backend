/**
 * End-to-end integration test for the user_credentials authentication flow
 * through the real ExuluTool class.
 *
 * Strategy: mock only the external I/O boundaries (credentialStore and
 * postgresClient), then construct a real ExuluTool with
 * authentication.authType = 'user_credentials' and drive it via
 * .tool.execute() — the AI SDK wrapped function that wrap-execute sits inside.
 */

// ---- mock the DB / store boundary (must come before any imports) -----------

const mockCredentialStoreGet = jest.fn();
const mockCredentialStoreUpsert = jest.fn();
const mockCredentialStoreDelete = jest.fn();

jest.mock("./credential-store", () => ({
  credentialStore: {
    get: (...args: any[]) => mockCredentialStoreGet(...args),
    upsert: (...args: any[]) => mockCredentialStoreUpsert(...args),
    delete: (...args: any[]) => mockCredentialStoreDelete(...args),
  },
  // encrypt/decrypt are used by credentials-request to build the nonce
  encrypt: (v: string) => `enc:${v}`,
  decrypt: (v: string) => v.replace(/^enc:/, ""),
}));

// postgresClient is imported transitively by credential-store; stub it so the
// real module does not attempt to open a DB connection during test setup.
jest.mock("@SRC/postgres/client", () => ({
  postgresClient: jest.fn(),
}));

// ---- real imports (after jest.mock hoisting) --------------------------------

import { z } from "zod";
import { ExuluTool } from "../tool";
import { authRegistry, __resetAuthRegistryForTests } from "./registry";

// ---------------------------------------------------------------------------

beforeAll(() => {
  // Required by wrap-execute AND validate.ts (both read process.env.BACKEND)
  process.env.BACKEND = "http://test-x";
  // Required by credential-store's encrypt/decrypt helpers
  process.env.NEXTAUTH_SECRET = "test-secret";
});

beforeEach(() => {
  jest.resetAllMocks();
  __resetAuthRegistryForTests();
});

// ---------------------------------------------------------------------------
// Case 1: construction
// ---------------------------------------------------------------------------

describe("ExuluTool with user_credentials authentication — construction", () => {
  it("constructs without throwing and registers the config in authRegistry", () => {
    const exulu = new ExuluTool({
      id: "e2e_creds_tool",
      name: "E2E Creds Tool",
      description: "A tool that requires user-supplied credentials.",
      type: "function",
      config: [],
      inputSchema: z.object({ query: z.string() }),
      authentication: {
        authType: "user_credentials",
        provider: "e2e-provider",
        fields: [{ name: "apiKey", label: "API Key", type: "password" }],
      },
      execute: async (inputs: any) => ({ result: JSON.stringify({ echoed: inputs.credentials?.apiKey }) }),
    });

    // The instance exposes a callable .tool.execute (the AI SDK wrapped fn)
    expect(typeof exulu.tool.execute).toBe("function");

    // The auth config is reachable via the registry
    const registered = authRegistry.getByTool("e2e_creds_tool");
    expect(registered).toBeDefined();
    expect(registered?.authType).toBe("user_credentials");
    if (registered?.authType === "user_credentials") {
      expect(registered.provider).toBe("e2e-provider");
      expect(registered.fields[0].name).toBe("apiKey");
    }
  });
});

// ---------------------------------------------------------------------------
// Case 2: end-to-end short-circuit then inject flow
// ---------------------------------------------------------------------------

describe("ExuluTool with user_credentials — end-to-end execute flow", () => {
  const USER_ID = 7;
  const PROVIDER = "e2e-provider-2";

  let exulu: ExuluTool;

  beforeEach(() => {
    exulu = new ExuluTool({
      id: "e2e_creds_tool_2",
      name: "E2E Creds Tool 2",
      description: "A tool that echoes the injected credential.",
      type: "function",
      config: [],
      inputSchema: z.object({ query: z.string().optional() }),
      authentication: {
        authType: "user_credentials",
        provider: PROVIDER,
        fields: [{ name: "apiKey", label: "API Key", type: "password" }],
      },
      execute: async (inputs: any) => ({ echoed: inputs.credentials?.apiKey }),
    });
  });

  it("first call (no stored credentials) short-circuits with a credentialRequest", async () => {
    // Simulate: no credentials stored for this user
    mockCredentialStoreGet.mockResolvedValue(null);

    const result = await exulu.tool.execute!({ user: { id: USER_ID } }, { toolCallId: "call-1" });

    expect(result).toHaveProperty("credentialRequest");
    expect(result.credentialRequest.provider).toBe(PROVIDER);
    expect(result.credentialRequest.fields).toEqual([{ name: "apiKey", label: "API Key", type: "password" }]);
    // The AI SDK short-circuit carries result: null
    expect(result.result).toBeNull();
  });

  it("second call (credentials now present) runs inner execute and returns injected value", async () => {
    // Simulate: upsert was called by the frontend; the store now has the credential
    mockCredentialStoreGet.mockResolvedValue({
      provider: PROVIDER,
      userId: USER_ID,
      authType: "user_credentials",
      data: { apiKey: "good" },
    });

    const result = await exulu.tool.execute!({ user: { id: USER_ID } }, { toolCallId: "call-2" });

    // Inner execute should have received credentials injected and returned echoed value
    expect(result).toEqual({ echoed: "good" });
  });
});
