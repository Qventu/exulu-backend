import { createTurnProject, currentProjectId } from "./turn-project";

describe("turn project holder", () => {
  it("starts null without a project and copies the one it is given", () => {
    expect(createTurnProject(null).current).toBeNull();
    expect(createTurnProject().current).toBeNull();
    const src = { id: "p1", name: "A", speakerCanWrite: true };
    const h = createTurnProject(src);
    expect(h.current).toEqual(src);
    expect(h.current).not.toBe(src);
  });
  it("currentProjectId reads the holder at call time and prefers it over the fallback", () => {
    const h = createTurnProject(null);
    expect(currentProjectId(h, "static")).toBeNull();
    h.current = { id: "p2", name: "B", speakerCanWrite: true };
    expect(currentProjectId(h, "static")).toBe("p2");
    expect(currentProjectId(undefined, "static")).toBe("static");
    expect(currentProjectId(undefined)).toBeNull();
  });
});
