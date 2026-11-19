import { parseActionsYaml, ACTIONS_MAX_BYTES } from "./schema";

const VALID = `version: 1
actions:
  export:
    description: Writes the workbook.
    run: python3 "$EXULU_SKILL_DIR/scripts/export.py"
    inputs:
      pitch: { type: item, context: mv_pitches, fields: [felder] }
      note: { type: text, required: false }
`;

describe("parseActionsYaml", () => {
  test("valid file", () => {
    const r = parseActionsYaml(VALID);
    expect(r.ok && r.actions.export.timeoutSeconds).toBe(60);
    expect(r.ok && r.actions.export.inputs.note).toEqual({ type: "text", required: false });
    expect(r.ok && r.actions.export.inputs.pitch).toEqual({
      type: "item",
      context: "mv_pitches",
      fields: ["felder"],
    });
  });

  test("text input is required by default", () => {
    const r = parseActionsYaml(VALID.replace(", required: false", ""));
    expect(r.ok && (r.actions.export.inputs.note as any).required).toBe(true);
  });

  test("items input accepts a fixed where object", () => {
    const r = parseActionsYaml(
      VALID.replace("note:", "rows: { type: items, context: c, where: { status: open } }\n      note:"),
    );
    expect(r.ok && r.actions.export.inputs.rows).toEqual({
      type: "items",
      context: "c",
      where: { status: "open" },
    });
  });

  test("timeout_seconds maps to timeoutSeconds", () => {
    const r = parseActionsYaml(VALID.replace("    inputs:", "    timeout_seconds: 300\n    inputs:"));
    expect(r.ok && r.actions.export.timeoutSeconds).toBe(300);
  });

  test.each([
    ["wrong version", VALID.replace("version: 1", "version: 2")],
    ["unknown top-level key", VALID + "extra: 1\n"],
    ["unknown action key", VALID.replace("    run:", "    rnu: x\n    run:")],
    ["bad action name", VALID.replace("  export:", "  Export-1:")],
    ["unknown input type", VALID.replace("type: text", "type: file")],
    ["item without context", VALID.replace("context: mv_pitches, ", "")],
    ["timeout above 300", VALID.replace("    inputs:", "    timeout_seconds: 301\n    inputs:")],
    ["timeout zero", VALID.replace("    inputs:", "    timeout_seconds: 0\n    inputs:")],
    ["not yaml", "{{{"],
    ["oversized", VALID + "#".repeat(ACTIONS_MAX_BYTES)],
  ])("refuses: %s", (_n, text) => {
    const r = parseActionsYaml(text);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error.length).toBeGreaterThan(0);
  });

  test("accepts exactly 20 actions and refuses 21", () => {
    const build = (n: number) =>
      "version: 1\nactions:\n" +
      Array.from({ length: n }, (_, i) => `  a${i}:\n    description: d\n    run: echo\n`).join("");
    expect(parseActionsYaml(build(20)).ok).toBe(true);
    const r = parseActionsYaml(build(21));
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error.length).toBeGreaterThan(0);
  });
});
