import { requestValidators } from "./requests";

// authenticate must be total: anonymous requests (no Authorization /
// x-api-key header) are legitimate for public and guest-enabled endpoints,
// and the validator's contract is to RETURN an error-shaped result the
// caller can act on — never to throw. getToken throws on a missing token;
// this suite pins the catch-and-continue behavior in authenticate.
// postgresClient is mocked: the no-credentials path never touches the db.
jest.mock("../postgres/client.ts", () => ({
  postgresClient: async () => ({ db: null }),
}));

describe("requestValidators.authenticate — anonymous requests", () => {
  test("no auth headers → returns 401-shaped result, does not throw", async () => {
    const result = await requestValidators.authenticate({ headers: {} } as any);
    expect(result.error).toBe(true);
    expect(result.code).toBe(401);
    expect(result.user).toBeUndefined();
  });

  test("malformed Authorization header → returns error result, does not throw", async () => {
    const result = await requestValidators.authenticate({
      headers: { authorization: "garbage-no-bearer-prefix" },
    } as any);
    expect(result.error).toBe(true);
    expect(result.user).toBeUndefined();
  });
});
