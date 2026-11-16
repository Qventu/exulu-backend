import { assertWorkStatusConfigSavable, guardRoutineWorkStatusWrites } from "./work-status-save";

const ok = { statuses: [{ key: "neu", label: "Neu" }, { key: "erledigt", label: "Erledigt", done: true }], default: "neu" };

describe("assertWorkStatusConfigSavable", () => {
  it("does not throw for undefined, null and a valid config", () => {
    expect(() => assertWorkStatusConfigSavable(undefined)).not.toThrow();
    expect(() => assertWorkStatusConfigSavable(null)).not.toThrow();
    expect(() => assertWorkStatusConfigSavable(ok)).not.toThrow();
  });
  it("throws with every problem joined", () => {
    expect(() => assertWorkStatusConfigSavable({ statuses: [{ key: "Neu!", label: "" }, { key: "ok1", label: "x" }], default: "weg" }))
      .toThrow(/^Invalid work statuses: .*key.*; .*default/);
  });
});

describe("guardRoutineWorkStatusWrites", () => {
  const names = ["workflow_templatesCreateOne", "workflow_templatesUpdateOne", "workflow_templatesUpdateOneById"];
  const setup = () => {
    const delegates: Record<string, jest.Mock> = Object.fromEntries(names.map((n) => [n, jest.fn().mockResolvedValue({ item: { id: "r1" } })]));
    const mutations: Record<string, any> = { ...delegates, otherMutation: jest.fn() };
    guardRoutineWorkStatusWrites(mutations);
    return { delegates, mutations };
  };
  it("rejects an invalid work_statuses input before the write runs", async () => {
    const { delegates, mutations } = setup();
    for (const name of names) {
      await expect(mutations[name]({}, { id: "r1", input: { work_statuses: { statuses: [{ key: "neu", label: "Neu", done: true }], default: "neu" } } }, {}, {}))
        .rejects.toThrow(/Invalid work statuses: .*done/);
      expect(delegates[name]).not.toHaveBeenCalled();
    }
  });
  it("passes valid input and writes that do not touch work_statuses straight through", async () => {
    const { delegates, mutations } = setup();
    await expect(mutations.workflow_templatesUpdateOneById({}, { id: "r1", input: { work_statuses: ok } }, {}, {})).resolves.toEqual({ item: { id: "r1" } });
    await mutations.workflow_templatesUpdateOneById({}, { id: "r1", input: { name: "x" } }, {}, {});
    expect(delegates.workflow_templatesUpdateOneById).toHaveBeenCalledTimes(2);
  });
  it("leaves other mutations alone and tolerates missing ones", () => {
    const other = jest.fn();
    const mutations: Record<string, any> = { otherMutation: other };
    expect(() => guardRoutineWorkStatusWrites(mutations)).not.toThrow();
    expect(mutations.otherMutation).toBe(other);
  });
});
