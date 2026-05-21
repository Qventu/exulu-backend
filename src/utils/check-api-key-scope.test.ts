import { checkApiKeyScope } from "./check-api-key-scope";
import type { User } from "@EXULU_TYPES/models/user";

const baseUser = (overrides: Partial<User>): User => ({
  id: 1,
  email: "u@example.com",
  type: "api",
  role: {
    id: "r",
    name: "admin",
    agents: "read",
    evals: "read",
    workflows: "read",
    variables: "read",
    users: "read",
  },
  ...overrides,
});

describe("checkApiKeyScope", () => {
  test("allows when user is undefined (defer to other checks)", () => {
    expect(checkApiKeyScope(undefined, "a1")).toEqual({ allowed: true });
  });

  test("allows when user is not an API user", () => {
    const user = baseUser({ type: "user" });
    expect(checkApiKeyScope(user, "a1")).toEqual({ allowed: true });
  });

  test("allows when API user has no scope_mode (legacy)", () => {
    const user = baseUser({});
    expect(checkApiKeyScope(user, "a1")).toEqual({ allowed: true });
  });

  test("allows admin scope_mode for any agent", () => {
    const user = baseUser({ scope_mode: "admin" });
    expect(checkApiKeyScope(user, "a1")).toEqual({ allowed: true });
    expect(checkApiKeyScope(user, "a2")).toEqual({ allowed: true });
  });

  test("allows agents scope_mode when agent is in agent_ids", () => {
    const user = baseUser({ scope_mode: "agents", agent_ids: ["a1", "a2"] });
    expect(checkApiKeyScope(user, "a1")).toEqual({ allowed: true });
    expect(checkApiKeyScope(user, "a2")).toEqual({ allowed: true });
  });

  test("denies (403) agents scope_mode when agent NOT in agent_ids", () => {
    const user = baseUser({ scope_mode: "agents", agent_ids: ["a1"] });
    const result = checkApiKeyScope(user, "a2");
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.code).toBe(403);
      expect(result.reason).toContain("not scoped to agent a2");
    }
  });

  test("denies (403) agents scope_mode when agent_ids missing/null/non-array", () => {
    for (const ids of [undefined, null as any, "string" as any, 42 as any]) {
      const user = baseUser({ scope_mode: "agents", agent_ids: ids });
      const result = checkApiKeyScope(user, "a1");
      expect(result.allowed).toBe(false);
      if (!result.allowed) expect(result.code).toBe(403);
    }
  });

  test("denies (401) for unknown scope_mode", () => {
    const user = baseUser({ scope_mode: "weird" as any });
    const result = checkApiKeyScope(user, "a1");
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.code).toBe(401);
  });
});
