import type { VectorSearchChunkResult } from "@SRC/graphql/resolvers/vector-search";

export class ExuluReranker {
  public id: string;
  public name: string;
  public description: string;
  public execute: (params: {
    query: string;
    chunks: VectorSearchChunkResult[];
  }) => Promise<VectorSearchChunkResult[]>;

  constructor({
    id,
    name,
    description,
    execute,
  }: {
    id: string;
    name: string;
    description: string;
    execute: (params: {
      query: string;
      chunks: VectorSearchChunkResult[];
    }) => Promise<VectorSearchChunkResult[]>;
  }) {
    this.id = id;
    this.name = name;
    this.description = description;
    this.execute = execute;
  }

  public async run(
    query: string,
    chunks: VectorSearchChunkResult[],
  ): Promise<VectorSearchChunkResult[]> {
    return await this.execute({ query, chunks });
  }
}
