import { coerceValue } from "./coerce";
import type { ImportField } from "./mapping";

type CoercionCase = {
  field: ImportField;
  raw: string;
  expect: { value: string | number | boolean | null } | { error: string };
};

// eslint-disable-next-line @typescript-eslint/no-var-requires
const cases: CoercionCase[] = require("./fixtures/coercion-cases.json");

describe("coerceValue (fixture cases, ported from the frontend wizard)", () => {
  for (const c of cases) {
    it(`"${c.raw}" as ${c.field.type} -> ${JSON.stringify(c.expect)}`, () => {
      const cell = coerceValue(c.field, c.raw);
      if ("error" in c.expect) {
        expect(cell.error?.code).toBe(c.expect.error);
      } else {
        expect(cell.value).toEqual(c.expect.value);
      }
    });
  }
});

describe("coerceValue: raw is preserved verbatim", () => {
  it("keeps the original untrimmed raw string on both success and error", () => {
    expect(coerceValue({ name: "f", type: "number" }, "  1.5  ").raw).toBe("  1.5  ");
    expect(coerceValue({ name: "f", type: "number" }, "  abc  ").raw).toBe("  abc  ");
  });
});

describe("coerceValue: unknown/unhandled types degrade to text", () => {
  it("passes the raw value through unchanged", () => {
    expect(coerceValue({ name: "f", type: "somethingNew" }, "keep me").value).toBe("keep me");
  });
});
