import type { ExuluQueueConfig } from "@EXULU_TYPES/queue-config";
import { resolveAvailableQueues } from "./available-queues";

const cfg = (name: string) =>
  ({ queue: { name } }) as unknown as ExuluQueueConfig;

describe("resolveAvailableQueues", () => {
  it("maps registered queue configs to { name }", () => {
    expect(
      resolveAvailableQueues(() => [cfg("email_intake"), cfg("reports")]),
    ).toEqual([{ name: "email_intake" }, { name: "reports" }]);
  });

  it("returns [] when the accessor throws (app not initialized)", () => {
    expect(
      resolveAvailableQueues(() => {
        throw new Error("ExuluApp not initialized");
      }),
    ).toEqual([]);
  });

  it("returns [] when no queues are registered", () => {
    expect(resolveAvailableQueues(() => [])).toEqual([]);
  });

  it("excludes built-in/system (global) queues", () => {
    const getQueues = () => [
      cfg("eval_runs"),
      cfg("reports"),
      cfg("email_intake"),
      cfg("summaries"),
    ];
    expect(
      resolveAvailableQueues(getQueues, ["eval_runs", "email_intake"]),
    ).toEqual([{ name: "reports" }, { name: "summaries" }]);
  });

  it("without exclusions, returns every registered queue", () => {
    expect(resolveAvailableQueues(() => [cfg("only")])).toEqual([
      { name: "only" },
    ]);
  });
});
