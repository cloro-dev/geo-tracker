import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import { env } from "../env";
import * as schema from "./schema";

// Pool is cached on globalThis so dev-server HMR and warm serverless
// invocations reuse connections instead of leaking them. Created lazily so
// `next build` never needs DATABASE_URL.
const globalForDb = globalThis as unknown as { geoTrackerPool?: Pool };

export function getDb() {
  const pool = (globalForDb.geoTrackerPool ??= new Pool({
    connectionString: env.databaseUrl,
    max: 3,
  }));
  return drizzle(pool, { schema });
}

export type Db = ReturnType<typeof getDb>;
