import { extractClientInfo } from "./client-info";

const req = (over: Record<string, unknown>) => over as any;

describe("extractClientInfo", () => {
  it("uses the leftmost x-forwarded-for hop for ip and keeps the full chain", () => {
    const c = extractClientInfo(
      req({
        headers: { "x-forwarded-for": "203.0.113.7, 10.0.0.2", "user-agent": "UA", referer: "http://x/y", origin: "http://x" },
        ip: "10.0.0.9",
      }),
    );
    expect(c).toEqual({
      ip: "203.0.113.7",
      forwardedFor: "203.0.113.7, 10.0.0.2",
      userAgent: "UA",
      referer: "http://x/y",
      origin: "http://x",
    });
  });
  it("falls back to req.ip then socket.remoteAddress when no x-forwarded-for", () => {
    expect(extractClientInfo(req({ headers: {}, ip: "198.51.100.4" }))).toEqual({ ip: "198.51.100.4" });
    expect(
      extractClientInfo(req({ headers: {}, socket: { remoteAddress: "198.51.100.9" } })),
    ).toEqual({ ip: "198.51.100.9" });
  });
  it("normalizes array-valued headers to the first element", () => {
    expect(
      extractClientInfo(req({ headers: { "x-forwarded-for": ["203.0.113.7"], "user-agent": ["UA1", "UA2"] } })),
    ).toEqual({ ip: "203.0.113.7", forwardedFor: "203.0.113.7", userAgent: "UA1" });
  });
  it("omits absent fields", () => {
    expect(extractClientInfo(req({ headers: { "user-agent": "UA" }, ip: "1.2.3.4" }))).toEqual({
      ip: "1.2.3.4",
      userAgent: "UA",
    });
  });
  it("returns undefined for null/undefined req or when nothing is extractable", () => {
    expect(extractClientInfo(undefined)).toBeUndefined();
    expect(extractClientInfo(null)).toBeUndefined();
    expect(extractClientInfo(req({ headers: {} }))).toBeUndefined();
  });
});
