jest.mock("@SRC/postgres/client", () => ({ postgresClient: jest.fn() }));
jest.mock("./activity-client", () => ({ getTagSpendByWindow: jest.fn() }));
jest.mock("./admin-client", () => ({
  tagInfo: jest.fn(),
  tagNew: jest.fn(),
  tagUpdate: jest.fn(),
  budgetUpdate: jest.fn(),
  listTagBudgets: jest.fn(),
}));

import { tagInfo, tagNew, tagUpdate, budgetUpdate } from "./admin-client";
import { upsertBudget, parseResetAt, __resetBudgetCachesForTesting } from "./budget-service";

const asMock = (fn: unknown) => fn as jest.Mock;

describe("upsertBudget reset date", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    __resetBudgetCachesForTesting();
  });

  it("applies budget_reset_at via budgetUpdate using the resolved budget_id", async () => {
    // pre-write existence check → exists; post-write read → budget_id
    asMock(tagInfo)
      .mockResolvedValueOnce({ "team_id_5": { max_budget: 10 } })
      .mockResolvedValueOnce({ "team_id_5": { budget_id: "bud_9" } });
    await upsertBudget("team_id_5", 300, "30d", "2026-08-01T00:00:00.000Z");
    expect(tagUpdate).toHaveBeenCalledWith({ name: "team_id_5", max_budget: 300, budget_duration: "30d" });
    expect(budgetUpdate).toHaveBeenCalledWith("bud_9", { budget_reset_at: "2026-08-01T00:00:00.000Z" });
  });

  it("does not call budgetUpdate when no reset date is given", async () => {
    asMock(tagInfo).mockResolvedValueOnce({ "team_id_5": { max_budget: 10 } });
    await upsertBudget("team_id_5", 300, "30d");
    expect(budgetUpdate).not.toHaveBeenCalled();
  });

  it("parseResetAt validates ISO dates", () => {
    expect(parseResetAt(undefined)).toEqual({ valid: true, value: undefined });
    expect(parseResetAt(null)).toEqual({ valid: true, value: undefined });
    expect(parseResetAt("2026-08-01T00:00:00.000Z")).toEqual({ valid: true, value: "2026-08-01T00:00:00.000Z" });
    expect(parseResetAt("not-a-date")).toEqual({ valid: false });
    expect(parseResetAt(12345)).toEqual({ valid: false });
  });
});
