import postgres from "postgres";
import { config } from "./config.js";

export const sql = postgres(config.DATABASE_URL, {
  max: 10,
  idle_timeout: 20,
  connect_timeout: 10,
  prepare: false,
  onnotice: () => undefined,
});

export async function closeDatabase() {
  await sql.end({ timeout: 5 });
}
