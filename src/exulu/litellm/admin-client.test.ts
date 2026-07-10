const OK = (body: unknown) =>
  Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body), text: () => Promise.resolve("") } as Response);

describe("admin-client", () => {
  const origFetch = global.fetch;
  beforeAll(() => { process.env.LITELLM_MASTER_KEY = "test-key"; });
  afterEach(() => { global.fetch = origFetch; jest.resetModules(); });

  it("tagInfo surfaces budget_id from litellm_budget_table", async () => {
    global.fetch = jest.fn(() =>
      OK({ "team_id_5": { litellm_budget_table: { budget_id: "bud_123", max_budget: 100, budget_duration: "30d", budget_reset_at: "2026-08-01T00:00:00Z" } } }),
    ) as unknown as typeof fetch;
    const { tagInfo } = await import("./admin-client");
    const info = await tagInfo(["team_id_5"]);
    expect(info["team_id_5"]?.budget_id).toBe("bud_123");
  });

  it("budgetUpdate POSTs budget_id + patch to /budget/update", async () => {
    const spy = jest.fn(() => OK({})) as unknown as typeof fetch;
    global.fetch = spy;
    const { budgetUpdate } = await import("./admin-client");
    await budgetUpdate("bud_123", { budget_reset_at: "2026-08-01T00:00:00.000Z" });
    const [url, init] = (spy as unknown as jest.Mock).mock.calls[0];
    expect(String(url)).toContain("/budget/update");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      budget_id: "bud_123",
      budget_reset_at: "2026-08-01T00:00:00.000Z",
    });
  });
});
