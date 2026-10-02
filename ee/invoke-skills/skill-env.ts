import { isSecretEnvName } from "@SRC/exulu/skill-env/inventory";

export type BuildSkillEnvArgs = {
  processEnv: NodeJS.ProcessEnv;
  grantedVariables: Record<string, string>;
  overrides?: NodeJS.ProcessEnv;
  /**
   * Secret names discovered at runtime rather than declared in the inventory —
   * today the `os.environ/NAME` directives in the deployment's
   * config.litellm.yaml (see src/exulu/litellm/os-environ-names.ts). Treated
   * exactly like an inventoried secret. Still a denylist: nothing is kept
   * because it appears here, only removed.
   */
  extraSecretNames?: readonly string[];
};

export type BuildSkillEnvResult = {
  env: NodeJS.ProcessEnv;
  strippedSecretNames: string[];
  grantedNames: string[];
  skippedNames: string[];
};

const POSIX_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The only way a skill's bash environment is constructed.
 *
 * Order: base runtime env (process.env minus declared secrets), then granted
 * variables, then computed overrides. Unknown names pass through by design —
 * stripping what we cannot enumerate is what breaks the document toolchain.
 */
export const buildSkillEnv = ({
  processEnv,
  grantedVariables,
  overrides = {},
  extraSecretNames = [],
}: BuildSkillEnvArgs): BuildSkillEnvResult => {
  const env: NodeJS.ProcessEnv = {};
  const strippedSecretNames: string[] = [];
  const extraSecrets = new Set(extraSecretNames);

  for (const [name, value] of Object.entries(processEnv)) {
    if (isSecretEnvName(name) || extraSecrets.has(name)) {
      strippedSecretNames.push(name);
      continue;
    }
    env[name] = value;
  }

  const baseKeys = new Set(Object.keys(env));
  const grantedNames: string[] = [];
  const skippedNames: string[] = [];

  for (const [name, value] of Object.entries(grantedVariables)) {
    if (!POSIX_NAME.test(name) || baseKeys.has(name)) {
      skippedNames.push(name);
      continue;
    }
    env[name] = value;
    grantedNames.push(name);
  }

  Object.assign(env, overrides);

  return {
    env,
    strippedSecretNames: strippedSecretNames.sort(),
    grantedNames: grantedNames.sort(),
    skippedNames: skippedNames.sort(),
  };
};
