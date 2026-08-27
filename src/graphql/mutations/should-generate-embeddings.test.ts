import { shouldGenerateEmbeddings } from "./should-generate-embeddings";

describe("shouldGenerateEmbeddings — override wins over config", () => {
  it("embeds when forced, even on a manual context", () => {
    expect(
      shouldGenerateEmbeddings({
        calculateVectors: "manual",
        operation: "update",
        override: true,
      }),
    ).toBe(true);
  });

  it("suppresses when told to, even when the config says to embed", () => {
    expect(
      shouldGenerateEmbeddings({
        calculateVectors: "always",
        operation: "update",
        override: false,
      }),
    ).toBe(false);
  });

  it("suppresses on create too, so a caller can opt out of an onInsert context", () => {
    expect(
      shouldGenerateEmbeddings({
        calculateVectors: "onInsert",
        operation: "create",
        override: false,
      }),
    ).toBe(false);
  });
});

describe("shouldGenerateEmbeddings — config drives it when no override", () => {
  it("embeds on create for onInsert", () => {
    expect(
      shouldGenerateEmbeddings({
        calculateVectors: "onInsert",
        operation: "create",
        override: undefined,
      }),
    ).toBe(true);
  });

  it("does NOT embed on update for onInsert", () => {
    expect(
      shouldGenerateEmbeddings({
        calculateVectors: "onInsert",
        operation: "update",
        override: undefined,
      }),
    ).toBe(false);
  });

  it("embeds on update for onUpdate", () => {
    expect(
      shouldGenerateEmbeddings({
        calculateVectors: "onUpdate",
        operation: "update",
        override: undefined,
      }),
    ).toBe(true);
  });

  it("does NOT embed on create for onUpdate", () => {
    expect(
      shouldGenerateEmbeddings({
        calculateVectors: "onUpdate",
        operation: "create",
        override: undefined,
      }),
    ).toBe(false);
  });

  it("embeds for always, on both operations", () => {
    expect(
      shouldGenerateEmbeddings({
        calculateVectors: "always",
        operation: "create",
        override: undefined,
      }),
    ).toBe(true);
    expect(
      shouldGenerateEmbeddings({
        calculateVectors: "always",
        operation: "update",
        override: undefined,
      }),
    ).toBe(true);
  });

  it("never embeds for manual, on either operation", () => {
    expect(
      shouldGenerateEmbeddings({
        calculateVectors: "manual",
        operation: "create",
        override: undefined,
      }),
    ).toBe(false);
    expect(
      shouldGenerateEmbeddings({
        calculateVectors: "manual",
        operation: "update",
        override: undefined,
      }),
    ).toBe(false);
  });

  it("treats an absent calculateVectors as manual", () => {
    expect(
      shouldGenerateEmbeddings({
        calculateVectors: undefined,
        operation: "create",
        override: undefined,
      }),
    ).toBe(false);
  });
});
