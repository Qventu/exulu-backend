export type User = {
  id: number;
  firstname?: string;
  lastname?: string;
  email: string;
  emailVerified?: string;
  type?: "api" | "user"
  anthropic_token?: string;
  super_admin?: boolean;
  favourite_agents?: string[];
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
