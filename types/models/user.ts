export type User = {
  id: string;
  email: string;
  emailVerified?: string;
  type?: "api" | "user"
  anthropic_token?: string;
  roles?: {
    id: string;
    role: string;
  }[];
};
