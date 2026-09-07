import { TypeValidationError } from "ai";
import { describeRequestError } from "./request-error";
import { ContextCompactionRequiredError, deriveContextBudget } from "./context-budget";

describe("describeRequestError — HTTP status and body for errors thrown before streaming starts", () => {
  it("maps a stored-history validation failure to 422 with a short message instead of the multi-megabyte value dump", () => {
    const err = new TypeValidationError({
      value: [{ id: "a1", role: "assistant", parts: [] }],
      cause: new Error('[{"path":[10,"parts"],"message":"Message must contain at least one part"}]'),
    });
    const out = describeRequestError(err);
    expect(out.status).toBe(422);
    expect(out.body).toContain("Message must contain at least one part");
    expect(out.body.length).toBeLessThan(600);
  });

  it("keeps the 413 contract for context compaction", () => {
    const err = new ContextCompactionRequiredError(300000, deriveContextBudget(128000));
    const out = describeRequestError(err);
    expect(out.status).toBe(413);
    expect(out.body).toBe(err.message);
  });

  it("maps anything else to 500 with the error message", () => {
    expect(describeRequestError(new Error("boom"))).toEqual({ status: 500, body: "boom" });
    expect(describeRequestError("weird")).toEqual({ status: 500, body: "weird" });
  });
});
