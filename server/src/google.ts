import { createRemoteJWKSet, jwtVerify } from "jose";
import { z } from "zod";
import { config } from "./config.js";
import type { GoogleTokens } from "./types.js";

const googleJwks = createRemoteJWKSet(
  new URL("https://www.googleapis.com/oauth2/v3/certs")
);

const tokenResponseSchema = z.object({
  access_token: z.string(),
  expires_in: z.number().int().positive(),
  refresh_token: z.string().optional(),
  scope: z.string().optional(),
  token_type: z.string().optional(),
  id_token: z.string().optional(),
});

export type VerifiedGoogleIdentity = {
  sub: string;
  email: string;
  name: string;
  picture: string | null;
};

export function googleAuthorizationUrl(input: {
  state: string;
  codeChallenge: string;
  redirectUri: string;
  scopes: string[];
  prompt?: "consent" | "select_account";
  accessType?: "offline" | "online";
}) {
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", config.GOOGLE_CLIENT_ID);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", input.scopes.join(" "));
  url.searchParams.set("state", input.state);
  url.searchParams.set("code_challenge", input.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("include_granted_scopes", "true");
  url.searchParams.set("hd", "pilani.bits-pilani.ac.in");
  if (input.prompt) url.searchParams.set("prompt", input.prompt);
  if (input.accessType) url.searchParams.set("access_type", input.accessType);
  return url.toString();
}

export async function exchangeGoogleCode(input: {
  code: string;
  codeVerifier: string;
  redirectUri: string;
}) {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code: input.code,
      client_id: config.GOOGLE_CLIENT_ID,
      client_secret: config.GOOGLE_CLIENT_SECRET,
      redirect_uri: input.redirectUri,
      grant_type: "authorization_code",
      code_verifier: input.codeVerifier,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new Error(`Google token exchange failed with ${response.status}`);
  }
  const payload = tokenResponseSchema.parse(await response.json());
  return {
    tokens: {
      access_token: payload.access_token,
      refresh_token: payload.refresh_token,
      expires_at: Date.now() + payload.expires_in * 1000,
      scope: payload.scope,
      token_type: payload.token_type,
    } satisfies GoogleTokens,
    idToken: payload.id_token,
  };
}

export async function verifyGoogleIdentity(idToken: string) {
  const { payload } = await jwtVerify(idToken, googleJwks, {
    audience: config.GOOGLE_CLIENT_ID,
    issuer: ["https://accounts.google.com", "accounts.google.com"],
  });

  const email = typeof payload.email === "string" ? payload.email.toLowerCase() : "";
  const hostedDomain = typeof payload.hd === "string" ? payload.hd.toLowerCase() : "";
  if (
    payload.email_verified !== true ||
    hostedDomain !== "pilani.bits-pilani.ac.in" ||
    !email.endsWith("@pilani.bits-pilani.ac.in") ||
    typeof payload.sub !== "string"
  ) {
    throw new Error("A verified Pilani BITS account is required");
  }

  return {
    sub: payload.sub,
    email,
    name:
      typeof payload.name === "string" && payload.name.trim()
        ? payload.name.trim().slice(0, 120)
        : email.split("@")[0] ?? "BITSian",
    picture: typeof payload.picture === "string" ? payload.picture : null,
  } satisfies VerifiedGoogleIdentity;
}

export async function refreshGoogleTokens(tokens: GoogleTokens) {
  if (tokens.expires_at > Date.now() + 60_000) return tokens;
  if (!tokens.refresh_token) throw new Error("Google refresh token is missing");

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: config.GOOGLE_CLIENT_ID,
      client_secret: config.GOOGLE_CLIENT_SECRET,
      refresh_token: tokens.refresh_token,
      grant_type: "refresh_token",
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Google token refresh failed with ${response.status}`);
  const payload = tokenResponseSchema.parse(await response.json());
  return {
    ...tokens,
    access_token: payload.access_token,
    expires_at: Date.now() + payload.expires_in * 1000,
    scope: payload.scope ?? tokens.scope,
    token_type: payload.token_type ?? tokens.token_type,
  } satisfies GoogleTokens;
}

export async function googleApi<T>(
  tokens: GoogleTokens,
  path: string,
  init: RequestInit = {}
): Promise<{ data: T; tokens: GoogleTokens }> {
  const freshTokens = await refreshGoogleTokens(tokens);
  const response = await fetch(`https://www.googleapis.com${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${freshTokens.access_token}`,
      ...init.headers,
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    const body = (await response.text()).slice(0, 500);
    throw new Error(`Google API ${response.status}: ${body}`);
  }
  if (response.status === 204) {
    return { data: undefined as T, tokens: freshTokens };
  }
  return { data: (await response.json()) as T, tokens: freshTokens };
}
