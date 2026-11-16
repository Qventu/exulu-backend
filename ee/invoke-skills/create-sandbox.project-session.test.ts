/**
 * Behaviour of a real (direct-exec) session sandbox around `project/`: S3 is
 * mocked, the SRT wrapper passes commands through unchanged, files land in a
 * real /tmp/exulu-sessions/<unique id> directory that is removed afterwards.
 */
jest.mock("@anthropic-ai/sandbox-runtime", () => ({
  SandboxManager: {
    initialize: jest.fn(async () => {}),
    wrapWithSandbox: jest.fn(async (cmd: string) => cmd),
    reset: jest.fn(async () => {}),
  },
}));
jest.mock("@SRC/uppy/index.ts", () => ({
  listS3ObjectsByPrefix: jest.fn(async () => []),
  getS3ObjectBytes: jest.fn(),
  uploadFile: jest.fn(async (_c: Buffer, key: string) => `bucket/user_7/${key}`),
  getPresignedUrl: jest.fn(async () => "https://signed"),
}));
jest.mock("@SRC/postgres/client", () => ({
  postgresClient: jest.fn(async () => ({ db: { from: () => ({ select: async () => [] }) } })),
}));
jest.mock("@SRC/exulu/system-dependencies.ts", () => ({ getNpmGlobalRoot: jest.fn(async () => null) }));
jest.mock("@SRC/utils/python-setup.ts", () => ({ getPythonVenvPath: () => undefined }));

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { listS3ObjectsByPrefix, getS3ObjectBytes, uploadFile } from "@SRC/uppy/index.ts";
import { createSessionSandbox } from "./create-sandbox";

const list = listS3ObjectsByPrefix as jest.Mock;
const bytes = getS3ObjectBytes as jest.Mock;
const upload = uploadFile as jest.Mock;
const config = { fileUploads: { s3Bucket: "bucket" } } as any;

const uploadedKeys = () => upload.mock.calls.map((c) => c[1] as string);

// Project files come from the project prefix; the session prefix is empty.
const remote = (files: Record<string, string>) => {
  list.mockImplementation(async (prefix: string) =>
    prefix.startsWith("projects/")
      ? Object.entries(files).map(([name, body]) => ({ key: `${prefix}${name}`, size: body.length, lastModified: new Date() }))
      : [],
  );
  bytes.mockImplementation(async (key: string) => Buffer.from(files[key.split("/").pop()!] ?? ""));
};

let handles: Array<{ cleanup: () => Promise<void> }> = [];
const open = async (sid: string, projectId: string | null) => {
  const h = await createSessionSandbox(sid, [], config, 7, undefined, { projectId });
  handles.push(h);
  return h;
};
const sid = () => `jest-project-${process.pid}-${Math.random().toString(36).slice(2)}`;

beforeEach(() => {
  upload.mockClear();
  list.mockClear();
  remote({});
  jest.spyOn(console, "warn").mockImplementation(() => {});
  jest.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(async () => {
  for (const h of handles) await h.cleanup();
  handles = [];
  jest.restoreAllMocks();
});

const run = (h: any, command: string) => h.tools.bash.execute({ command }, { toolCallId: "t", messages: [] });
const write = (h: any, path: string, content: string) =>
  h.tools.writeFile.execute({ path, content }, { toolCallId: "t", messages: [] });

describe("session sandbox with a project", () => {
  it("materialises project files under project/ and never writes them back", async () => {
    remote({ "brief.txt": "shared" });
    const id = sid();
    const h = await open(id, "p1");
    expect(await readFile(join(h.sessionDir, "project", "brief.txt"), "utf8")).toBe("shared");

    const w = await write(h, "project/mine.txt", "x");
    expect(w.key).toBeUndefined();
    await run(h, "echo y > project/bash.txt && echo z > out.txt");

    expect(uploadedKeys()).toEqual([`sessions/${id}/out.txt`]);
    expect(upload.mock.calls[0][3]).toEqual({ metadata: { "exulu-origin": "agent" } });
  });

  it("the next turn replaces agent edits and drops files gone from the project", async () => {
    remote({ "a.txt": "aaa", "b.txt": "bb" });
    const id = sid();
    const h = await open(id, "p1");
    await run(h, "echo changed-content > project/a.txt && echo extra > project/extra.txt");

    remote({ "a.txt": "aaa" });
    await open(id, "p1"); // cache hit
    expect(await readFile(join(h.sessionDir, "project", "a.txt"), "utf8")).toBe("aaa");
    expect(existsSync(join(h.sessionDir, "project", "b.txt"))).toBe(false);
    expect(existsSync(join(h.sessionDir, "project", "extra.txt"))).toBe(false);
  });

  it("detaching on a cached sandbox removes project/ and makes the name ordinary again", async () => {
    remote({ "a.txt": "aaa" });
    const id = sid();
    const h = await open(id, "p1");
    expect(existsSync(join(h.sessionDir, "project", "a.txt"))).toBe(true);

    await open(id, null); // same cached sandbox, project gone
    expect(existsSync(join(h.sessionDir, "project"))).toBe(false);

    upload.mockClear();
    await run(h, "mkdir -p project && echo y > project/x.txt");
    expect(uploadedKeys()).toEqual([`sessions/${id}/project/x.txt`]);
  });

  it("attaching a project to a cached sandbox makes project/ read-only from that turn", async () => {
    const id = sid();
    const h = await open(id, null);
    remote({ "a.txt": "aaa" });
    await open(id, "p1");
    expect(await readFile(join(h.sessionDir, "project", "a.txt"), "utf8")).toBe("aaa");
    await run(h, "echo y > project/new.txt");
    expect(existsSync(join(h.sessionDir, "project", "new.txt"))).toBe(true);
    expect(uploadedKeys()).toEqual([]);
  });
});

describe("project flag is fixed for the duration of one bash command", () => {
  it("a detach that lands mid-command does not upload the project copy as agent files", async () => {
    remote({ "brief.txt": "shared" });
    const id = sid();
    const h = await open(id, "p1");
    upload.mockClear();

    // The detach turn's session restore hangs until we let it go: by then it has
    // already flipped the project state, but its sync has not removed project/ yet.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    list.mockImplementation(async (prefix: string) => {
      if (!prefix.startsWith("projects/")) await gate;
      return [];
    });

    const bash = run(h, "sleep 0.4 && echo z > out.txt");
    await new Promise((r) => setTimeout(r, 100)); // before-snapshot taken
    const detach = open(id, null);
    await bash;
    release();
    await detach;

    expect(uploadedKeys()).toEqual([`sessions/${id}/out.txt`]);
  });
});

describe("session sandbox without a project", () => {
  it("project/ is an ordinary folder whose files are uploaded to the session", async () => {
    const id = sid();
    const h = await open(id, null);
    const w = await write(h, "project/x.txt", "x");
    expect(w.key).toBe(`bucket/user_7/sessions/${id}/project/x.txt`);
    await run(h, "echo y > project/y.txt");
    expect(uploadedKeys()).toEqual([`sessions/${id}/project/x.txt`, `sessions/${id}/project/y.txt`]);
    // and the next turn leaves it alone
    await open(id, null);
    expect(await readFile(join(h.sessionDir, "project", "y.txt"), "utf8")).toBe("y\n");
    expect(list.mock.calls.some((c) => String(c[0]).startsWith("projects/"))).toBe(false);
  });
});
