/**
 * `claim_checks` must stay in the two GDPR paths its sibling `feedback` is in.
 *
 * The stored `payload` is customer content — the answer's sentences and
 * verbatim quotes from source documents — keyed by `user`. When this branch
 * added the table it did not add it to either path, which made
 * `DELETE /users/:id`'s own docblock ("hard-deletes the user and every row
 * referencing them in one transaction") false, and left an Art. 15 export
 * silently incomplete.
 *
 * Both handlers live inside `createExpressRoutes`, a 5,000-line factory that
 * takes a live Postgres client, an S3 config and the whole tool registry, so
 * there is no seam to call them through — the project's answer to that is an
 * invariant over the source (see init-exulu-db.destructive.test.ts and
 * skill-env/inventory.docs.test.ts, same pattern). It is a weaker test than a
 * behavioural one and it is deliberately narrow: it asserts the statements are
 * present and scoped to the target user, not that they run. The session-level
 * cascade, which does have a seam, is tested properly in
 * routines/run-state.test.ts.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = readFileSync(join(__dirname, "..", "routes.ts"), "utf8");

/** The source between two markers, so each assertion sees one handler only. */
function region(from: string, to: string): string {
  const start = source.indexOf(from);
  const end = source.indexOf(to, start + from.length);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

const exportHandler = region('app.get("/users/:id/data-export"', 'app.delete("/users/:id"');
const deleteHandler = region('app.delete("/users/:id"', "End GDPR");

describe("GET /users/:id/data-export", () => {
  it("reads the caller's claim_checks rows, scoped by user", () => {
    expect(exportHandler).toMatch(/from\("claim_checks"\)\s*\.where\(\{ user: targetUser\.id \}\)/);
  });

  it("writes them into the archive and names them in the README", () => {
    expect(exportHandler).toContain('zip.file("claim_checks.json"');
    expect(exportHandler).toContain("claim_checks.json     answer verification results");
  });

  it("still exports the sibling tables it was modelled on", () => {
    // Guards against a refactor that drops a line while this file's own
    // assertions keep passing.
    expect(exportHandler).toContain('zip.file("feedback.json"');
    expect(exportHandler).toContain('zip.file("tracking.json"');
  });
});

describe("DELETE /users/:id", () => {
  it("deletes the user's claim_checks rows inside the transaction, scoped by user", () => {
    expect(deleteHandler).toMatch(/trx\("claim_checks"\)\s*\.where\(\{ user: targetUser\.id \}\)\s*\.delete\(\)/);
  });

  it("asks whether the table exists first, so an unlicensed deployment still deletes the user", () => {
    // claim_checks is created only when the deployment is licensed for
    // claim-check (ee/schemas.ts via core-schema). An unguarded delete would
    // abort the transaction and leave the user — and every other row — in
    // place on every deployment without that licence, which is a worse bug
    // than the one this guards.
    expect(deleteHandler).toMatch(/if \(await trx\.schema\.hasTable\("claim_checks"\)\)/);
  });

  it("still deletes the sibling tables it was modelled on", () => {
    expect(deleteHandler).toMatch(/trx\("feedback"\)/);
    expect(deleteHandler).toMatch(/trx\("users"\)/);
  });
});
