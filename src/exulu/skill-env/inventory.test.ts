import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { ENV_CLASSIFICATION, isSecretEnvName, findUnclassifiedSecretShaped } from "./inventory";

const walk = (dir: string, out: string[] = []): string[] => {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.ts$/.test(p) && !/\.test\.ts$/.test(p)) out.push(p);
  }
  return out;
};

test("every process.env name the backend reads is classified", () => {
  const names = new Set<string>();
  for (const root of ["src", "ee"]) {
    for (const file of walk(root)) {
      const src = readFileSync(file, "utf8");
      for (const m of src.matchAll(/process\.env\.([A-Z0-9_]+)/g)) names.add(m[1]);
    }
  }
  const missing = [...names].filter((n) => !(n in ENV_CLASSIFICATION)).sort();
  expect(missing).toEqual([]);
});

test("known platform secrets are classified secret", () => {
  for (const n of ["NEXTAUTH_SECRET", "POSTGRES_DB_PASSWORD", "LITELLM_MASTER_KEY"]) {
    expect(isSecretEnvName(n)).toBe(true);
  }
});

test("runtime settings are not treated as secrets", () => {
  for (const n of ["PATH", "HOME", "LANG", "NODE_ENV"]) {
    expect(isSecretEnvName(n)).toBe(false);
  }
});

test("secret-shaped but unclassified names are reported, not stripped", () => {
  expect(findUnclassifiedSecretShaped({ ACME_API_KEY: "x", PATH: "/bin" })).toEqual(["ACME_API_KEY"]);
});
