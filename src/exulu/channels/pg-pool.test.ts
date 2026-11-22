const instances: Array<{ options: any; on: jest.Mock }> = [];
jest.mock("pg", () => ({
  Pool: jest.fn().mockImplementation((options: any) => {
    const instance = { options, on: jest.fn() };
    instances.push(instance);
    return instance;
  }),
}));

import { getChannelPgPool } from "./pg-pool";

describe("getChannelPgPool", () => {
  it("creates one pool lazily, reuses it, and listens for errors", () => {
    expect(instances).toHaveLength(0);
    const a = getChannelPgPool();
    const b = getChannelPgPool();
    expect(a).toBe(b);
    expect(instances).toHaveLength(1);
    expect(instances[0].on).toHaveBeenCalledWith("error", expect.any(Function));
  });

  it("an idle connection error is logged, not thrown", () => {
    const error = jest.spyOn(console, "error").mockImplementation(() => {});
    const listener = instances[0].on.mock.calls[0][1];
    expect(() =>
      listener(Object.assign(new Error("password authentication failed for user newton@10.0.0.4"), { code: "28P01" })),
    ).not.toThrow();
    expect(error).toHaveBeenCalled();
    expect(JSON.stringify(error.mock.calls)).toContain("28P01");
    expect(JSON.stringify(error.mock.calls)).not.toContain("newton");
    error.mockRestore();
  });
});
