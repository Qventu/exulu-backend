import { listFilesWithOrigin } from "./project-file-handlers";

describe("listFilesWithOrigin — bounded concurrency", () => {
  it("never runs more than 10 origin lookups (HEADs) at once, and lists every file", async () => {
    let inFlight = 0;
    let peak = 0;
    const objects = Array.from({ length: 35 }, (_, i) => ({
      key: `projects/p/files/f${i}.pdf`,
      size: 1,
      lastModified: new Date(Date.UTC(2026, 10, 1, 0, 0, i)),
    }));
    const files = await listFilesWithOrigin({
      objects,
      presign: async (key) => `https://s3/${key}`,
      resolveOrigin: async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
        return "user";
      },
      inferContentType: () => "application/pdf",
    });
    expect(files).toHaveLength(35);
    expect(peak).toBeLessThanOrEqual(10);
    expect(peak).toBeGreaterThan(1);
    // Still most-recent first.
    expect(files[0].name).toBe("f34.pdf");
  });
});
