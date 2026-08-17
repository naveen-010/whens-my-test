import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { config, googleConfigured } from "./config.js";
import { sql } from "./db.js";
import {
  exchangeGoogleCode,
  googleAuthorizationUrl,
  verifyGoogleIdentity,
} from "./google.js";
import { pkceChallenge, randomToken, tokenHash } from "./security.js";
import type { AppUser } from "./types.js";

const sessionCookie = "__Host-wmt_session";
const oauthCookie = "__Host-wmt_oauth";
const cookieOptions = {
  path: "/",
  secure: true,
  httpOnly: true,
  sameSite: "lax" as const,
};

type SessionRow = {
  id: string;
  email: string;
  name: string;
  avatar_url: string | null;
  role: AppUser["role"];
};

export async function currentUser(request: FastifyRequest): Promise<AppUser | null> {
  const token = request.cookies[sessionCookie];
  if (!token) return null;
  const [row] = await sql<SessionRow[]>`
    SELECT u.id, u.email::text, u.name, u.avatar_url, u.role
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ${tokenHash(token)} AND s.expires_at > now()
  `;
  if (!row) return null;

  void sql`
    UPDATE sessions SET last_seen_at = now()
    WHERE token_hash = ${tokenHash(token)}
      AND last_seen_at < now() - interval '15 minutes'
  `.catch(() => undefined);

  return {
    id: row.id,
    email: row.email,
    name: row.name,
    avatarUrl: row.avatar_url,
    role: row.role,
  };
}

export async function requireUser(request: FastifyRequest, reply: FastifyReply) {
  const user = await currentUser(request);
  if (!user) {
    await reply.code(401).send({ error: "Authentication required" });
    return null;
  }
  return user;
}

async function createOauthState(purpose: "login" | "calendar", userId?: string) {
  const state = randomToken();
  const verifier = randomToken(48);
  await sql`
    INSERT INTO oauth_states (token_hash, purpose, user_id, code_verifier, expires_at)
    VALUES (
      ${tokenHash(state)},
      ${purpose},
      ${userId ?? null},
      ${verifier},
      now() + interval '10 minutes'
    )
  `;
  return { state, verifier };
}

export async function consumeOauthState(
  request: FastifyRequest,
  state: string,
  purpose: "login" | "calendar"
) {
  const cookieState = request.cookies[oauthCookie];
  if (!cookieState || cookieState !== state) return null;
  const [row] = await sql<{
    user_id: string | null;
    code_verifier: string;
  }[]>`
    DELETE FROM oauth_states
    WHERE token_hash = ${tokenHash(state)}
      AND purpose = ${purpose}
      AND expires_at > now()
    RETURNING user_id, code_verifier
  `;
  return row ?? null;
}

export function clearOauthCookie(reply: FastifyReply) {
  reply.clearCookie(oauthCookie, cookieOptions);
}

export async function registerAuthRoutes(app: FastifyInstance) {
  app.get("/auth/me", async (request, reply) => {
    const user = await currentUser(request);
    if (!user) return reply.code(401).send({ error: "Not signed in" });
    return { user, googleConfigured };
  });

  app.get("/auth/google/start", async (_request, reply) => {
    if (!googleConfigured) {
      return reply.code(503).send({
        error: "Google authentication is awaiting server credentials",
        code: "GOOGLE_NOT_CONFIGURED",
      });
    }
    const { state, verifier } = await createOauthState("login");
    reply.setCookie(oauthCookie, state, { ...cookieOptions, maxAge: 600 });
    return reply.redirect(
      googleAuthorizationUrl({
        state,
        codeChallenge: pkceChallenge(verifier),
        redirectUri: config.GOOGLE_LOGIN_REDIRECT_URI,
        scopes: ["openid", "email", "profile"],
        prompt: "select_account",
      })
    );
  });

  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>(
    "/auth/google/callback",
    async (request, reply) => {
      const { code, state, error } = request.query;
      if (error || !code || !state) {
        clearOauthCookie(reply);
        return reply.redirect(`${config.FRONTEND_URL}/?auth_error=cancelled`);
      }

      const storedState = await consumeOauthState(request, state, "login");
      clearOauthCookie(reply);
      if (!storedState) {
        return reply.redirect(`${config.FRONTEND_URL}/?auth_error=invalid_state`);
      }

      try {
        const { idToken } = await exchangeGoogleCode({
          code,
          codeVerifier: storedState.code_verifier,
          redirectUri: config.GOOGLE_LOGIN_REDIRECT_URI,
        });
        if (!idToken) throw new Error("Google did not return an identity token");
        const identity = await verifyGoogleIdentity(idToken);
        const [user] = await sql<{ id: string }[]>`
          INSERT INTO users (google_sub, email, name, avatar_url)
          VALUES (${identity.sub}, ${identity.email}, ${identity.name}, ${identity.picture})
          ON CONFLICT (email) DO UPDATE SET
            google_sub = EXCLUDED.google_sub,
            name = EXCLUDED.name,
            avatar_url = EXCLUDED.avatar_url,
            updated_at = now()
          RETURNING id
        `;
        if (!user) throw new Error("Could not create user");

        await sql`
          INSERT INTO notification_preferences (user_id)
          VALUES (${user.id}) ON CONFLICT (user_id) DO NOTHING
        `;
        const sessionToken = randomToken();
        await sql`
          INSERT INTO sessions (user_id, token_hash, expires_at)
          VALUES (
            ${user.id},
            ${tokenHash(sessionToken)},
            now() + (${config.SESSION_TTL_DAYS}::text || ' days')::interval
          )
        `;
        reply.setCookie(sessionCookie, sessionToken, {
          ...cookieOptions,
          maxAge: config.SESSION_TTL_DAYS * 24 * 60 * 60,
        });
        return reply.redirect(`${config.FRONTEND_URL}/`);
      } catch (oauthError) {
        request.log.warn({ err: oauthError }, "Google login failed");
        return reply.redirect(`${config.FRONTEND_URL}/?auth_error=account_rejected`);
      }
    }
  );

  app.post("/auth/logout", async (request, reply) => {
    const token = request.cookies[sessionCookie];
    if (token) {
      await sql`DELETE FROM sessions WHERE token_hash = ${tokenHash(token)}`;
    }
    reply.clearCookie(sessionCookie, cookieOptions);
    return reply.code(204).send();
  });
}

export { createOauthState, oauthCookie, cookieOptions };
