import { checkRecordAccess } from "./check-record-access";
import type { User } from "@EXULU_TYPES/models/user";

const baseRole = {
  id: "r",
  name: "admin",
  agents: "read" as const,
  evals: "read" as const,
  workflows: "read" as const,
  variables: "read" as const,
  users: "read" as const,
};

let userIdCounter = 1000;
const adminApiUser = (overrides: Partial<User> = {}): User => ({
  id: userIdCounter++,
  email: "api@x",
  type: "api",
  super_admin: false,
  role: baseRole,
  ...overrides,
});

const agentsScopedApiUser = (agent_ids: string[]): User =>
  adminApiUser({ scope_mode: "agents", agent_ids });

let recordIdCounter = 0;
const newRecordId = () => `ag-test-${recordIdCounter++}`;

describe("checkRecordAccess (API key scoping changes)", () => {
  test("admin-mode API user bypasses (legacy behavior)", async () => {
    const user = adminApiUser({ scope_mode: "admin" });
    const id = newRecordId();
    const record = { id, rights_mode: "private", created_by: "999" };
    await expect(checkRecordAccess(record as any, "read", user)).resolves.toBe(true);
  });

  test("API user with no scope_mode still bypasses (treated as admin)", async () => {
    const user = adminApiUser({});
    const record = { id: newRecordId(), rights_mode: "private", created_by: "999" };
    await expect(checkRecordAccess(record as any, "read", user)).resolves.toBe(true);
  });

  test("agents-scoped API user with id in agent_ids: read returns true", async () => {
    const id = newRecordId();
    const user = agentsScopedApiUser([id, "ag-other"]);
    const record = { id, rights_mode: "private", created_by: "999" };
    await expect(checkRecordAccess(record as any, "read", user)).resolves.toBe(true);
  });

  test("agents-scoped API user with id NOT in agent_ids returns false", async () => {
    const user = agentsScopedApiUser(["ag-other-only"]);
    const record = { id: newRecordId(), rights_mode: "private", created_by: "999" };
    await expect(checkRecordAccess(record as any, "read", user)).resolves.toBe(false);
  });

  test("agents-scoped API user is read-only even for whitelisted agent", async () => {
    const id = newRecordId();
    const user = agentsScopedApiUser([id]);
    const record = { id, rights_mode: "private", created_by: "999" };
    await expect(checkRecordAccess(record as any, "write", user)).resolves.toBe(false);
  });

  test("agents-scoped user with missing agent_ids returns false", async () => {
    for (const ids of [undefined, null as any, "x" as any]) {
      const user = adminApiUser({ scope_mode: "agents", agent_ids: ids });
      const record = { id: newRecordId(), rights_mode: "private", created_by: "999" };
      await expect(checkRecordAccess(record as any, "read", user)).resolves.toBe(false);
    }
  });
});
