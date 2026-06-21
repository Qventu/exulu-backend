import type { Project } from "./project";

export type ApiKeyScopeMode = "admin" | "agents";

export type User = {
  id: number;
  firstname?: string;
  lastname?: string;
  email: string;
  emailVerified?: string;
  type?: "api" | "user"
  anthropic_token?: string;
  personal_system_prompt?: string;
  super_admin?: boolean;
  favourite_agents?: string[];
  /** Per-user favourited data items — global ids ("<contextId>/<itemId>"). */
  favourite_items?: string[];
  /** Per-user recently viewed data items — global ids, most-recent first. */
  recently_viewed_items?: string[];
  scope_mode?: ApiKeyScopeMode;
  agent_ids?: string[];
  role: UserRole;
  team?: ExuluTeam;
  /**
   * Optional attribution target (mainly for API keys, type "api"): hydrated
   * from the `project` uuid column at auth time so buildTags can emit
   * project_id_ for API-triggered requests.
   */
  project?: Project;
  /**
   * Live LiteLLM budget snapshot for the user, attached at context time when
   * the "show user budget in chat" setting is on. Not a Postgres column.
   */
  budget?: UserBudgetView | null;
};

export type UserBudgetView = {
  spend: number;
  max_budget: number;
  budget_duration: string | null;
  budget_reset_at: string | null;
};

export type UserRole = {
  id: string;
  name: string;
  agents: "read" | "write";
  evals: "read" | "write";
  workflows: "read" | "write";
  variables: "read" | "write";
  users: "read" | "write";
  budget_management?: "read" | "write";
}

export type ExuluTeam = {
  id: string;
  name: string;
  description?: string;
};