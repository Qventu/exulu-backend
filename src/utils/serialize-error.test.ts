import { serializeError } from "./serialize-error";

describe("serializeError — a JSON-safe shape for storing failures in job_results.error", () => {
  it("keeps name, message and stack of an Error (JSON.stringify(new Error()) is '{}')", () => {
    const err = new Error("Gemini timed out");
    const out = serializeError(err);
    expect(out).toMatchObject({ name: "Error", message: "Gemini timed out" });
    expect(typeof out.stack).toBe("string");
    expect(JSON.parse(JSON.stringify(out)).message).toBe("Gemini timed out");
  });

  it("carries enumerable extra fields such as code or statusCode", () => {
    const err = Object.assign(new Error("boom"), { code: "ECONNRESET", statusCode: 502 });
    expect(serializeError(err)).toMatchObject({ message: "boom", code: "ECONNRESET", statusCode: 502 });
  });

  it("includes a nested cause", () => {
    const err = new Error("outer", { cause: new Error("inner") });
    expect(serializeError(err).cause).toMatchObject({ message: "inner" });
  });

  it("wraps non-Error throwables", () => {
    expect(serializeError("plain string")).toEqual({ message: "plain string" });
    expect(serializeError({ detail: "obj" })).toMatchObject({ message: expect.stringContaining("obj") });
    expect(serializeError(undefined)).toEqual({ message: "undefined" });
  });
});
