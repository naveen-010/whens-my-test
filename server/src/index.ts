import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyError } from "fastify";
import { ZodError } from "zod";
import { registerAuthRoutes } from "./auth.js";
import { registerCalendarRoutes } from "./calendar.js";
import { allowedOrigins, config, googleConfigured } from "./config.js";
import { closeDatabase, sql } from "./db.js";
import { registerApplicationRoutes } from "./routes.js";

const app = Fastify({
  logger: { level: config.LOG_LEVEL },
  trustProxy: true,
  bodyLimit: 64 * 1024,
  requestTimeout: 15_000,
  connectionTimeout: 10_000,
});

await app.register(cookie);
await app.register(cors, {
  origin(origin, callback) {
    if (!origin || allowedOrigins.has(origin)) callback(null, true);
    else callback(null, false);
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
});
await app.register(helmet, {
  contentSecurityPolicy: false,
  crossOriginResourcePolicy: { policy: "same-site" },
});
await app.register(rateLimit, {
  global: true,
  max: 180,
  timeWindow: "1 minute",
  ban: 3,
});

app.addHook("onRequest", async (request, reply) => {
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(request.method)) return;
  const origin = request.headers.origin;
  if (!origin || !allowedOrigins.has(origin)) {
    return reply.code(403).send({ error: "Request origin is not allowed" });
  }
});

app.get("/health", async () => {
  const [database] = await sql<{ ok: number }[]>`SELECT 1 AS ok`;
  return {
    status: database?.ok === 1 ? "ok" : "degraded",
    database: database?.ok === 1 ? "connected" : "unavailable",
    googleConfigured,
    time: new Date().toISOString(),
  };
});

await registerAuthRoutes(app);
await registerApplicationRoutes(app);
await registerCalendarRoutes(app);

app.setNotFoundHandler((_request, reply) => {
  return reply.code(404).send({ error: "Not found" });
});

app.setErrorHandler((error: FastifyError, request, reply) => {
  if (error instanceof ZodError) {
    return reply.code(400).send({
      error: "Invalid request",
      issues: error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
    });
  }
  if (error.statusCode && error.statusCode < 500) {
    return reply.code(error.statusCode).send({ error: error.message });
  }
  request.log.error({ err: error }, "Unhandled request error");
  return reply.code(500).send({ error: "Internal server error" });
});

async function shutdown(signal: string) {
  app.log.info({ signal }, "Shutting down");
  await app.close();
  await closeDatabase();
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

try {
  await app.listen({ host: config.HOST, port: config.PORT });
} catch (error) {
  app.log.fatal(error);
  await closeDatabase();
  process.exit(1);
}
