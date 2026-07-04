// ee/agentic-retrieval/pipeline/search.test.ts
import { searchContexts } from "./search";

jest.mock("./multi-query", () => ({ multiQuerySearch: jest.fn(async () => []), singleSearch: jest.fn(async () => []) }));
jest.mock("./hyde", () => ({ generateHydePassage: jest.fn(async () => "HYDE PASSAGE") }));
jest.mock("./prefilter", () => ({ fuzzyPrefilter: jest.fn(async () => [{ id: "p1", name: "n", key: "k" }]) }));
import { multiQuerySearch, singleSearch } from "./multi-query";
import { generateHydePassage } from "./hyde";
import { fuzzyPrefilter } from "./prefilter";

const contextsById = new Map<string, any>([
  ["docs", { id: "docs", configuration: {} }],
  ["tickets", { id: "tickets", configuration: {} }],
]);
const base = {
  contextsById,
  kbProfiles: {
    docs: { enabled: true, kind: "documents", instructions: "", overrides: {} },
    tickets: { enabled: true, kind: "conversations", instructions: "", overrides: {} },
  } as any,
  question: "how to fix door error E42", keywords: ["door", "E42"], importantKeyword: "E42",
  user: {}, role: "r", model: {},
  preselectedItems: new Map(), identifierPinsByContext: new Map(), memoryPinnedItemIds: new Set<string>(),
  userPinnedItemIdsByContext: new Map(), rewrites: [{ find: "fix", replace: "repair" }],
  styleHint: "", maxQueries: 5, skipPrefilter: false,
};

beforeEach(() => {
  (multiQuerySearch as jest.Mock).mockClear();
  (singleSearch as jest.Mock).mockClear();
  (fuzzyPrefilter as jest.Mock).mockClear();
  (generateHydePassage as jest.Mock).mockClear();
});

describe("searchContexts", () => {
  it("documents kind uses multi-query with question + HyDE + rewrites", async () => {
    await searchContexts({ ...base, contextIds: ["docs"] });
    const call = (multiQuerySearch as jest.Mock).mock.calls[0][0];
    expect(call.queries[0]).toBe(base.question);
    expect(call.queries).toContain("HYDE PASSAGE");
    expect(call.queries).toContain("how to repair door error E42");
    expect(call.config.limit).toBe(100);
  });

  it("conversations kind prefilters by keywords then single-searches with joined keywords", async () => {
    await searchContexts({ ...base, contextIds: ["tickets"] });
    expect(fuzzyPrefilter).toHaveBeenCalled();
    const call = (singleSearch as jest.Mock).mock.calls[0][0];
    expect(call.query).toBe("door E42 E42");
    expect(call.pinnedItemIds).toEqual(["p1"]);
    expect(call.config.limit).toBe(20);
  });

  it("user pins REPLACE identifier+memory pins; memory pins UNION with identifier pins", async () => {
    await searchContexts({
      ...base, contextIds: ["docs"],
      identifierPinsByContext: new Map([["docs", new Set(["i1"])]]),
      memoryPinnedItemIds: new Set(["m1"]),
    });
    expect(new Set((multiQuerySearch as jest.Mock).mock.calls[0][0].pinnedItemIds)).toEqual(new Set(["i1", "m1"]));

    (multiQuerySearch as jest.Mock).mockClear();
    await searchContexts({
      ...base, contextIds: ["docs"],
      identifierPinsByContext: new Map([["docs", new Set(["i1"])]]),
      memoryPinnedItemIds: new Set(["m1"]),
      userPinnedItemIdsByContext: new Map([["docs", new Set(["u1"])]]),
    });
    expect((multiQuerySearch as jest.Mock).mock.calls[0][0].pinnedItemIds).toEqual(["u1"]);
  });

  it("preselected items win over everything and skip prefilters", async () => {
    await searchContexts({
      ...base, contextIds: ["docs"],
      preselectedItems: new Map([["docs", ["s1", "s2"]]]),
      identifierPinsByContext: new Map([["docs", new Set(["i1"])]]),
    });
    expect((multiQuerySearch as jest.Mock).mock.calls[0][0].pinnedItemIds).toEqual(["s1", "s2"]);
  });

  it("skipPrefilter (fallback pass) suppresses identifier/memory pins", async () => {
    await searchContexts({
      ...base, contextIds: ["docs"], skipPrefilter: true,
      identifierPinsByContext: new Map([["docs", new Set(["i1"])]]),
      memoryPinnedItemIds: new Set(["m1"]),
    });
    expect((multiQuerySearch as jest.Mock).mock.calls[0][0].pinnedItemIds).toEqual([]);
  });

  it("conversations keyword prefilter still runs in the fallback pass (reference parity)", async () => {
    await searchContexts({
      ...base, contextIds: ["tickets"], skipPrefilter: true,
    });
    expect(fuzzyPrefilter).toHaveBeenCalled();
    const call = (singleSearch as jest.Mock).mock.calls[0][0];
    expect(call.pinnedItemIds).toEqual(["p1"]);
  });

  it("records kind single-searches with the keyword-joined query", async () => {
    const contextsWithRecords = new Map<string, any>([
      ["docs", { id: "docs", configuration: {} }],
      ["tickets", { id: "tickets", configuration: {} }],
      ["db", { id: "db", configuration: {} }],
    ]);
    const kbProfilesWithRecords = {
      docs: { enabled: true, kind: "documents", instructions: "", overrides: {} },
      tickets: { enabled: true, kind: "conversations", instructions: "", overrides: {} },
      db: { enabled: true, kind: "records", instructions: "", overrides: {} },
    } as any;
    await searchContexts({
      ...base,
      contextIds: ["db"],
      contextsById: contextsWithRecords,
      kbProfiles: kbProfilesWithRecords,
    });
    expect(fuzzyPrefilter).not.toHaveBeenCalled();
    const call = (singleSearch as jest.Mock).mock.calls[0][0];
    expect(call.query).toBe("door E42 E42");
    expect(call.config.limit).toBe(20);
  });

  it("hyde suppressed when settings.hyde is false", async () => {
    const kbProfilesNoHyde = {
      docs: { enabled: true, kind: "documents", instructions: "", overrides: { hyde: false } },
      tickets: { enabled: true, kind: "conversations", instructions: "", overrides: {} },
    } as any;
    await searchContexts({
      ...base,
      contextIds: ["docs"],
      kbProfiles: kbProfilesNoHyde,
    });
    expect(generateHydePassage).not.toHaveBeenCalled();
    const call = (multiQuerySearch as jest.Mock).mock.calls[0][0];
    expect(call.queries).not.toContain("HYDE PASSAGE");
  });
});
