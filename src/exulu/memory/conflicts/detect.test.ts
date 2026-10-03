import { groupDuplicates, groupKey, pairKey, sortIds, splitBands, type Pair } from "./detect";

const p = (a: string, b: string, similarity: number): Pair => ({ a, b, similarity });

describe("keys", () => {
  it("sort ids so the same pair or group always maps to one key", () => {
    expect(sortIds(["b", "a", "c"])).toEqual(["a", "b", "c"]);
    expect(pairKey("mem", "b", "a")).toBe("mem:a,b");
    expect(groupKey("mem", "duplicate", ["c", "a"])).toBe("mem:duplicate:a,c");
  });
});

describe("splitBands", () => {
  it("splits at the duplicate threshold and drops anything below the candidate floor", () => {
    const { duplicatePairs, candidatePairs } = splitBands([p("a", "b", 0.95), p("a", "c", 0.88), p("c", "d", 0.75), p("d", "e", 0.69)]);
    expect(duplicatePairs.map((x) => x.b)).toEqual(["b", "c"]);
    expect(candidatePairs.map((x) => x.b)).toEqual(["d"]);
  });
});

describe("groupDuplicates", () => {
  it("joins pairs into connected components with the max similarity", () => {
    const { groups, leftover } = groupDuplicates([p("a", "b", 0.9), p("b", "c", 0.92), p("x", "y", 0.89)], 6);
    expect(groups).toEqual([{ members: ["a", "b", "c"], similarity: 0.92 }, { members: ["x", "y"], similarity: 0.89 }]);
    expect(leftover).toEqual([]);
  });
  it("caps a component to the cap most similar members and keeps the rest as leftover pairs", () => {
    const chain = [p("a", "b", 0.99), p("b", "c", 0.98), p("c", "d", 0.97), p("d", "e", 0.96), p("e", "f", 0.95), p("f", "g", 0.94), p("g", "h", 0.93), p("h", "i", 0.92)];
    const { groups, leftover } = groupDuplicates(chain, 6);
    expect(groups).toHaveLength(1);
    expect(groups[0].members).toEqual(["a", "b", "c", "d", "e", "f"]);
    expect(leftover.map((x) => `${x.a}-${x.b}`)).toEqual(["f-g", "g-h", "h-i"]);
  });
  it("is stable: the same input in another order yields the same groups", () => {
    const one = groupDuplicates([p("a", "b", 0.9), p("b", "c", 0.92)], 6).groups;
    const two = groupDuplicates([p("c", "b", 0.92), p("b", "a", 0.9)], 6).groups;
    expect(one).toEqual(two);
  });
  it("is orientation-independent: identical similarity pairs tie-break by canonical orientation", () => {
    const one = groupDuplicates([p("a", "m", 0.9), p("a", "z", 0.9)], 2);
    const two = groupDuplicates([p("m", "a", 0.9), p("a", "z", 0.9)], 2);
    expect(one.groups).toEqual(two.groups);
    expect(one.leftover).toEqual(two.leftover);
  });
});
