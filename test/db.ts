/**
 * Shared setup for the tests that need a real database.
 *
 * These run against Postgres rather than a mocked query builder: the logic
 * worth covering here is the scheduler's claim-before-submit update and the
 * partial index behind the sweep, and a mock would only assert that we
 * called the mock.
 */
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";

import { getDb } from "../lib/db";

/** CI always provides one; locally you may not have Postgres running. */
export const hasDatabase = Boolean(process.env.DATABASE_URL);

export async function applyMigrations(): Promise<void> {
  await migrate(getDb(), { migrationsFolder: "./drizzle" });
}

export async function resetTables(): Promise<void> {
  // `brands` is listed even though CASCADE would reach the derived tables
  // anyway: truncating results alone leaves brand rows behind, and a test
  // that adds a brand would then see the previous test's brands too.
  await getDb().execute(
    sql`TRUNCATE results, prompts, brands RESTART IDENTITY CASCADE`,
  );
}

/** Stops the pooled connections so vitest can exit cleanly. */
export async function closeDatabase(): Promise<void> {
  const pool = (
    globalThis as { cloroTrackerPool?: { end: () => Promise<void> } }
  ).cloroTrackerPool;
  await pool?.end();
}
