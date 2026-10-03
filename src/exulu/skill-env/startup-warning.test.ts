import { skillEnvStartupWarning } from "./startup-warning";

test("warns about secret-shaped names the inventory does not know", () => {
  expect(skillEnvStartupWarning({ ACME_API_KEY: "x", PATH: "/bin" }))
    .toContain("ACME_API_KEY");
});

test("says nothing when every secret-shaped name is classified", () => {
  expect(skillEnvStartupWarning({ PATH: "/bin", NEXTAUTH_SECRET: "x" })).toBeNull();
});
