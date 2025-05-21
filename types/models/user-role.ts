export type UserRole = {
  id: string;
  role: string;
  is_admin: boolean;
  agents: {
    id: string;
    name: string;
  }[];
};
