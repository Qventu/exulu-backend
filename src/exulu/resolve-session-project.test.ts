import { resolveSessionProject } from "./resolve-session-project";

const postgresClient = jest.fn();
jest.mock("@SRC/postgres/client", () => ({ postgresClient: (...a: unknown[]) => postgresClient(...a) }));
jest.mock("@EE/rbac-resolver.ts", () => ({ RBACResolver: jest.fn() }));
jest.mock("@EE/invoke-skills/project-sync", () => ({
  resolveSandboxProjectId: jest.fn(async (_a: unknown, deps: { getProject: (id: string) => Promise<unknown> }) => {
    const p = (await deps.getProject("p1")) as { id: string } | undefined;
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
  expect(await resolveSessionProject({ projectId: "p1", ownerId: 7 })).toEqual({ id: "p1", name: "Alpha" });
});

it("returns null when the project is gone or not accessible", async () => {
  postgresClient.mockResolvedValue(dbWith(undefined));
  expect(await resolveSessionProject({ projectId: "p1", ownerId: 7 })).toBeNull();
});
