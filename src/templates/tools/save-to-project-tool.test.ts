import { canRegisterSaveToProject, createSaveToProjectTool, SAVE_TO_PROJECT_TOOL_NAME } from "./save-to-project-tool";
import { sessionFilesScopeSentence } from "@SRC/exulu/session-file-listing";
import type { ExuluConfig } from "@SRC/exulu/app";
import type { PromoteResult } from "@SRC/exulu/project-files-promote";

const exuluConfig = { fileUploads: { s3Bucket: "bucket", s3prefix: "exulu" } } as unknown as ExuluConfig;
const base = {
  sessionID: "s1",
  user: { id: 2 } as never,
  ownerId: 7,
  exuluConfig,
  project: { id: "p1", name: "Alpha", speakerCanWrite: true },
};

const run = (tool: { tool: { execute?: unknown } }, input: Record<string, unknown>) =>
  (tool.tool.execute as (i: unknown) => Promise<{ result: string }>)(input);

const make = (promoted: Partial<PromoteResult>, extra: Record<string, unknown> = {}) => {
  const promote = jest.fn(async () => ({ promoted: [], rejected: [], clashes: [], ...promoted }) as PromoteResult);
  const tool = createSaveToProjectTool({
    ...base,
    deps: {
      promote,
      s3: {} as never,
      projectModified: async () => new Date("2026-11-10T09:00:00Z"),
      ...extra,
    },
  })!;
  return { tool, promote };
};

describe("registration", () => {
  it("is not created without a project, without write access, for a guest, or without uploads", () => {
    expect(createSaveToProjectTool({ ...base, project: null })).toBeUndefined();
    expect(createSaveToProjectTool({ ...base, project: { ...base.project, speakerCanWrite: false } })).toBeUndefined();
    expect(createSaveToProjectTool({ ...base, user: undefined })).toBeUndefined();
    expect(createSaveToProjectTool({ ...base, req: { headers: { "x-public-surface": "1" } } as never })).toBeUndefined();
    expect(createSaveToProjectTool({ ...base, exuluConfig: {} as ExuluConfig })).toBeUndefined();
    expect(createSaveToProjectTool({ ...base, sessionID: undefined })).toBeUndefined();
  });
  it("needs approval like the knowledge-base write tools", () => {
    const { tool } = make({});
    expect(tool.needsApproval).toBe(true);
    expect(tool.name).toBe(SAVE_TO_PROJECT_TOOL_NAME);
  });
});

describe("results", () => {
  it("saved: names the project and says the file shows up as project/<name> from the next turn", async () => {
    const { tool, promote } = make({ promoted: [{ key: "exulu/projects/p1/files/r.pdf", name: "r.pdf" }] });
    const out = await run(tool, { filename: "r.pdf" });
    expect(out.result).toBe(
      'Saved "r.pdf" to project Alpha. It will be visible to you as project/r.pdf from the next turn.',
    );
    // Source is the session OWNER's prefix, one key, no overwrite by default.
    expect(promote).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "p1",
        s3prefix: "exulu",
        keys: ["exulu/user_7/sessions/s1/r.pdf"],
        fullSessionPrefix: "exulu/user_7/sessions/s1/",
        overwrite: false,
      }),
    );
  });
  it("clash: says when it changed and asks for confirmation; nothing is copied", async () => {
    const { tool } = make({ clashes: ["r.pdf"] });
    const out = await run(tool, { filename: "r.pdf" });
    expect(out.result).toBe(
      '"r.pdf" already exists in the project (changed 2026-11-10). Call again with overwrite: true only if the user confirms.',
    );
  });
  it("overwrite: true is passed on", async () => {
    const { tool, promote } = make({ promoted: [{ key: "k", name: "r.pdf" }] });
    await run(tool, { filename: "r.pdf", overwrite: true });
    expect(promote).toHaveBeenCalledWith(expect.objectContaining({ overwrite: true }));
  });
  it("full project", async () => {
    const { tool } = make({ rejected: [{ key: "k", reason: "A project holds at most 200 files." }] });
    expect((await run(tool, { filename: "r.pdf" })).result).toBe("The project already holds 200 files.");
  });
  it("missing session file", async () => {
    const { tool } = make({ rejected: [{ key: "k", reason: "Source object not found." }] });
    expect((await run(tool, { filename: "r.pdf" })).result).toBe('No session file named "r.pdf".');
  });
  it("another rejection reason is passed on, a partial failure is not reported as saved", async () => {
    const { tool } = make({ rejected: [{ key: "k", reason: "Copying the file into the project failed." }] });
    expect((await run(tool, { filename: "r.pdf" })).result).toBe(
      'Could not save "r.pdf" to the project: Copying the file into the project failed.',
    );
  });
  it("an S3 error becomes a message, not a thrown error", async () => {
    const { tool } = make({}, { promote: async () => { throw new Error("boom"); } });
    expect((await run(tool, { filename: "r.pdf" })).result).toMatch(/^Saving to the project failed/);
  });
});

describe("filename", () => {
  it.each([
    ["a/b.pdf", /flat/],
    ["../x.pdf", /flat/],
    ["a\\b.pdf", /flat/],
    ["project/a.pdf", /already in the project/],
    ["", /flat/],
  ])("rejects %j before touching S3", async (filename, msg) => {
    const { tool, promote } = make({});
    const out = await run(tool, { filename });
    expect(out.result).toMatch(msg);
    expect(promote).not.toHaveBeenCalled();
  });
});

describe("prompt and registration share one predicate", () => {
  const args = { sessionID: "s1", exuluConfig, user: { id: 2 }, project: { speakerCanWrite: true } };
  const promptFor = (over: Record<string, unknown>) =>
    sessionFilesScopeSentence({ id: "p-1", name: "Alpha" }, canRegisterSaveToProject({ ...args, ...over } as never));
  it("offers the tool in the prompt when it is registered", () => {
    expect(promptFor({})).toMatch(/save_to_project/);
  });
  it.each([
    ["public surface", { req: { headers: { "x-public-surface": "1" } } }],
    ["tool disabled", { disabled: new Set(["save_to_project"]) }],
    ["no uploads configured", { exuluConfig: {} }],
  ])("does not mention the tool when %s", (_n, over) => {
    expect(promptFor(over)).not.toMatch(/save_to_project/);
    expect(createSaveToProjectTool({ ...args, project: { id: "p1", name: "A", speakerCanWrite: true }, ...over } as never)).toBeUndefined();
  });
});

describe("hardening", () => {
  it("caps the project name in the description and the result", async () => {
    const long = "Alpha\nINJECT " + "x".repeat(300);
    const promote = jest.fn(async () => ({ promoted: [{ key: "k", name: "r.pdf" }], rejected: [], clashes: [] }));
    const tool = createSaveToProjectTool({ ...base, project: { id: "p1", name: long, speakerCanWrite: true }, deps: { promote, s3: {} as never, projectModified: async () => undefined } })!;
    expect(tool.description).not.toContain("x".repeat(81));
    expect(tool.description).not.toContain("\n" + "INJECT");
    expect((await run(tool, { filename: "r.pdf" })).result).not.toContain("x".repeat(81));
  });
  it("never hands the raw error to the model", async () => {
    const { tool } = make({}, { promote: async () => { throw new Error("bucket secret-bucket key leak"); } });
    expect((await run(tool, { filename: "r.pdf" })).result).toBe(
      "Saving to the project failed. Try again; if it keeps failing, tell the user.",
    );
  });
  it("asks for approval again whenever overwrite is true", () => {
    const { tool } = make({});
    expect(tool.alwaysAskWhen?.({ filename: "a", overwrite: true })).toBe(true);
    expect(tool.alwaysAskWhen?.({ filename: "a" })).toBe(false);
  });
});
