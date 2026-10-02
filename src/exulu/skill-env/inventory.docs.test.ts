import { existsSync, readFileSync } from "fs";
import { join } from "path";
import {
  ENV_CLASSIFICATION,
  isSecretEnvName,
  isSecretShapedEnvName,
} from "./inventory";

/**
 * The second completeness guard, and the one that catches the class
 * inventory.test.ts structurally cannot see.
 *
 * `@exulu/backend` is a library. The consumer app reads the deployment's
 * environment and passes values in — SIGNOZ_ACCESS_TOKEN arrives through
 * ExuluOtel's parameter object, VERTEX_CREDENTIALS_PATH never reaches our code
 * at all (LiteLLM resolves it from config.litellm.yaml). A scan for
 * `process.env.X` in src/ and ee/ therefore sees none of them, while the
 * sandbox builder sees all of them in process.env.
 *
 * The documentation page is where the platform's real secret set is written
 * down, so it is what we reconcile against. We chose parsing the MDX over a
 * hand-maintained list because a hand-maintained list is one more thing to
 * forget: the docs page is already updated as part of shipping a new
 * deployment variable, and parsing it makes that update the trigger.
 */
const DOCS_PATH = join(
  __dirname,
  "../../../mintlify-docs/self-hosting/environment-variables.mdx",
);

/** A `| `NAME` | ... |` markdown table row for a Server/Worker variable. */
type DocRow = { name: string; component: string };

// Matches a Component cell: "Server", "Worker", "Server, Worker",
// "Server, Frontend". Deliberately anchored, so "Whisper container",
// "Frontend" and "LiteLLM UI" rows do not match, and so a Purpose cell that
// merely mentions a server cannot masquerade as a Component cell.
const COMPONENT_CELL = /^(Server|Worker)(,\s*(Server|Worker|Frontend))*$/;

export const parseServerWorkerVariables = (mdx: string): DocRow[] => {
  const rows: DocRow[] = [];
  for (const line of mdx.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|")) continue;
    const cells = trimmed
      .split("|")
      .slice(1, -1)
      .map((c) => c.trim());
    if (cells.length < 2) continue;
    // First cell is the variable name, in backticks, SCREAMING_SNAKE_CASE.
    const nameMatch = cells[0]?.match(/^`([A-Z][A-Z0-9_]*)`$/);
    if (!nameMatch) continue;
    // The Component column sits at index 1 or 2 depending on the table
    // (some tables carry a Default column), so scan the first few cells.
    const component = cells.slice(1, 4).find((c) => COMPONENT_CELL.test(c));
    if (!component) continue;
    rows.push({ name: nameMatch[1]!, component });
  }
  return rows;
};

const docs = () => {
  expect(existsSync(DOCS_PATH)).toBe(true);
  return readFileSync(DOCS_PATH, "utf8");
};

test("the documentation page still parses into Server/Worker variable rows", () => {
  const rows = parseServerWorkerVariables(docs());
  // Guards the parser itself: a docs reformat that silently stops matching
  // would turn this whole file into a no-op.
  expect(rows.length).toBeGreaterThan(40);
  const names = rows.map((r) => r.name);
  expect(names).toContain("POSTGRES_DB_PASSWORD");
  expect(names).toContain("VERTEX_CREDENTIALS_PATH");
  expect(names).toContain("SIGNOZ_ACCESS_TOKEN");
  // Frontend-only and Whisper-container rows are out of scope for the backend
  // environment, so they must NOT be picked up.
  expect(names).not.toContain("EMAIL_SERVER_PASSWORD");
  expect(names).not.toContain("HF_AUTH_TOKEN");
});

test("every credential-shaped Server/Worker variable in the docs is classified", () => {
  const credentialShaped = parseServerWorkerVariables(docs())
    .map((r) => r.name)
    .filter(isSecretShapedEnvName);
  const unclassified = [...new Set(credentialShaped)]
    .filter((n) => !(n in ENV_CLASSIFICATION))
    .sort();
  expect(unclassified).toEqual([]);
});

test("the deployment credentials the code scan cannot see are classified secret", () => {
  // Regression lock for the three found by the final branch review, plus the
  // provider keys that reach LiteLLM through config.litellm.yaml.
  for (const name of [
    "VERTEX_CREDENTIALS_PATH",
    "COHERE_API_KEY",
    "SIGNOZ_ACCESS_TOKEN",
    "GOOGLE_VERTEX_CREDENTIALS_JSON",
    "GOOGLE_VERTEX_PROJECT",
    "AZURE_API_KEY_EU",
    "OPENAI_API_KEY",
  ]) {
    expect(isSecretEnvName(name)).toBe(true);
  }
});
