import { needsQueryEmbedding, boostsWithQueryEntities } from "./query-embedding-policy";

describe("needsQueryEmbedding — which search methods pay for a query embedding", () => {
  it("skips the embedding for the full-text-only method: it never touches the vector, yet the round trip cost 1-5 s per call", () => {
    expect(needsQueryEmbedding("tsvector")).toBe(false);
  });
  it("keeps it for the semantic and hybrid methods", () => {
    expect(needsQueryEmbedding("cosineDistance")).toBe(true);
    expect(needsQueryEmbedding("hybridSearch")).toBe(true);
  });
});

describe("boostsWithQueryEntities — which search methods run query entity extraction", () => {
  it("skips the extraction LLM call for the full-text-only method: the memory keyword recall paid 2-3.5 s per turn for it", () => {
    expect(boostsWithQueryEntities("tsvector")).toBe(false);
  });
  it("keeps the entity boost for semantic and hybrid searches", () => {
    expect(boostsWithQueryEntities("hybridSearch")).toBe(true);
    expect(boostsWithQueryEntities("cosineDistance")).toBe(true);
  });
});
