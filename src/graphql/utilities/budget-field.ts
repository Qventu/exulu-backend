import {
  getBudgetSettings,
  getTagBudgetMap,
} from "@SRC/exulu/litellm/budget-service";
import { budgetTagFor, type BudgetEntityType } from "@SRC/exulu/tags";
import type { User } from "@EXULU_TYPES/models/user";

export const BUDGET_ENTITY_SINGULARS = new Set<string>([
  "user",
  "role",
  "team",
  "project",
  "agent",
  // `workflow_template` is the GraphQL table singular; budgets attach to it
  // under the user-facing BudgetEntityType "routine" (see tags.ts). The mapping
  // happens in BUDGET_ENTITY_TYPE_BY_SINGULAR below so budgetTagFor() emits the
  // correct `routine_id_<uuid>` tag.
  "workflow_template",
]);

/**
 * Some GraphQL table singulars don't match their BudgetEntityType verbatim
 * (e.g. workflow_template → routine). Map here so addBudgetField builds the
 * correct LiteLLM tag (`routine_id_<uuid>`) that matches what buildTags() emits
 * from the workflow job runner.
 */
const BUDGET_ENTITY_TYPE_BY_SINGULAR: Record<string, BudgetEntityType> = {
  user: "user",
  role: "role",
  team: "team",
  project: "project",
  agent: "agent",
  workflow_template: "routine",
};

/**
 * Resolve the computed `budget` field for an entity row. The budget lives in
 * LiteLLM (keyed by the entity's *_id_* tag); getTagBudgetMap is cached ~30s so
 * resolving a full page of rows is a single LiteLLM call + cheap map lookups.
 *
 * Gating:
 *  - super_admin / role.budget_management read|write → full tag info (admin view).
 *  - projects only: any other requester gets a reduced "member view" — the
 *    row-level RBAC on the query already decided they can see this project, so
 *    they may see its usage too. The view echoes the platform
 *    user_budget_display setting (same convention as /me/budget — the raw
 *    figures stay on the wire, rendering is a UI choice) and omits the
 *    internal budget_id. One getBudgetSettings() DB read per member-view row;
 *    fine for the detail page (single row), and no list UI queries budgets as
 *    a member today.
 *  - every other entity type stays admin-only (budget = null).
 */
export const addBudgetField = async (
  requestedFields: string[],
  result: any,
  tableSingular: string,
  user: User | undefined,
): Promise<any> => {
  if (!requestedFields.includes("budget")) return result;

  // Translate GraphQL table singular → BudgetEntityType (e.g. workflow_template → routine).
  const entityType = BUDGET_ENTITY_TYPE_BY_SINGULAR[tableSingular];
  const scope = (user as any)?.role?.budget_management;
  const canReadAll =
    !!user?.super_admin || scope === "read" || scope === "write";
  const memberView = !canReadAll && entityType === "project";
  if ((!canReadAll && !memberView) || result?.id == null || !entityType) {
    result.budget = null;
    return result;
  }

  const map = await getTagBudgetMap();
  const tag = budgetTagFor(entityType, result.id);
  const info = tag ? (map[tag] ?? null) : null;
  if (!memberView) {
    result.budget = info;
    return result;
  }
  if (!info) {
    result.budget = null;
    return result;
  }

  const settings = await getBudgetSettings();
  result.budget = {
    spend: info.spend,
    max_budget: info.max_budget,
    budget_duration: info.budget_duration,
    budget_reset_at: info.budget_reset_at,
    display: settings.user_budget_display,
  };
  return result;
};
