import { computeTopics, kmeans, lexemeCounts, pickLabel, topicCount } from "./topics";
import { TOPIC_MIN_LEXEME } from "./constants";

describe("topicCount", () => {
  it("follows the data between its bounds", () => {
    expect(topicCount(8)).toBe(3);       // floor
    expect(topicCount(200)).toBe(10);    // round(sqrt(100))
    expect(topicCount(100000)).toBe(12); // ceiling
  });
});

describe("kmeans", () => {
  const blob = (cx: number, cy: number, cz: number, n: number, spread: number) =>
    Array.from({ length: n }, (_, i) => [cx + (i % 3) * spread, cy + (i % 2) * spread, cz + (i % 5) * spread]);

  it("separates two well-separated blobs", () => {
    const points = [...blob(0, 0, 0, 20, 0.01), ...blob(10, 10, 10, 20, 0.01)];
    const { assignments, centroids } = kmeans(points, 2, 7);
    expect(centroids).toHaveLength(2);
    const first = new Set(assignments.slice(0, 20));
    const second = new Set(assignments.slice(20));
    expect(first.size).toBe(1);
    expect(second.size).toBe(1);
    expect([...first][0]).not.toBe([...second][0]);
  });

  it("is deterministic for one seed", () => {
    const points = [...blob(0, 0, 0, 30, 0.5), ...blob(4, 4, 4, 30, 0.5)];
    expect(kmeans(points, 3, 11).assignments).toEqual(kmeans(points, 3, 11).assignments);
  });

  it("returns all centroids finite and clusters only used sizes", () => {
    const points = Array.from({ length: 10 }, () => [1, 1, 1]);
    const { assignments, centroids } = kmeans(points, 4, 3);
    expect(centroids.every((c) => c.every(Number.isFinite))).toBe(true);
    // Ten identical points collapse to one cluster
    const sizes = new Map<number, number>();
    for (const a of assignments) sizes.set(a, (sizes.get(a) ?? 0) + 1);
    expect(sizes.size).toBe(1); // Only one cluster is used
    const clusterKey = [...sizes.keys()][0] ?? 0;
    expect(clusterKey).toBe(0); // The first cluster
    expect(sizes.get(clusterKey)).toBe(10); // All points in that cluster
  });

  it("coerces non-finite coordinates to finite centres", () => {
    const points = [[1, 1, 1], [2, 2, 2], [NaN, 5, 5]];
    const { centroids } = kmeans(points, 2, 7);
    expect(centroids.every((c) => c.every(Number.isFinite))).toBe(true);
  });
});

describe("pickLabel", () => {
  it("prefers a word frequent here and rare elsewhere over one frequent everywhere", () => {
    const inCluster = new Map([["steuerblock", 8], ["ventil", 6], ["anlage", 8]]);
    const corpus = new Map([["steuerblock", 9], ["ventil", 7], ["anlage", 400]]);
    const clusterSize = 22; // Production: number of chunks in the cluster
    expect(pickLabel(inCluster, corpus, 0, clusterSize)).toBe("Steuerblock & Ventil");
  });

  it("ignores words under the document-frequency and length floors", () => {
    const inCluster = new Map([["ab", 50], ["rare", 1], ["encoder", 4]]);
    const corpus = new Map([["ab", 50], ["rare", 1], ["encoder", 5]]);
    const clusterSize = 55; // Production: number of chunks in the cluster
    expect(pickLabel(inCluster, corpus, 0, clusterSize)).toBe("Encoder");
  });

  it("falls back to an ordinal when nothing qualifies", () => {
    const clusterSize = 9; // Production: number of chunks in the cluster
    expect(pickLabel(new Map([["x", 9]]), new Map([["x", 9]]), 3, clusterSize)).toBe("Topic 4");
  });

  it("skips a lexeme that is a prefix of or prefixed by an earlier one", () => {
    const inCluster = new Map([["motor", 5], ["moto", 4], ["ventil", 3]]);
    const corpus = new Map([["motor", 6], ["moto", 4], ["ventil", 4]]);
    const clusterSize = 12; // Production: number of chunks in the cluster
    // "motor" scores highest, "moto" is skipped as a prefix, "ventil" is second
    expect(pickLabel(inCluster, corpus, 0, clusterSize)).toBe("Motor & Ventil");
  });

  it("sorts by score regardless of insertion order", () => {
    // Regression: GROUP BY row order varies; sort must be deterministic
    // Same data as first test but with frequent-everywhere word first
    const inCluster = new Map([["anlage", 8], ["steuerblock", 8], ["ventil", 6]]);
    const corpus = new Map([["anlage", 400], ["steuerblock", 9], ["ventil", 7]]);
    const clusterSize = 22; // Production: number of chunks in the cluster
    expect(pickLabel(inCluster, corpus, 0, clusterSize)).toBe("Steuerblock & Ventil");
  });

  it("ignores prefix ties regardless of insertion order", () => {
    // Regression: shorter stem inserted first
    const inCluster = new Map([["moto", 4], ["motor", 5], ["ventil", 3]]);
    const corpus = new Map([["moto", 4], ["motor", 6], ["ventil", 4]]);
    const clusterSize = 12; // Production: number of chunks in the cluster
    expect(pickLabel(inCluster, corpus, 0, clusterSize)).toBe("Motor & Ventil");
  });
});

describe("lexemeCounts", () => {
  it("uses array binds and aggregates per cluster", async () => {
    const log: any[] = [];
    const rows = [
      { cluster: 0, lexeme: "encoder", df: 3 },
      { cluster: 1, lexeme: "ventil", df: 2 },
    ];
    const trx: any = {
      raw: async (sql: string, bindings: any[]) => {
        log.push(["raw", sql, bindings]);
        return { rows };
      },
    };
    const out = await lexemeCounts({
      db: trx, chunksTable: "mem_chunks",
      ids: ["a", "b", "c"], assignments: [0, 0, 1],
    });
    expect(out.get(0)?.get("encoder")).toBe(3);
    expect(out.get(1)?.get("ventil")).toBe(2);
    // Exactly one raw call with ids, assignments, table name, and minimum lexeme length
    expect(log).toHaveLength(1);
    const [cmd, sql, bindings] = log[0];
    expect(cmd).toBe("raw");
    expect(sql).toContain("unnest(?::uuid[], ?::int[])");
    expect(sql).toContain("unnest(ch.fts)");
    expect(sql).toContain("WHERE length(l.lexeme) >= ?");
    expect(bindings).toHaveLength(4);
    expect(bindings[0]).toEqual(["a", "b", "c"]); // ids array
    expect(bindings[1]).toEqual([0, 0, 1]); // assignments array
    expect(bindings[2]).toBe("mem_chunks"); // table name
    expect(bindings[3]).toBe(TOPIC_MIN_LEXEME);
  });
});

describe("computeTopics", () => {
  const mockDb = () => {
    const dbFn: any = (table: string) => ({
      where: (filter: any) => ({
        delete: async () => undefined,
      }),
      insert: async (values: any[]) => undefined,
    });
    dbFn.raw = async (sql: string, bindings?: any[]) => ({ rows: [] });
    return dbFn;
  };

  it("deletes old topics for the context before inserting new ones", async () => {
    const operations: string[] = [];
    const deletedContexts: any[] = [];
    const db: any = (table: string) => ({
      where: (filter: any) => {
        deletedContexts.push(filter);
        return {
          delete: async () => { operations.push("delete"); },
        };
      },
      insert: async (values: any[]) => { operations.push("insert"); },
    });
    db.raw = async (sql: string, bindings?: any[]) => ({ rows: [] });
    await computeTopics({
      db, contextId: "ctx-1", ids: ["a", "b"], coordinates: [[0, 0, 0], [1, 1, 1]], seed: 1, fittedAt: new Date(),
    });
    expect(operations).toEqual(["delete", "insert"]);
    expect(deletedContexts[0]?.context).toBe("ctx-1");
  });

  it("throws when ids and coordinates lengths differ", async () => {
    const db = mockDb();
    await expect(
      computeTopics({
        db, contextId: "ctx-1", ids: ["a", "b"], coordinates: [[0, 0, 0]], seed: 1, fittedAt: new Date(),
      }),
    ).rejects.toThrow();
  });

  it("filters out empty clusters and only emits non-empty rows", async () => {
    const inserted: any[] = [];
    const db: any = (table: string) => ({
      where: () => ({ delete: async () => undefined }),
      insert: async (values: any[]) => { inserted.push(...values); },
    });
    // topicCount(10) = 3, so k-means will try 3 clusters
    // Ten identical points will all be assigned to cluster 0, leaving clusters 1 and 2 empty
    db.raw = async (sql: string, bindings?: any[]) => ({ rows: [] });
    await computeTopics({
      db, contextId: "ctx-1",
      ids: Array.from({ length: 10 }, (_, i) => `id-${i}`),
      coordinates: Array.from({ length: 10 }, () => [0, 0, 0]),
      seed: 1, fittedAt: new Date(),
    });
    // Should emit only 1 row (the non-empty cluster), not 3
    expect(inserted).toHaveLength(1);
    expect(inserted[0]?.count).toBe(10);
  });

  it("filters out rows with non-finite coordinates when clustering returns them", async () => {
    const inserted: any[] = [];
    const db: any = (table: string) => ({
      where: () => ({ delete: async () => undefined }),
      insert: async (values: any[]) => { inserted.push(...values); },
    });
    db.raw = async (sql: string, bindings?: any[]) => ({ rows: [] });

    // Inject a clustering function that returns a deliberately non-finite centroid
    const malformedCluster = (points: number[][], k: number, seed: number) => ({
      assignments: [0, 0],
      centroids: [[NaN, Infinity, 5], [1, 1, 1]], // First centroid is bad
    });

    await computeTopics({
      db, contextId: "ctx-1",
      ids: ["a", "b"],
      coordinates: [[0, 0, 0], [1, 1, 1]],
      seed: 1, fittedAt: new Date(),
      clusteringFn: malformedCluster,
    });
    // Row with non-finite coordinates should be filtered out
    // Only the second (all-finite) centroid's row should be inserted, or none if that one is also empty
    expect(inserted.every((r: any) => [r.x, r.y, r.z].every(Number.isFinite))).toBe(true);
  });
});
