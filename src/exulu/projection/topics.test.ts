import { computeTopics, kmeans, lexemeCounts, pickLabel, topicCount } from "./topics";

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
    const sizes = new Map<number, number>();
    for (const a of assignments) sizes.set(a, (sizes.get(a) ?? 0) + 1);
    expect(sizes.size).toBeLessThanOrEqual(4);
    expect([...sizes.values()].every((s) => s > 0)).toBe(true);
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
    const clusterSize = 22; // sum of inCluster DFs
    expect(pickLabel(inCluster, corpus, 0, clusterSize)).toBe("Steuerblock & Ventil");
  });

  it("ignores words under the document-frequency and length floors", () => {
    const inCluster = new Map([["ab", 50], ["rare", 1], ["encoder", 4]]);
    const corpus = new Map([["ab", 50], ["rare", 1], ["encoder", 5]]);
    const clusterSize = 55; // sum of inCluster DFs
    expect(pickLabel(inCluster, corpus, 0, clusterSize)).toBe("Encoder");
  });

  it("falls back to an ordinal when nothing qualifies", () => {
    const clusterSize = 9; // sum of inCluster DFs
    expect(pickLabel(new Map([["x", 9]]), new Map([["x", 9]]), 3, clusterSize)).toBe("Topic 4");
  });

  it("skips a lexeme that is a prefix of or prefixed by an earlier one", () => {
    const inCluster = new Map([["motor", 5], ["moto", 4], ["ventil", 3]]);
    const corpus = new Map([["motor", 6], ["moto", 4], ["ventil", 4]]);
    const clusterSize = 12; // sum of inCluster DFs
    // "motor" scores highest, "moto" is skipped as a prefix, "ventil" is second
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
    // Exactly one raw call with ids and assignments as array binds
    expect(log).toHaveLength(1);
    const [cmd, sql, bindings] = log[0];
    expect(cmd).toBe("raw");
    expect(sql).toContain("unnest(?::uuid[], ?::int[])");
    expect(sql).toContain("unnest(ch.fts)");
    expect(bindings).toHaveLength(3);
    expect(bindings[0]).toEqual(["a", "b", "c"]); // ids array
    expect(bindings[1]).toEqual([0, 0, 1]); // assignments array
    expect(bindings[2]).toBe("mem_chunks"); // table name
  });
});

describe("computeTopics", () => {
  const mockDb = (rows: any[] = []) => {
    const dbFn: any = (table: string) => ({
      where: (filter: any) => ({
        delete: async () => undefined,
      }),
      insert: async (values: any[]) => undefined,
    });
    dbFn.raw = async (sql: string, bindings?: any[]) => ({ rows });
    return dbFn;
  };

  it("deletes old topics for the context", async () => {
    const deleted: any[] = [];
    const db: any = (table: string) => ({
      where: (filter: any) => { deleted.push(filter); return { delete: async () => undefined }; },
      insert: async (values: any[]) => undefined,
    });
    db.raw = async (sql: string, bindings?: any[]) => ({ rows: [] });
    await computeTopics({
      db, contextId: "ctx-1", ids: [], coordinates: [], seed: 1, fittedAt: new Date(),
    });
    expect(deleted).toHaveLength(1);
    expect(deleted[0]?.context).toBe("ctx-1");
  });

  it("throws when ids and coordinates lengths differ", async () => {
    const db = mockDb();
    await expect(
      computeTopics({
        db, contextId: "ctx-1", ids: ["a", "b"], coordinates: [[0, 0, 0]], seed: 1, fittedAt: new Date(),
      }),
    ).rejects.toThrow();
  });

  it("filters out empty clusters before insertion", async () => {
    const inserted: any[] = [];
    const db: any = (table: string) => ({
      where: () => ({ delete: async () => undefined }),
      insert: async (values: any[]) => { inserted.push(...values); },
    });
    db.raw = async (sql: string, bindings?: any[]) => ({ rows: [] });
    await computeTopics({
      db, contextId: "ctx-1", ids: ["a"], coordinates: [[0, 0, 0]], seed: 1, fittedAt: new Date(),
    });
    // One point should produce one cluster; all inserts should have count > 0
    expect(inserted.every((r: any) => r.count > 0)).toBe(true);
  });
});
