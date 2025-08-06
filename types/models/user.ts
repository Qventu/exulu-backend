export type User = {
  id: string;
  email: string;
  emailVerified?: string;
  type?: "api" | "user"
  anthropic_token?: string;
  super_admin?: boolean;
  roles?: {
    id: string;
    role: string;
  }[];
};
