import { resolveProjectScope, buildProjectKbProfileDefaults } from "./project-scope";

const baseScope = {
  id: "p1",
  name: "Elevator Modernization",
  items: ["docs/item-1", "docs/item-2", "tickets/item-9", "wiki"],
};

describe("resolveProjectScope", () => {
  it("returns undefined for no scope or empty items", () => {
    expect(resolveProjectScope({ scope: undefined, enabledContextIds: new Set(), availableContextIds: new Set() })).toBeUndefined();
    expect(resolveProjectScope({ scope: { ...baseScope, items: [] }, enabledContextIds: new Set(), availableContextIds: new Set(["docs"]) })).toBeUndefined();
  });

  it("enabled contexts get PINS (boost), never filters", () => {
    const r = resolveProjectScope({
      scope: baseScope,
      enabledContextIds: new Set(["docs", "tickets", "wiki"]),
      availableContextIds: new Set(["docs", "tickets", "wiki"]),
    })!;
    expect(r.pinsByContext.get("docs")).toEqual(new Set(["item-1", "item-2"]));
    expect(r.pinsByContext.get("tickets")).toEqual(new Set(["item-9"]));
    expect(r.scopedItemsByContext.size).toBe(0);
    expect(r.addedContextIds).toEqual([]);
    // bare-context "wiki" is already enabled in full → no pin entry either
    expect(r.pinsByContext.has("wiki")).toBe(false);
    expect(new Set(r.allProjectContextIds)).toEqual(new Set(["docs", "tickets", "wiki"]));
  });

  it("non-enabled contexts get added item-scoped; bare-context entry scopes to whole context (null)", () => {
    const r = resolveProjectScope({
      scope: baseScope,
      enabledContextIds: new Set(["docs"]),
      availableContextIds: new Set(["docs", "tickets", "wiki"]),
    })!;
    expect(r.pinsByContext.get("docs")).toEqual(new Set(["item-1", "item-2"]));
    expect(r.scopedItemsByContext.get("tickets")).toEqual(["item-9"]);
    expect(r.scopedItemsByContext.get("wiki")).toBeNull();
    expect(new Set(r.addedContextIds)).toEqual(new Set(["tickets", "wiki"]));
  });

  it("unknown contexts are dropped with a warning, not an error", () => {
    const r = resolveProjectScope({
      scope: { ...baseScope, items: ["ghost/item-1", "docs/item-1"] },
      enabledContextIds: new Set(["docs"]),
      availableContextIds: new Set(["docs"]),
    })!;
    expect(r.allProjectContextIds).toEqual(["docs"]);
    expect(r.pinsByContext.get("docs")).toEqual(new Set(["item-1"]));
  });

  it("returns undefined when every referenced context is unknown", () => {
    expect(
      resolveProjectScope({
        scope: { ...baseScope, items: ["ghost/x"] },
        enabledContextIds: new Set(),
        availableContextIds: new Set(["docs"]),
      }),
    ).toBeUndefined();
  });
});

describe("buildProjectKbProfileDefaults", () => {
  it("maps the transcriptions context to conversations kind", () => {
    expect(buildProjectKbProfileDefaults(["transcriptions/t1", "docs/d1"])).toEqual({
      transcriptions: { enabled: true, kind: "conversations", instructions: "", overrides: {} },
    });
  });

  it("returns {} when transcriptions is not referenced", () => {
    expect(buildProjectKbProfileDefaults(["docs/d1", "wiki"])).toEqual({});
  });
});
