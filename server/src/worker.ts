import { closeDatabase, sql } from "./db.js";
import { syncCalendarForUser } from "./calendar.js";

let running = false;

async function run() {
  if (running) return;
  running = true;
  try {
    await sql`DELETE FROM sessions WHERE expires_at <= now()`;
    await sql`DELETE FROM oauth_states WHERE expires_at <= now()`;
    const connections = await sql<{ user_id: string }[]>`
      SELECT user_id FROM calendar_connections WHERE sync_enabled = true
    `;
    for (const connection of connections) {
      try {
        await syncCalendarForUser(connection.user_id);
      } catch (error) {
        console.error(`Calendar sync failed for ${connection.user_id}`, error);
      }
    }
  } finally {
    running = false;
  }
}

const interval = setInterval(() => void run(), 5 * 60 * 1000);
void run();

async function shutdown() {
  clearInterval(interval);
  await closeDatabase();
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
