import { creatorId } from "./creator-id";

describe("creatorId", () => {
  it("accepts integers and numeric strings (item tables store created_by as text)", () => {
    expect(creatorId(4)).toBe(4);
    expect(creatorId("4")).toBe(4);
    expect(creatorId(" 12 ")).toBe(12);
  });
  it("rejects everything that is not a positive integer id", () => {
    expect(creatorId(null)).toBeNull();
    expect(creatorId(undefined)).toBeNull();
    expect(creatorId("")).toBeNull();
    expect(creatorId("abc")).toBeNull();
    expect(creatorId("4.5")).toBeNull();
    expect(creatorId(NaN)).toBeNull();
    expect(creatorId(0)).toBeNull();
    expect(creatorId(-3)).toBeNull();
    expect(creatorId({})).toBeNull();
  });
});
