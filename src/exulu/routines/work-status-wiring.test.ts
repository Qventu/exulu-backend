/**
 * Wiring gate for routine work statuses. The worker-vs-chat origin of a
 * status write is decided by whether `jobResultId` reaches generateStream as
 * `routineRun`; when it is dropped anywhere the handle is still built from
 * session metadata, as "chat", and a worker retry then overrides a status a
 * person set — silently. These call sites sit in files that pull in the whole
 * platform, so they are asserted against the source text, the way
 * mark-session-seen-wiring.test.ts does.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (rel: string) => readFileSync(join(__dirname, "../../..", rel), "utf8");

/** The argument object of every `name({ … })` call, by brace matching. */
const callArgs = (source: string, name: string): string[] => {
  const out: string[] = [];
  let from = 0;
  for (;;) {
    const at = source.indexOf(`${name}({`, from);
    if (at === -1) return out;
    let depth = 0;
    let i = at + name.length + 1;
    for (; i < source.length; i++) {
      if (source[i] === "{") depth++;
      else if (source[i] === "}" && --depth === 0) break;
    }
    out.push(source.slice(at, i + 1));
    from = i;
  }
};

describe("routine work status wiring", () => {
  it.each(["ee/workers.ts", "src/graphql/schemas/index.ts"])(
    "%s: every routine run passes its jobResultId into processUiMessagesFlow",
    (file) => {
      const calls = callArgs(read(file), "await processUiMessagesFlow").filter((call) => /\broutine:/.test(call));
      expect(calls.length).toBeGreaterThan(0);
      for (const call of calls) expect(call).toMatch(/\bjobResultId\b/);
    },
  );

  it("processUiMessagesFlow hands the run to generateStream as routineRun", () => {
    expect(read("ee/workers.ts")).toMatch(/routineRun:\s*jobResultId\s*\?\s*\{\s*jobResultId\s*\}/);
  });

  it("the queue-less run path gives the run the routine's default status", () => {
    const source = read("src/graphql/schemas/index.ts");
    const start = source.indexOf("running a workflow directly without queue");
    const insert = source.slice(start, source.indexOf(".returning(", start));
    expect(insert).toMatch(/defaultWorkStatusColumns\(db, workflow_template_id\)/);
  });

  it("existing deployments get the work-status index (addMissingFields adds no indexes)", () => {
    expect(read("src/postgres/init-exulu-db.ts")).toMatch(
      /CREATE INDEX IF NOT EXISTS job_results_workflow_work_status_created_idx\s+ON job_results \(workflow, work_status, "createdAt"\)/,
    );
  });
});
