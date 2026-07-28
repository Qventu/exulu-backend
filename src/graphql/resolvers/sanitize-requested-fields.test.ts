import { sanitizeRequestedFields } from "./index";
import type { ExuluTableDefinition } from "@EXULU_TYPES/exulu-table-definition";

// `variables` and `budget` are computed GraphQL fields on workflow_template
// (hydrated in finalizeRequestedFields from steps_json / LiteLLM), not DB
// columns. If they leak into the SQL SELECT, every environment whose
// workflow_templates table was created after the physical `variables` column
// was dropped from the schema (2026-01) 500s on the /workflows page with
// 'column "variables" does not exist'.
const workflowTemplatesTable: ExuluTableDefinition = {
  type: "workflow_templates",
  name: {
    plural: "workflow_templates",
    singular: "workflow_template",
  },
  RBAC: true,
  fields: [
    { name: "name", type: "text", required: true },
    { name: "description", type: "text" },
    { name: "agent", type: "uuid" },
    { name: "steps_json", type: "json", required: true },
    { name: "auto_approve_tools", type: "boolean", default: false },
  ],
} as ExuluTableDefinition;

describe("sanitizeRequestedFields — workflow_template computed fields", () => {
  test("strips `variables` from the SQL selection (routines list query)", () => {
    const requested = [
      "id",
      "agent",
      "name",
      "description",
      "rights_mode",
      "created_by",
      "steps_json",
      "variables",
      "createdAt",
      "updatedAt",
    ];
    const sanitized = sanitizeRequestedFields(workflowTemplatesTable, requested);
    expect(sanitized).not.toContain("variables");
  });

  test("adds steps_json exactly once when already requested", () => {
    const sanitized = sanitizeRequestedFields(workflowTemplatesTable, [
      "id",
      "steps_json",
      "variables",
    ]);
    expect(sanitized.filter((f) => f === "steps_json")).toHaveLength(1);
  });

  test("adds steps_json when only variables is requested (hydration source)", () => {
    const sanitized = sanitizeRequestedFields(workflowTemplatesTable, [
      "id",
      "variables",
    ]);
    expect(sanitized).toContain("steps_json");
    expect(sanitized).not.toContain("variables");
  });

  test("strips computed `budget` from the SQL selection (/budgets routines tab)", () => {
    const sanitized = sanitizeRequestedFields(workflowTemplatesTable, [
      "id",
      "name",
      "budget",
    ]);
    expect(sanitized).not.toContain("budget");
  });

  test("does not mutate the caller's requestedFields array", () => {
    // finalizeRequestedFields consults the ORIGINAL requested fields to decide
    // whether to delete steps_json from the payload; pushing onto the shared
    // array would make steps_json leak into responses that never asked for it.
    const requested = ["id", "variables"];
    sanitizeRequestedFields(workflowTemplatesTable, requested);
    expect(requested).toEqual(["id", "variables"]);
  });
});
