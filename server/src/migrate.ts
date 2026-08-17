import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { closeDatabase, sql } from "./db.js";

async function migrate() {
  await sql`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `;

  const migrationsDirectory = resolve(process.cwd(), "migrations");
  const filenames = (await readdir(migrationsDirectory))
    .filter((filename) => filename.endsWith(".sql"))
    .sort();

  for (const filename of filenames) {
    const [existing] = await sql<{ filename: string }[]>`
      SELECT filename FROM schema_migrations WHERE filename = ${filename}
    `;
    if (existing) continue;

    const migration = await readFile(resolve(migrationsDirectory, filename), "utf8");
    await sql.begin(async (transaction) => {
      await transaction.unsafe(migration);
      await transaction`
        INSERT INTO schema_migrations (filename) VALUES (${filename})
      `;
    });
    console.log(`Applied migration ${filename}`);
  }
}

migrate()
  .then(closeDatabase)
  .catch(async (error: unknown) => {
    console.error(error);
    await closeDatabase();
    process.exitCode = 1;
  });
