test("the writeFile spawn is given an explicit env, never the inherited one", () => {
  // Guard against regression of the leak-by-omission at create-sandbox.ts:755.
  const src = require("fs").readFileSync(
    require("path").join(__dirname, "create-sandbox.ts"),
    "utf8",
  );
  const spawnCalls = [...src.matchAll(/spawn\(\s*['"]\/bin\/bash['"][\s\S]{0,200}?\)/g)];
  expect(spawnCalls.length).toBeGreaterThan(0);
  for (const call of spawnCalls) {
    expect(call[0]).toContain("env: sandboxedExecEnv");
  }
});
