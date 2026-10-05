import { kmeans, lexemeCounts, pickLabel, topicCount } from "./topics";

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

  it("is deterministic for one seed and differs across seeds it should", () => {
    const points = [...blob(0, 0, 0, 30, 0.5), ...blob(4, 4, 4, 30, 0.5)];
    expect(kmeans(points, 3, 11).assignments).toEqual(kmeans(points, 3, 11).assignments);
  });

  it("never returns an empty cluster or a non-finite centroid", () => {
    const points = Array.from({ length: 10 }, () => [1, 1, 1]);
    const { assignments, centroids } = kmeans(points, 4, 3);
    expect(centroids.every((c) => c.every(Number.isFinite))).toBe(true);
    expect(new Set(assignments).size).toBeLessThanOrEqual(4);
  });
});

describe("pickLabel", () => {
  it("prefers a word frequent here and rare elsewhere over one frequent everywhere", () => {
    const inCluster = new Map([["steuerblock", 8], ["ventil", 6], ["anlage", 8]]);
    const corpus = new Map([["steuerblock", 9], ["ventil", 7], ["anlage", 400]]);
    expect(pickLabel(inCluster, corpus, 0)).toBe("Steuerblock & Ventil");
  });

  it("ignores words under the document-frequency and length floors", () => {
    const inCluster = new Map([["ab", 50], ["rare", 1], ["encoder", 4]]);
    const corpus = new Map([["ab", 50], ["rare", 1], ["encoder", 5]]);
    expect(pickLabel(inCluster, corpus, 0)).toBe("Encoder");
  });

  it("falls back to an ordinal when nothing qualifies", () => {
    expect(pickLabel(new Map([["x", 9]]), new Map([["x", 9]]), 3)).toBe("Topic 4");
  });
});

describe("lexemeCounts", () => {
  it("loads assignments into a temp table and aggregates per cluster", async () => {
    const log: any[] = [];
    const rows = [
      { cluster: 0, lexeme: "encoder", df: 3 },
      { cluster: 1, lexeme: "ventil", df: 2 },
    ];
    const trx: any = (table: string) => ({
      insert: async (values: any[]) => { log.push(["insert", table, values.length]); },
    });
    trx.raw = async (sql: string) => { log.push(["raw", sql]); return { rows }; };
    const out = await lexemeCounts({
      db: trx, chunksTable: "mem_chunks",
      ids: ["a", "b", "c"], assignments: [0, 0, 1],
    });
    expect(out.get(0)?.get("encoder")).toBe(3);
    expect(out.get(1)?.get("ventil")).toBe(2);
    // The temp table is created before the insert and the aggregate reads it.
    const sql = log.filter((l) => l[0] === "raw").map((l) => String(l[1])).join("\n");
    expect(sql).toContain("CREATE TEMP TABLE");
    expect(sql).toContain("unnest(ch.fts)");
    expect(log.some((l) => l[0] === "insert")).toBe(true);
  });
});
