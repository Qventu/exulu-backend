import { buildSkillEnv } from "./skill-env";

const base = { PATH: "/usr/bin", HOME: "/root", LANG: "de_DE.UTF-8" };

test("strips inventoried platform secrets", () => {
  const { env, strippedSecretNames } = buildSkillEnv({
    processEnv: { ...base, NEXTAUTH_SECRET: "s3cret", LITELLM_MASTER_KEY: "sk-0" },
    grantedVariables: {},
  });
  expect(env.NEXTAUTH_SECRET).toBeUndefined();
  expect(env.LITELLM_MASTER_KEY).toBeUndefined();
  expect(strippedSecretNames).toEqual(["LITELLM_MASTER_KEY", "NEXTAUTH_SECRET"]);
});

test("a canary secret never reaches a skill", () => {
  const { env } = buildSkillEnv({
    processEnv: { ...base, NEXTAUTH_SECRET: "EXULU_CANARY_VALUE" },
    grantedVariables: {},
  });
  expect(JSON.stringify(env)).not.toContain("EXULU_CANARY_VALUE");
});

test("third-party runtime settings pass through untouched", () => {
  const { env } = buildSkillEnv({
    processEnv: { ...base, PYMUPDF_MESSAGE: "fd:2", HF_HUB_ENABLE_HF_TRANSFER: "1" },
    grantedVariables: {},
  });
  expect(env.PYMUPDF_MESSAGE).toBe("fd:2");
  expect(env.HF_HUB_ENABLE_HF_TRANSFER).toBe("1");
  expect(env.LANG).toBe("de_DE.UTF-8");
});

test("only granted variables are injected", () => {
  const { env, grantedNames } = buildSkillEnv({
    processEnv: base,
    grantedVariables: { JIRA_CLIENT_ID: "abc" },
  });
  expect(env.JIRA_CLIENT_ID).toBe("abc");
  expect(grantedNames).toEqual(["JIRA_CLIENT_ID"]);
});

test("a granted variable colliding with a base runtime key is skipped", () => {
  const { env, skippedNames } = buildSkillEnv({
    processEnv: base,
    grantedVariables: { PATH: "/evil" },
  });
  expect(env.PATH).toBe("/usr/bin");
  expect(skippedNames).toEqual(["PATH"]);
});

test("a granted variable named like a platform secret carries the admin value, never the platform one", () => {
  const { env } = buildSkillEnv({
    processEnv: { ...base, NEXTAUTH_SECRET: "platform-value" },
    grantedVariables: { NEXTAUTH_SECRET: "admin-value" },
  });
  expect(env.NEXTAUTH_SECRET).toBe("admin-value");
});

test("names bash cannot export are skipped", () => {
  const { env, skippedNames } = buildSkillEnv({
    processEnv: base,
    grantedVariables: { "MY-VAR": "x", "2FA_KEY": "y", OK_VAR: "z" },
  });
  expect(env["MY-VAR"]).toBeUndefined();
  expect(env["2FA_KEY"]).toBeUndefined();
  expect(env.OK_VAR).toBe("z");
  expect(skippedNames).toEqual(["2FA_KEY", "MY-VAR"]);
});

test("computed overrides always win", () => {
  const { env } = buildSkillEnv({
    processEnv: base,
    grantedVariables: { NODE_PATH: "/tmp/evil" },
    overrides: { NODE_PATH: "/usr/lib/node_modules" },
  });
  expect(env.NODE_PATH).toBe("/usr/lib/node_modules");
});

test("a runtime-discovered secret name is stripped like an inventoried one", () => {
  // The LiteLLM config's `os.environ/ACME_PROVIDER_KEY` case: not in the
  // inventory, still a platform credential.
  const { env, strippedSecretNames } = buildSkillEnv({
    processEnv: { ...base, ACME_PROVIDER_KEY: "sk-acme" },
    grantedVariables: {},
    extraSecretNames: ["ACME_PROVIDER_KEY"],
  });
  expect(env.ACME_PROVIDER_KEY).toBeUndefined();
  expect(strippedSecretNames).toContain("ACME_PROVIDER_KEY");
});

test("an extra secret name absent from the environment changes nothing", () => {
  const { env, strippedSecretNames } = buildSkillEnv({
    processEnv: base,
    grantedVariables: {},
    extraSecretNames: ["NOT_SET_HERE"],
  });
  expect(strippedSecretNames).toEqual([]);
  expect(env.PATH).toBe("/usr/bin");
});

test("an admin-granted variable still wins over a runtime-discovered secret name", () => {
  // Same rule as for inventoried secrets: the platform's value goes, the
  // administrator's explicit grant stays.
  const { env } = buildSkillEnv({
    processEnv: { ...base, COHERE_API_KEY: "platform-value" },
    grantedVariables: { COHERE_API_KEY: "admin-value" },
    extraSecretNames: ["COHERE_API_KEY"],
  });
  expect(env.COHERE_API_KEY).toBe("admin-value");
});
