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
  scope_mode?: ApiKeyScopeMode;
  agent_ids?: string[];
  role: {
    id: string;
    name: string;
    agents: "read" | "write";
    evals: "read" | "write";
    workflows: "read" | "write";
    variables: "read" | "write";
    users: "read" | "write";
  };
};
