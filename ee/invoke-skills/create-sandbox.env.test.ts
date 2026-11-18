const src: string = require("fs").readFileSync(
  require("path").join(__dirname, "create-sandbox.ts"),
  "utf8",
);

/**
 * Source-text guards, not behaviour tests: both exec paths inherit the full
 * parent environment if their `env` option is simply absent, and nothing in the
 * type system notices. Deleting `env: sandboxedExecEnv` from either call is a
 * silent, total regression of this branch, so each call site is asserted here.
 */

test("the bash tool's execAsync call is given the constructed env", () => {
  // This is the PRIMARY path — every command the bash tool runs goes through
  // it. A guard that only covered the spawn would have let a deletion here
  // through unnoticed.
  const execCalls = [...src.matchAll(/execAsync\(\s*[\s\S]{0,300}?\)/g)];
  expect(execCalls.length).toBeGreaterThan(0);
  for (const call of execCalls) {
    expect(call[0]).toContain("env: sandboxedExecEnv");
  }
});

test("the writeFile spawn is given an explicit env, never the inherited one", () => {
  // Guard against regression of the original leak-by-omission: the spawn
  // passed no `env` at all.
  const spawnCalls = [...src.matchAll(/spawn\(\s*['"]\/bin\/bash['"][\s\S]{0,200}?\)/g)];
  expect(spawnCalls.length).toBeGreaterThan(0);
  for (const call of spawnCalls) {
    // Either the session env itself, or the per-call merge built from it (runCommand).
    expect(call[0]).toMatch(/env: (sandboxedExecEnv|callEnv)\b/);
    if (call[0].includes("env: callEnv")) {
      expect(src).toContain("const callEnv = { ...sandboxedExecEnv");
    }
  }
  // runCommand's spawn is the security-relevant one: it must stay asserted here.
  expect(spawnCalls.some((c) => c[0].includes("env: callEnv"))).toBe(true);
});
