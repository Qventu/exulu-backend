// budget-service is the only heavy dependency; mock it so importing the
// module under test never touches postgres or LiteLLM.
jest.mock("@SRC/exulu/litellm/budget-service", () => ({
  getTagBudgetMap: jest.fn(),
  getBudgetSettings: jest.fn(),
}));

import {
  getBudgetSettings,
  getTagBudgetMap,
} from "@SRC/exulu/litellm/budget-service";

import { addBudgetField } from "./budget-field";

const TAG_MAP = {
  project_id_p1: {
    name: "project_id_p1",
    spend: 12.5,
    max_budget: 50,
    budget_duration: "30d",
    budget_reset_at: "2026-08-01T00:00:00.000Z",
    budget_id: "b-123",
  },
  user_id_u1: {
    name: "user_id_u1",
    spend: 1,
    max_budget: 10,
    budget_duration: "30d",
    budget_reset_at: "2026-08-01T00:00:00.000Z",
    budget_id: "b-456",
  },
};

const SETTINGS = {
  global_user_budget: { enabled: false, max_budget: 0, budget_duration: "30d" },
  show_user_budget_in_chat: false,
  user_budget_display: "percent",
};

const admin = { super_admin: true } as any;
const member = { super_admin: false, role: {} } as any;
const reader = { super_admin: false, role: { budget_management: "read" } } as any;

beforeEach(() => {
  jest.clearAllMocks();
  (getTagBudgetMap as jest.Mock).mockResolvedValue(TAG_MAP);
  (getBudgetSettings as jest.Mock).mockResolvedValue(SETTINGS);
});

describe("addBudgetField — admin view (unchanged behavior)", () => {
  it("returns the full tag info (incl. budget_id, no display echo) for super admins", async () => {
    const result = await addBudgetField(["budget"], { id: "p1" }, "project", admin);
    expect(result.budget).toEqual(TAG_MAP.project_id_p1);
    expect(result.budget).not.toHaveProperty("display");
  });

  it("returns the full tag info for budget_management readers", async () => {
    const result = await addBudgetField(["budget"], { id: "p1" }, "project", reader);
    expect(result.budget).toEqual(TAG_MAP.project_id_p1);
  });

  it("does nothing when budget was not requested", async () => {
    const result = await addBudgetField(["id", "name"], { id: "p1" }, "project", member);
    expect(result).not.toHaveProperty("budget");
    expect(getTagBudgetMap).not.toHaveBeenCalled();
  });

  it("nulls the field when the row has no id", async () => {
    const result = await addBudgetField(["budget"], {} as any, "project", member);
    expect(result.budget).toBeNull();
  });
});

describe("addBudgetField — project member view", () => {
  it("returns the reduced member view (display echo, no budget_id) for a member", async () => {
    const result = await addBudgetField(["budget"], { id: "p1" }, "project", member);
    expect(result.budget).toEqual({
      spend: 12.5,
      max_budget: 50,
      budget_duration: "30d",
      budget_reset_at: "2026-08-01T00:00:00.000Z",
      display: "percent",
    });
    expect(result.budget).not.toHaveProperty("budget_id");
  });

  it("echoes 'amount' when the platform display setting is amount", async () => {
    (getBudgetSettings as jest.Mock).mockResolvedValue({
      ...SETTINGS,
      user_budget_display: "amount",
    });
    const result = await addBudgetField(["budget"], { id: "p1" }, "project", member);
    expect(result.budget.display).toBe("amount");
  });

  it("returns null for a member when the project has no budget tag", async () => {
    const result = await addBudgetField(["budget"], { id: "p2" }, "project", member);
    expect(result.budget).toBeNull();
  });

  it("still nulls the field for members on non-project entities", async () => {
    const result = await addBudgetField(["budget"], { id: "u1" }, "user", member);
    expect(result.budget).toBeNull();
    expect(getBudgetSettings).not.toHaveBeenCalled();
  });
});
