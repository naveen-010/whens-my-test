import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().positive().default(8080),
  DATABASE_URL: z.string().min(1),
  FRONTEND_URL: z.url().default("https://whens-my-test.vercel.app"),
  GOOGLE_CLIENT_ID: z.string().default(""),
  GOOGLE_CLIENT_SECRET: z.string().default(""),
  GOOGLE_LOGIN_REDIRECT_URI: z.url().default(
    "https://whens-my-test.vercel.app/api/auth/google/callback"
  ),
  GOOGLE_CALENDAR_REDIRECT_URI: z.url().default(
    "https://whens-my-test.vercel.app/api/calendar/callback"
  ),
  TOKEN_ENCRYPTION_KEY: z.string().min(43),
  SESSION_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(30),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
});

export const config = schema.parse(process.env);
export const googleConfigured = Boolean(
  config.GOOGLE_CLIENT_ID && config.GOOGLE_CLIENT_SECRET
);

export const allowedOrigins = new Set([
  config.FRONTEND_URL,
  "http://localhost:5173",
  "http://127.0.0.1:5173",
]);
