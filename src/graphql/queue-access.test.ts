import { assertQueueAccess, createQueueMutationResolvers } from "./queue-access";

const role = (r: Partial<Record<"agents" | "workflows" | "evals" | "variables" | "users", "read" | "write">>) => ({
  id: "r",
  name: "r",
  agents: "read",
  workflows: "read",
  evals: "read",
  variables: "read",
  users: "read",
  ...r,
});
const reader = { id: 3, type: "user", super_admin: false, role: role({}) } as any;
const noRole = { id: 4, type: "user", super_admin: false } as any;
const admin = { id: 1, super_admin: true } as any;
const routineEditor = { id: 5, super_admin: false, role: role({ workflows: "write" }) } as any;
const kbEditor = { id: 6, super_admin: false, role: role({ agents: "write" }) } as any;
const evalEditor = { id: 7, super_admin: false, role: role({ evals: "write" }) } as any;
const internalKey = { id: 192837465, type: "api", role: role({}) } as any;

const deps = { globalQueueNames: ["eval_runs", "email_intake", "import"], contextQueueNames: async () => new Set(["kb_embed"]) };

describe("assertQueueAccess", () => {
  const ok = (user: any, queue: string, level: "read" | "write") =>
    assertQueueAccess({ user, queue, level }, deps).then(() => true, () => false);

  it("super admins pass on every queue", async () => {
    for (const q of ["eval_runs", "import", "kb_embed", "reports"]) expect(await ok(admin, q, "write")).toBe(true);
  });

  it("users without write permission are refused on every write", async () => {
    for (const u of [reader, noRole, internalKey])
      for (const q of ["eval_runs", "import", "kb_embed", "reports"]) expect(await ok(u, q, "write")).toBe(false);
  });

  it("routine editors (workflows:write) act on any non-global queue: a routine may use any of them", async () => {
    expect(await ok(routineEditor, "reports", "write")).toBe(true);
    expect(await ok(routineEditor, "kb_embed", "write")).toBe(true);
    expect(await ok(routineEditor, "eval_runs", "write")).toBe(false);
    expect(await ok(routineEditor, "import", "write")).toBe(false);
  });

  it("knowledge editors (agents:write) act only on context queues", async () => {
    expect(await ok(kbEditor, "kb_embed", "write")).toBe(true);
    expect(await ok(kbEditor, "reports", "write")).toBe(false);
  });

  it("eval editors (evals:write) act only on eval_runs", async () => {
    expect(await ok(evalEditor, "eval_runs", "write")).toBe(true);
    expect(await ok(evalEditor, "reports", "write")).toBe(false);
  });

  it("read level follows the page's read permission; global system queues stay super-admin only", async () => {
    expect(await ok(reader, "reports", "read")).toBe(true);
    expect(await ok(reader, "kb_embed", "read")).toBe(true);
    expect(await ok(reader, "eval_runs", "read")).toBe(true);
    expect(await ok(reader, "import", "read")).toBe(false);
    expect(await ok(noRole, "reports", "read")).toBe(false);
  });

  it("refuses with the GraphQL error form the neighbouring resolvers use", async () => {
    await expect(assertQueueAccess({ user: reader, queue: "reports", level: "write" }, deps)).rejects.toThrow(
      /You don't have permission to manage the queue "reports"/,
    );
  });
});

describe("queue mutation resolvers", () => {
  const makeQueue = () => {
    const queue = {
      drain: jest.fn(async () => {}),
      pause: jest.fn(async () => {}),
      resume: jest.fn(async () => {}),
      remove: jest.fn(async () => {}),
      add: jest.fn(async () => ({})),
      getJob: jest.fn(async () => ({ name: "workflow_run", data: { user: 9 } })),
    };
    const use = jest.fn(async () => ({ queue }));
    return { queue, use };
  };

  const calls: Array<[string, Record<string, unknown>]> = [
    ["drainQueue", { queue: "reports" }],
    ["pauseQueue", { queue: "reports" }],
    ["resumeQueue", { queue: "reports" }],
    ["deleteJob", { queue: "reports", id: "j1" }],
    ["retryJob", { queue: "reports", id: "j1" }],
  ];

  it.each(calls)("%s refuses a user without the permission and touches no queue", async (name, args) => {
    const { queue, use } = makeQueue();
    const resolvers = createQueueMutationResolvers({ ...deps, getQueue: () => ({ use }) as any });
    await expect(resolvers[name](undefined, args, { user: reader })).rejects.toThrow(/permission/);
    expect(use).not.toHaveBeenCalled();
    for (const fn of Object.values(queue)) expect(fn).not.toHaveBeenCalled();
  });

  it.each(calls)("%s passes for a permitted user", async (name, args) => {
    const { use } = makeQueue();
    const resolvers = createQueueMutationResolvers({ ...deps, getQueue: () => ({ use }) as any });
    await expect(resolvers[name](undefined, args, { user: routineEditor })).resolves.toEqual({ success: true });
    expect(use).toHaveBeenCalled();
  });

  it("retryJob re-enqueues the same name + data and removes the original when asked", async () => {
    const { queue, use } = makeQueue();
    const resolvers = createQueueMutationResolvers({ ...deps, getQueue: () => ({ use }) as any });
    await resolvers.retryJob(undefined, { queue: "reports", id: "j1", deleteOriginal: true }, { user: admin });
    expect(queue.add).toHaveBeenCalledWith("workflow_run", { user: 9 });
    expect(queue.remove).toHaveBeenCalledWith("j1");
  });
});

describe("schema wiring", () => {
  const source = require("node:fs").readFileSync(require("node:path").join(__dirname, "schemas/index.ts"), "utf8");
  it("the five mutations come only from the guarded factory", () => {
    expect(source).toMatch(/Object\.assign\(resolvers\.Mutation, createQueueMutationResolvers\(/);
    for (const name of ["drainQueue", "pauseQueue", "resumeQueue", "deleteJob", "retryJob"]) {
      expect(source).not.toContain(`resolvers.Mutation["${name}"]`);
    }
  });
  it.each(["queue", "jobs"])("the %s query checks read access before anything else", (name) => {
    const at = source.indexOf(`resolvers.Query["${name}"] = async`);
    const body = source.slice(at, at + 400);
    expect(body).toMatch(/assertQueueAccess\(\{ user: context\.user, queue: args\.queue, level: "read" \}/);
  });
});
