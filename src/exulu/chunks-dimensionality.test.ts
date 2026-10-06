import { parseVectorDimensionality } from "./chunks-dimensionality";

describe("parseVectorDimensionality", () => {
  it("reads the dimension out of a pgvector column type", () => {
    expect(parseVectorDimensionality("vector(1536)")).toBe(1536);
  });

  it("handles whitespace", () => {
    expect(parseVectorDimensionality("vector( 3072 )")).toBe(3072);
  });

  it("returns null for a non-vector type", () => {
    expect(parseVectorDimensionality("text")).toBeNull();
  });

  it("returns null for an unsized vector", () => {
    expect(parseVectorDimensionality("vector")).toBeNull();
  });

  it("returns null for null/empty input (column or table absent)", () => {
    expect(parseVectorDimensionality(null)).toBeNull();
    expect(parseVectorDimensionality("")).toBeNull();
  });
});
