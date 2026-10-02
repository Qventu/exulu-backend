import { resolveSessionFileOwner, sessionFilePrefix } from "./session-files";

describe("session files are namespaced by the session OWNER, not by whoever happens to be talking", () => {
  it("builds the owner prefix with and without a general S3 prefix", () => {
    expect(sessionFilePrefix(11, "s1", "exulu")).toBe("exulu/user_11/sessions/s1/");
    expect(sessionFilePrefix(11, "s1", "exulu/")).toBe("exulu/user_11/sessions/s1/");
    expect(sessionFilePrefix("11", "s1", undefined)).toBe("user_11/sessions/s1/");
  });

  it("uses the session's user as owner and falls back to the caller for legacy rows", () => {
    expect(resolveSessionFileOwner({ user: 11 }, 14)).toBe(11);
    expect(resolveSessionFileOwner({ user: null }, 14)).toBe(14);
    expect(resolveSessionFileOwner(undefined, 14)).toBe(14);
    expect(resolveSessionFileOwner({ user: 0 }, 14)).toBe(0);
  });
});
