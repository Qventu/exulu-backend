import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureProfile, profileIdFor } from "./provisioner";

const ORIGINAL_ENV = { ...process.env };
let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "hermes-prov-"));
  process.env.HERMES_HOME = home;
  process.env.LITELLM_MASTER_KEY = "sk-test-master";
  process.env.LITELLM_HOST = "127.0.0.1";
  process.env.LITELLM_PORT = "4000";
});

afterEach(async () => {
  process.env = { ...ORIGINAL_ENV };
  await rm(home, { recursive: true, force: true });
});

const profileDir = (id: string) => join(home, "profiles", id);

describe("ensureProfile", () => {
  it("writes config.yaml, SOUL.md, .env and a hash", async () => {
    await ensureProfile({
      profileId: "agent-1",
      instructions: "Be a precise research assistant.",
      modelName: "claude-haiku",
    });

    const dir = profileDir("agent-1");
    const config = await readFile(join(dir, "config.yaml"), "utf8");
    expect(config).toContain('default: "claude-haiku"');
    expect(config).toContain("provider: custom");
    expect(config).toContain('base_url: "http://127.0.0.1:4000/v1"');
    expect(config).toContain('api_key: "${LITELLM_MASTER_KEY}"');

    const soul = await readFile(join(dir, "SOUL.md"), "utf8");
    expect(soul).toBe("Be a precise research assistant.\n");

    const env = await readFile(join(dir, ".env"), "utf8");
    expect(env).toContain("LITELLM_MASTER_KEY=sk-test-master");

    await expect(readFile(join(dir, ".exulu-hash"), "utf8")).resolves.toHaveLength(64);
  });

  it("writes the .env file with 0600 permissions", async () => {
    await ensureProfile({ profileId: "agent-1", instructions: "x", modelName: "m" });
    const st = await stat(join(profileDir("agent-1"), ".env"));
    // Mask to the permission bits; expect owner-only read/write.
    expect(st.mode & 0o777).toBe(0o600);
  });

  it("falls back to a default SOUL when instructions are empty", async () => {
    await ensureProfile({ profileId: "agent-2", instructions: "  ", modelName: "m" });
    const soul = await readFile(join(profileDir("agent-2"), "SOUL.md"), "utf8");
    expect(soul.trim().length).toBeGreaterThan(0);
    expect(soul).not.toBe("  ");
  });

  it("is hash-gated: unchanged inputs do not rewrite files", async () => {
    await ensureProfile({ profileId: "agent-3", instructions: "v1", modelName: "m" });
    const dir = profileDir("agent-3");
    const firstMtime = (await stat(join(dir, "SOUL.md"))).mtimeMs;

    await new Promise((r) => setTimeout(r, 10));
    await ensureProfile({ profileId: "agent-3", instructions: "v1", modelName: "m" });
    const secondMtime = (await stat(join(dir, "SOUL.md"))).mtimeMs;
    expect(secondMtime).toBe(firstMtime);
  });

  it("re-provisions when instructions change", async () => {
    await ensureProfile({ profileId: "agent-4", instructions: "v1", modelName: "m" });
    await ensureProfile({ profileId: "agent-4", instructions: "v2", modelName: "m" });
    const soul = await readFile(join(profileDir("agent-4"), "SOUL.md"), "utf8");
    expect(soul).toBe("v2\n");
  });

  it("dedupes concurrent provisioning of the same profile", async () => {
    await Promise.all([
      ensureProfile({ profileId: "agent-5", instructions: "v1", modelName: "m" }),
      ensureProfile({ profileId: "agent-5", instructions: "v1", modelName: "m" }),
      ensureProfile({ profileId: "agent-5", instructions: "v1", modelName: "m" }),
    ]);
    const soul = await readFile(join(profileDir("agent-5"), "SOUL.md"), "utf8");
    expect(soul).toBe("v1\n");
  });
});

describe("profileIdFor", () => {
  it("returns the agent id for shared scope", () => {
    expect(profileIdFor("agent-1", "shared", 42)).toBe("agent-1");
    expect(profileIdFor("agent-1", "shared")).toBe("agent-1");
  });

  it("returns agent/user for private scope", () => {
    expect(profileIdFor("agent-1", "private", 42)).toBe("agent-1/42");
  });

  it("throws for private scope without a user id", () => {
    expect(() => profileIdFor("agent-1", "private")).toThrow(/requires a user id/);
  });
});
