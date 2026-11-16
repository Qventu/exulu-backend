import { resolveSessionProject } from "./resolve-session-project";

const postgresClient = jest.fn();
jest.mock("@SRC/postgres/client", () => ({ postgresClient: (...a: unknown[]) => postgresClient(...a) }));
jest.mock("@EE/rbac-resolver.ts", () => ({ RBACResolver: jest.fn() }));
const { RBACResolver } = jest.requireMock("@EE/rbac-resolver.ts") as { RBACResolver: jest.Mock };
jest.mock("@EE/invoke-skills/project-sync", () => ({
  resolveSandboxProjectId: jest.fn(async (_a: unknown, deps: { getProject: (id: string) => Promise<unknown>; getRbac: (p: unknown) => Promise<unknown> }) => {
    const p = (await deps.getProject("p1")) as { id: string } | undefined;
    if (p) await deps.getRbac(p);
    return p ? p.id : null;
  }),
}));

const dbWith = (row: unknown) => ({ db: { from: () => ({ where: () => ({ first: async () => row }) }) } });

beforeEach(() => postgresClient.mockReset());

it("makes no database round trip for a session without a project", async () => {
  expect(await resolveSessionProject({ projectId: undefined, ownerId: 7 })).toBeNull();
  expect(await resolveSessionProject({ projectId: "p1", ownerId: null })).toBeNull();
  expect(postgresClient).not.toHaveBeenCalled();
});

it("returns id and name when the sandbox resolver allows the project", async () => {
  postgresClient.mockResolvedValue(dbWith({ id: "p1", name: "Alpha" }));
  expect(await resolveSessionProject({ projectId: "p1", ownerId: 7 })).toEqual({ id: "p1", name: "Alpha", speakerCanWrite: false });
});

it("returns null when the project is gone or not accessible", async () => {
  postgresClient.mockResolvedValue(dbWith(undefined));
  expect(await resolveSessionProject({ projectId: "p1", ownerId: 7 })).toBeNull();
});

describe("speakerCanWrite", () => {
  const row = { id: "p1", name: "Alpha", created_by: 1, rights_mode: "private" };
  beforeEach(() => {
    postgresClient.mockResolvedValue(dbWith(row));
    RBACResolver.mockResolvedValue({ type: "private", users: [{ id: "2", rights: "read" }, { id: "3", rights: "write" }], roles: [] });
  });
  const run = (speaker: { id: number } | null | undefined) =>
    resolveSessionProject({ projectId: "p1", ownerId: 1, speaker });

  it("is true for the creator and for a write grant, false for a read grant", async () => {
    expect((await run({ id: 1 }))!.speakerCanWrite).toBe(true);
    expect((await run({ id: 3 }))!.speakerCanWrite).toBe(true);
    expect((await run({ id: 2 }))!.speakerCanWrite).toBe(false);
  });
  it("is false without a speaker id, and costs no second query", async () => {
    expect((await run(null))!.speakerCanWrite).toBe(false);
    expect((await run({} as never))!.speakerCanWrite).toBe(false);
    postgresClient.mockClear();
    await run({ id: 3 });
    expect(postgresClient).toHaveBeenCalledTimes(2); // project row + rbac, same as before
  });
});
