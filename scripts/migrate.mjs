/**
 * Applies pending migrations from ./drizzle before the app is built, so a
 * fresh deployment comes up with its tables already in place and nobody
 * has to clone the repo to run a schema command.
 *
 * Skips silently when DATABASE_URL is absent, which keeps `next build`
 * working for anyone building without a database (CI, a local type check,
 * or a first Vercel build where the store is not attached yet).
 *
 * Migrations are tracked in a __drizzle_migrations table, so re-running on
 * every deploy is a no-op once they have been applied.
 */
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

const url = process.env.DATABASE_URL;

if (!url) {
  console.log("[migrate] No DATABASE_URL set — skipping migrations.");
  process.exit(0);
}

const pool = new Pool({ connectionString: url, max: 1 });

try {
  await migrate(drizzle(pool), { migrationsFolder: "./drizzle" });
  console.log("[migrate] Schema is up to date.");
} catch (error) {
  console.error("[migrate] Failed to apply migrations:", error);
  process.exit(1);
} finally {
  await pool.end();
}
