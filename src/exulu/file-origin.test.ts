import { ORIGIN_METADATA_KEY, createOriginResolver, originFromMetadata } from "./file-origin";

describe("originFromMetadata", () => {
  test("agent when the marker says so", () => {
    expect(originFromMetadata({ [ORIGIN_METADATA_KEY]: "agent" })).toBe("agent");
  });
  test("user for missing, empty or unknown metadata", () => {
    expect(originFromMetadata(undefined)).toBe("user");
    expect(originFromMetadata({})).toBe("user");
    expect(originFromMetadata({ [ORIGIN_METADATA_KEY]: "robot" })).toBe("user");
  });
});

describe("createOriginResolver", () => {
  test("heads once per key+lastModified, again when lastModified changes", async () => {
    const head = jest.fn().mockResolvedValue({ [ORIGIN_METADATA_KEY]: "agent" });
    const resolve = createOriginResolver(head);
    const t1 = "2026-01-01T00:00:00.000Z";
    expect(await resolve({ key: "k", lastModified: t1 })).toBe("agent");
    expect(await resolve({ key: "k", lastModified: new Date(t1) })).toBe("agent");
    expect(head).toHaveBeenCalledTimes(1);
    await resolve({ key: "k", lastModified: "2026-01-02T00:00:00.000Z" });
    expect(head).toHaveBeenCalledTimes(2);
  });
  test("a failing head resolves to user", async () => {
    const resolve = createOriginResolver(jest.fn().mockRejectedValue(new Error("boom")));
    expect(await resolve({ key: "k", lastModified: "x" })).toBe("user");
  });
});
