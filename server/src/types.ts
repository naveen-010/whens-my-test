export type AppUser = {
  id: string;
  email: string;
  name: string;
  avatarUrl: string | null;
  role: "student" | "moderator" | "admin";
};

export type GoogleTokens = {
  access_token: string;
  refresh_token?: string;
  expires_at: number;
  scope?: string;
  token_type?: string;
};
