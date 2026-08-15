import { and, desc, eq, gte, lte, type SQL } from "drizzle-orm";

import { isApiKeyAuthorized, unauthorized } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { results } from "@/lib/db/schema";
import { parseOr400, withErrors } from "@/lib/http";
import { resultsQuerySchema } from "@/lib/validation";

export const runtime = "nodejs";

/**
 * Query stored results. The raw `response` payload is omitted by default
 * (it can be large); pass `include=response` to get it.
 */
export const GET = withErrors(async (req) => {
  if (!isApiKeyAuthorized(req)) return unauthorized();
  const query = parseOr400(
    resultsQuerySchema,
    Object.fromEntries(new URL(req.url).searchParams),
  );

  const conditions: SQL[] = [];
  if (query.promptId) conditions.push(eq(results.promptId, query.promptId));
  if (query.engine) conditions.push(eq(results.engine, query.engine));
  if (query.status) conditions.push(eq(results.status, query.status));
  if (query.from) conditions.push(gte(results.createdAt, query.from));
  if (query.to) conditions.push(lte(results.createdAt, query.to));

  const db = getDb();
  const columns = {
    id: results.id,
    promptId: results.promptId,
    engine: results.engine,
    taskId: results.taskId,
    status: results.status,
    error: results.error,
    creditsCharged: results.creditsCharged,
    createdAt: results.createdAt,
    completedAt: results.completedAt,
    ...(query.include === "response" ? { response: results.response } : {}),
  };

  const rows = await db
    .select(columns)
    .from(results)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(results.createdAt))
    .limit(query.limit);

  return Response.json({ results: rows });
});
