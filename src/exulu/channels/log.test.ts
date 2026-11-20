import { safeError, sanitizedError } from "./log";

const leaky = () => {
  const e = new Error(`insert into "channel_links" values ('4915112345678', 'Wie tausche ich das Relais?')`) as Error & {
    code?: string;
    detail?: string;
    cause?: unknown;
  };
  e.code = "23505";
  e.detail = "Key (identity)=(4915112345678) already exists.";
  e.cause = new Error("4915112345678");
  return e;
};

describe("safeError", () => {
  it("keeps only the class name and a short code", () => {
    expect(safeError(leaky())).toEqual({ name: "Error", code: "23505" });
    expect(JSON.stringify(safeError(leaky()))).not.toMatch(/4915112345678|Relais/);
  });

  it("uses the subclass name", () => {
    class GraphError extends Error {}
    expect(safeError(new GraphError("to 4915112345678"))).toEqual({ name: "GraphError" });
  });

  it("drops a code that is not a short token", () => {
    expect(safeError(Object.assign(new Error("x"), { code: "recipient 4915112345678 invalid" }))).toEqual({ name: "Error" });
    expect(safeError(Object.assign(new Error("x"), { code: 42 }))).toEqual({ name: "Error" });
  });

  it("handles non-errors", () => {
    expect(safeError("4915112345678")).toEqual({ name: "string" });
    expect(safeError(null)).toEqual({ name: "object" });
    expect(safeError(undefined)).toEqual({ name: "undefined" });
  });
});

describe("sanitizedError", () => {
  it("carries the context and the safe parts only", () => {
    const e = sanitizedError("channel_message job failed on channel c1", leaky());
    expect(e.message).toBe("channel_message job failed on channel c1 (Error 23505)");
    expect(e.stack ?? "").not.toMatch(/4915112345678|Relais/);
  });
});
