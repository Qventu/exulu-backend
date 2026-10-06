import { recalledMemoriesMetadata } from "./recalled-metadata";

const memory = { id: "m1", contextId: "mem", title: "T", information: "F", rights_mode: "public", createdBy: null, createdAt: "", updatedAt: "", source: "prefetch" } as const;
const recall = { list: () => [memory] } as any;

describe("recalledMemoriesMetadata", () => {
  it("returns the list for signed-in users", () => {
    expect(recalledMemoriesMetadata({ recall, agent: { id: "a" } as any, isGuest: false })).toEqual({ recalledMemories: [memory] });
  });
  it("omits the list for guests unless guests.showRecalled is on", () => {
    expect(recalledMemoriesMetadata({ recall, agent: { id: "a" } as any, isGuest: true })).toEqual({});
    expect(recalledMemoriesMetadata({ recall, agent: { id: "a", memory_config: { guests: { showRecalled: true } } } as any, isGuest: true })).toEqual({ recalledMemories: [memory] });
  });
  it("returns {} when nothing was recalled or there is no collector", () => {
    expect(recalledMemoriesMetadata({ recall: { list: () => [] } as any, agent: { id: "a" } as any, isGuest: false })).toEqual({});
    expect(recalledMemoriesMetadata({ recall: undefined, agent: { id: "a" } as any, isGuest: false })).toEqual({});
  });
});
