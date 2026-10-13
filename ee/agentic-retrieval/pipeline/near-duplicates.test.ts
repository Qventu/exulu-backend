import { makeNearDuplicateFinder, DUPLICATE_SIMILARITY_THRESHOLD } from "./near-duplicates";

const chunk = (id: string, ctx: string) => ({ chunk_id: id, context: { id: ctx } }) as any;

describe("makeNearDuplicateFinder", () => {
  it("queries one table per context and returns the union of pairs", async () => {
    const seen: string[] = [];
    const bindingsSeen: unknown[] = [];
    const db = { raw: jest.fn(async (sql: string, bindings: unknown) => { seen.push(sql); bindingsSeen.push(bindings);
      return { rows: sql.includes("tech_doc") ? [{ a: "c1", b: "c2" }] : [{ a: "z1", b: "z2" }] }; }) } as any;
    const find = makeNearDuplicateFinder({ contextIds: ["tech_doc_context", "zendesk_context"], db });
    const pairs = await find([chunk("c1", "tech_doc_context"), chunk("c2", "tech_doc_context"),
                              chunk("z1", "zendesk_context"), chunk("z2", "zendesk_context")]);
    expect(pairs).toEqual(expect.arrayContaining([["c1", "c2"], ["z1", "z2"]]));
    expect(seen).toHaveLength(2);
    expect(seen[0]).toContain("tech_doc_context_chunks");
    // Both id arrays and the threshold must actually be bound — not just present in the SQL text.
    expect(bindingsSeen[0]).toEqual([["c1", "c2"], ["c1", "c2"], DUPLICATE_SIMILARITY_THRESHOLD]);
    expect(bindingsSeen[1]).toEqual([["z1", "z2"], ["z1", "z2"], DUPLICATE_SIMILARITY_THRESHOLD]);
  });

  it("skips contexts that are not known knowledge bases, e.g. memory", async () => {
    const db = { raw: jest.fn(async () => ({ rows: [] })) } as any;
    const find = makeNearDuplicateFinder({ contextIds: ["tech_doc_context"], db });
    await find([chunk("m1", "memory"), chunk("m2", "memory")]);
    expect(db.raw).not.toHaveBeenCalled();
  });

  it("returns the pairs it did get when one context query throws", async () => {
    const db = { raw: jest.fn(async (sql: string) => {
      if (sql.includes("zendesk")) throw new Error("boom");
      return { rows: [{ a: "c1", b: "c2" }] };
    }) } as any;
    const find = makeNearDuplicateFinder({ contextIds: ["tech_doc_context", "zendesk_context"], db });
    const pairs = await find([chunk("c1", "tech_doc_context"), chunk("c2", "tech_doc_context"),
                              chunk("z1", "zendesk_context"), chunk("z2", "zendesk_context")]);
    expect(pairs).toEqual([["c1", "c2"]]);
  });

  it("skips a context with fewer than two candidates", async () => {
    const db = { raw: jest.fn(async () => ({ rows: [] })) } as any;
    const find = makeNearDuplicateFinder({ contextIds: ["tech_doc_context"], db });
    await find([chunk("c1", "tech_doc_context")]);
    expect(db.raw).not.toHaveBeenCalled();
  });

  it("uses 0.97 as the threshold", () => {
    expect(DUPLICATE_SIMILARITY_THRESHOLD).toBe(0.97);
  });
});
