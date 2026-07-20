import { credentialRequestResult } from "./short-circuit";

describe("credentialRequestResult", () => {
  it("wraps a credentialRequest under the expected key", () => {
    const req = { provider: "p", fields: [], submitUrl: "u", nonce: "n" };
    const r = credentialRequestResult(req);
    expect(r).toEqual({ credentialRequest: req, result: null });
  });
});
