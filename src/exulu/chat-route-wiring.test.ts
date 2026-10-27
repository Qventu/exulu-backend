/**
 * Source gate for the chat route's turn lifecycle. The route handler itself is
 * a thousand-line Express closure that no test builds, so the pieces it has to
 * keep wired are asserted against its text — the same approach
 * core-schema.test.ts takes to routes.ts's createSDL list.
 *
 * The behaviour each line buys is tested on its own: stream-persistence.test.ts
 * (a departed client still gets its turn saved) and session-activity.test.ts
 * (what each stamp writes).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = (): string => readFileSync(join(__dirname, "routes.ts"), "utf8");

describe("chat route — turn survives the viewer leaving", () => {
  it("drains a server-side tee so onFinish (and saveChat) always runs", () => {
    expect(source()).toContain("...persistThroughDisconnect(),");
  });

  it("no longer leans on result.stream.consumeStream() for persistence", () => {
    // It drains the raw fullStream tee, which onFinish does not sit on — the
    // original bug was believing otherwise. Statements only: the comment at
    // the call site names the removed call on purpose.
    const statements = source()
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => !line.startsWith("//") && line.startsWith("result.stream.consumeStream("));
    expect(statements).toEqual([]);
  });
});

describe("chat route — chat-list activity stamps", () => {
  it("marks the session as working when the turn starts", () => {
    expect(source()).toContain("void markSessionGenerating(db, headers.session as string);");
  });

  it("marks an answer as waiting when the turn produced one", () => {
    expect(source()).toContain("await markSessionAnswered(db, headers.session as string);");
  });

  it("puts the row back to quiet when a turn produces nothing", () => {
    // Three paths reach this: failed before streaming, stream errored, and a
    // turn that finished with an empty response message.
    expect(source().split("markSessionIdle(db, headers.session as string)").length - 1).toBe(3);
  });
});
