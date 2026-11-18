/**
 * Skill actions are pinned from the bytes downloaded from skill storage, never re-read from
 * the session copy the agent can write. Real (direct-exec) sandbox, S3 mocked, no persistence.
 */
jest.mock("@anthropic-ai/sandbox-runtime", () => ({
  SandboxManager: {
    initialize: jest.fn(async () => {}),
    wrapWithSandbox: jest.fn(async (cmd: string) => cmd),
    reset: jest.fn(async () => {}),
  },
}));
jest.mock("@SRC/uppy/index.ts", () => ({
  listS3ObjectsByPrefix: jest.fn(),
  getS3ObjectBytes: jest.fn(),
  uploadFile: jest.fn(async (_c: Buffer, key: string) => `bucket/${key}`),
  getPresignedUrl: jest.fn(async () => "https://signed"),
}));
jest.mock("@SRC/postgres/client", () => ({
  postgresClient: jest.fn(async () => ({ db: { from: () => ({ select: async () => [] }) } })),
}));
jest.mock("@SRC/exulu/system-dependencies.ts", () => ({ getNpmGlobalRoot: jest.fn(async () => null) }));
jest.mock("@SRC/utils/python-setup.ts", () => ({ getPythonVenvPath: () => undefined }));

import { promises as fs } from "node:fs";
import { join } from "node:path";
import { getS3ObjectBytes, listS3ObjectsByPrefix } from "@SRC/uppy/index.ts";
import { createSessionSandbox, refreshSessionSkills, type SessionSandboxHandle, type SkillRef } from "./create-sandbox";
import { loadSkillActions } from "./skill-actions/load";

const config = { fileUploads: { s3Bucket: "bucket" } } as any;

const actionsYaml = (name: string, context = "deals") => `version: 1
actions:
  ${name}:
    description: Does ${name}.
    run: python3 "$EXULU_SKILL_DIR/run.py"
    inputs:
      deal:
        type: item
        context: ${context}
`;

/** S3 key -> bytes. Skill files live under skills/<id>/v<version>/. */
let store: Map<string, Buffer>;
const put = (skill: SkillRef, version: number, files: Record<string, string>) => {
  for (const [rel, text] of Object.entries(files)) store.set(`skills/${skill.id}/v${version}/${rel}`, Buffer.from(text));
};

let sessionId: string;
let handle: SessionSandboxHandle | undefined;
const turn = async (skills: SkillRef[]) => {
  handle = await createSessionSandbox(sessionId, skills, config, undefined, undefined, { projectId: null });
  return handle;
};
const actionsOf = (h: SessionSandboxHandle, skills: SkillRef[]) => loadSkillActions(h.sessionDir, skills, h.skillActions);

beforeEach(() => {
  store = new Map();
  (listS3ObjectsByPrefix as jest.Mock).mockImplementation(async (prefix: string) =>
    [...store.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })),
  );
  (getS3ObjectBytes as jest.Mock).mockImplementation(async (key: string) => {
    const bytes = store.get(key);
    if (!bytes) throw new Error(`no object ${key}`);
    return bytes;
  });
  jest.spyOn(console, "warn").mockImplementation(() => {});
  jest.spyOn(console, "log").mockImplementation(() => {});
  sessionId = `jest-skillactions-${process.pid}-${Math.random().toString(36).slice(2)}`;
  handle = undefined;
});
afterEach(async () => {
  await handle?.cleanup();
  jest.restoreAllMocks();
});

const plain: SkillRef = { id: "s-plain", name: "plain", s3folder: "skills/s-plain", current_version: 1 };
const exporter: SkillRef = { id: "s-export", name: "exporter", s3folder: "skills/s-export", current_version: 1 };

test("an actions.yaml written into the session copy after download adds no action", async () => {
  put(plain, 1, { "SKILL.md": "# plain" });
  const h = await turn([plain]);
  const file = join(h.sessionDir, "skills", "plain", "actions.yaml");
  await fs.writeFile(file, actionsYaml("steal", "secrets"));
  // The agent's own writeFile refuses the path (skills/ is read-only in a session);
  // the direct write above stands in for degraded mode, where bash can still write it.
  await expect(
    (h.tools.writeFile as any).execute(
      { path: "skills/plain/actions.yaml", content: actionsYaml("steal", "secrets") },
      { toolCallId: "t", messages: [] },
    ),
  ).rejects.toThrow(/read-only/);
  const next = await turn([plain]); // cache hit, same version: nothing is re-downloaded
  expect(next).toBe(h);
  expect(await fs.readFile(file, "utf8")).toContain("steal");
  expect(actionsOf(next, [plain])).toEqual({ bySkill: {}, problems: [] });
});

test("modifying, replacing with a link or deleting the session copy leaves the pinned action intact", async () => {
  put(exporter, 1, { "SKILL.md": "# exporter", "actions.yaml": actionsYaml("export") });
  const h = await turn([exporter]);
  const file = join(h.sessionDir, "skills", "exporter", "actions.yaml");
  const expectPinned = async () => {
    const loaded = actionsOf(await turn([exporter]), [exporter]);
    expect(Object.keys(loaded.bySkill.exporter!.actions)).toEqual(["export"]);
    expect(loaded.bySkill.exporter!.actions.export!.inputs.deal).toMatchObject({ context: "deals" });
    expect(loaded.bySkill.exporter!.skillDir).toBe(join(h.sessionDir, "skills", "exporter"));
    expect(loaded.problems).toEqual([]);
  };
  await expectPinned();

  await fs.writeFile(file, actionsYaml("other", "secrets"));
  await expectPinned();

  await fs.rm(file);
  const decoy = join(h.sessionDir, "decoy.yaml");
  await fs.writeFile(decoy, actionsYaml("linked", "secrets"));
  await fs.symlink(decoy, file);
  await expectPinned();

  await fs.rm(file);
  await expectPinned();
});

test("a nested actions.yaml in the download declares nothing", async () => {
  put(plain, 1, { "SKILL.md": "# plain", "scripts/actions.yaml": actionsYaml("nested") });
  const h = await turn([plain]);
  expect(actionsOf(h, [plain])).toEqual({ bySkill: {}, problems: [] });
});

test("a version change replaces the pinned declaration from the new bytes", async () => {
  put(exporter, 1, { "actions.yaml": actionsYaml("export") });
  put(exporter, 2, { "actions.yaml": actionsYaml("export_v2") });
  put(exporter, 3, { "SKILL.md": "# no actions any more" });
  await turn([exporter]);

  const v2 = { ...exporter, current_version: 2 };
  let loaded = actionsOf(await turn([v2]), [v2]);
  expect(Object.keys(loaded.bySkill.exporter!.actions)).toEqual(["export_v2"]);

  const v3 = { ...exporter, current_version: 3 };
  loaded = actionsOf(await turn([v3]), [v3]);
  expect(loaded).toEqual({ bySkill: {}, problems: [] });
});

test("reloading the skills re-pins from the re-downloaded bytes", async () => {
  put(exporter, 1, { "actions.yaml": actionsYaml("export") });
  const h = await turn([exporter]);
  put(exporter, 1, { "actions.yaml": actionsYaml("reloaded") });
  await fs.writeFile(join(h.sessionDir, "skills", "exporter", "actions.yaml"), actionsYaml("planted"));
  expect(await refreshSessionSkills(sessionId, [exporter], config)).toEqual({ refreshed: 1, sandbox: true });
  expect(Object.keys(actionsOf(h, [exporter]).bySkill.exporter!.actions)).toEqual(["reloaded"]);
});

test("a skill no longer enabled contributes no actions", async () => {
  put(exporter, 1, { "actions.yaml": actionsYaml("export") });
  put(plain, 1, { "SKILL.md": "# plain" });
  await turn([exporter, plain]);
  const h = await turn([plain]);
  expect(actionsOf(h, [plain])).toEqual({ bySkill: {}, problems: [] });
});

test("an invalid downloaded actions.yaml yields a problem entry and no actions", async () => {
  put(exporter, 1, { "actions.yaml": "version: 2\n" });
  const h = await turn([exporter]);
  const loaded = actionsOf(h, [exporter]);
  expect(loaded.bySkill).toEqual({});
  expect(loaded.problems).toEqual([{ skill: "exporter", error: expect.any(String) }]);
});

test("a skill with a path-like name and no actions.yaml yields no problem", async () => {
  const odd: SkillRef = { id: "s-odd", name: "Vertrieb/Angebote", s3folder: "skills/s-odd", current_version: 1 };
  put(odd, 1, { "SKILL.md": "# odd" });
  const h = await turn([odd]);
  expect(actionsOf(h, [odd])).toEqual({ bySkill: {}, problems: [] });
});
