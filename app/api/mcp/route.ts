import { and, asc, desc, eq, gte, sql } from "drizzle-orm";
import { createMcpHandler } from "mcp-handler";
import { z } from "zod";

import { isApiKeyAuthorized, unauthorized } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { brands, prompts, resultBrandMentions, results } from "@/lib/db/schema";
import { ENGINES } from "@/lib/engines";
import { isUniqueViolation } from "@/lib/http";
import { markAllForReextraction } from "@/lib/refresh";
import { submitPromptOnce } from "@/lib/runner";
import { createBrandSchema } from "@/lib/validation";

export const runtime = "nodejs";

function text(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text:
          typeof value === "string" ? value : JSON.stringify(value, null, 2),
      },
    ],
  };
}

const handler = createMcpHandler(
  (server) => {
    server.registerTool(
      "list_prompts",
      {
        title: "List prompts",
        description:
          "List all configured prompts with their engines, schedule and last run time.",
        inputSchema: z.object({}),
      },
      async () => {
        const rows = await getDb()
          .select()
          .from(prompts)
          .orderBy(desc(prompts.createdAt));
        return text(rows);
      },
    );

    server.registerTool(
      "create_prompt",
      {
        title: "Create prompt",
        description:
          "Create a prompt to track. It will run runsPerDay times per day against the selected AI engines.",
        inputSchema: z.object({
          name: z.string().min(1).max(200),
          prompt: z.string().min(1).max(10_000),
          engines: z.array(z.enum(ENGINES)).min(1),
          country: z.string().length(2).default("US"),
          runsPerDay: z.number().int().min(1).max(24).default(1),
          enabled: z.boolean().default(true),
        }),
      },
      async (input) => {
        const [created] = await getDb()
          .insert(prompts)
          .values({ ...input, country: input.country.toUpperCase() })
          .returning();
        return text(created);
      },
    );

    server.registerTool(
      "run_prompt",
      {
        title: "Run prompt now",
        description:
          "Submit a prompt to its engines immediately. Returns pending task ids; results arrive asynchronously (check get_results shortly after).",
        inputSchema: z.object({ promptId: z.uuid() }),
      },
      async ({ promptId }) => {
        const db = getDb();
        const [claimed] = await db
          .update(prompts)
          .set({ lastRunAt: new Date() })
          .where(eq(prompts.id, promptId))
          .returning();
        if (!claimed) return text(`Prompt ${promptId} not found`);
        return text(await submitPromptOnce(claimed));
      },
    );

    server.registerTool(
      "get_results",
      {
        title: "Get results",
        description:
          "Query stored run results (without the raw response payload — use get_result for that). Filter by prompt, engine or status.",
        inputSchema: z.object({
          promptId: z.uuid().optional(),
          engine: z.enum(ENGINES).optional(),
          status: z.enum(["pending", "completed", "failed"]).optional(),
          limit: z.number().int().min(1).max(200).default(50),
        }),
      },
      async ({ promptId, engine, status, limit }) => {
        const conditions = [
          promptId ? eq(results.promptId, promptId) : undefined,
          engine ? eq(results.engine, engine) : undefined,
          status ? eq(results.status, status) : undefined,
        ].filter((condition) => condition !== undefined);
        const rows = await getDb()
          .select({
            id: results.id,
            promptId: results.promptId,
            engine: results.engine,
            status: results.status,
            error: results.error,
            creditsCharged: results.creditsCharged,
            createdAt: results.createdAt,
            completedAt: results.completedAt,
          })
          .from(results)
          .where(conditions.length > 0 ? and(...conditions) : undefined)
          .orderBy(desc(results.createdAt))
          .limit(limit);
        return text(rows);
      },
    );

    server.registerTool(
      "list_brands",
      {
        title: "List brands",
        description:
          "List the brands being looked for in answers, with their aliases and domains.",
        inputSchema: z.object({}),
      },
      async () => {
        const rows = await getDb()
          .select()
          .from(brands)
          .orderBy(asc(brands.name));
        return text(rows);
      },
    );

    server.registerTool(
      "track_brand",
      {
        title: "Track a brand",
        description:
          "Start looking for a brand in answers. Aliases are extra spellings that count as the same brand; domains decide when a link counts as citing it. Every answer already stored is re-scored against the new brand, so its history starts full rather than empty.",
        inputSchema: z.object({
          name: z.string().min(1).max(200),
          aliases: z.array(z.string().min(1).max(200)).max(50).default([]),
          domains: z.array(z.string().min(1).max(253)).max(50).default([]),
          isOwn: z.boolean().default(false),
        }),
      },
      async (input) => {
        const parsed = createBrandSchema.safeParse(input);
        if (!parsed.success) {
          return text(
            parsed.error.issues
              .map(
                (issue) =>
                  `${issue.path.join(".") || "input"}: ${issue.message}`,
              )
              .join("; "),
          );
        }

        try {
          const [created] = await getDb()
            .insert(brands)
            .values(parsed.data)
            .returning();
          const queued = await markAllForReextraction();
          return text({ brand: created, queuedForExtraction: queued });
        } catch (error) {
          if (isUniqueViolation(error)) {
            return text(`A brand named "${parsed.data.name}" already exists`);
          }
          throw error;
        }
      },
    );

    server.registerTool(
      "untrack_brand",
      {
        title: "Stop tracking a brand",
        description:
          "Delete a brand and every mention row derived for it. The raw answers are untouched.",
        inputSchema: z.object({ brandId: z.uuid() }),
      },
      async ({ brandId }) => {
        const deleted = await getDb()
          .delete(brands)
          .where(eq(brands.id, brandId))
          .returning({ id: brands.id });
        if (deleted.length === 0) return text(`Brand ${brandId} not found`);
        return text({ deleted: true });
      },
    );

    server.registerTool(
      "get_brand_visibility",
      {
        title: "Get brand visibility",
        description:
          "How often each tracked brand was named in answers, and how often its own pages were cited, over the last N days. Counts every completed run as a denominator, so a brand that was never named reports 0 rather than going missing.",
        inputSchema: z.object({
          days: z.number().int().min(1).max(365).default(30),
          engine: z.enum(ENGINES).optional(),
        }),
      },
      async ({ days, engine }) => {
        const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
        const rows = await getDb()
          .select({
            brand: brands.name,
            isOwn: brands.isOwn,
            answers: sql<number>`count(*)::int`,
            mentioned: sql<number>`count(*) filter (where ${resultBrandMentions.mentioned})::int`,
            cited: sql<number>`count(*) filter (where ${resultBrandMentions.cited})::int`,
          })
          .from(resultBrandMentions)
          .innerJoin(brands, eq(brands.id, resultBrandMentions.brandId))
          .innerJoin(results, eq(results.id, resultBrandMentions.resultId))
          .where(
            and(
              gte(results.completedAt, since),
              engine ? eq(results.engine, engine) : undefined,
            ),
          )
          .groupBy(brands.id, brands.name, brands.isOwn)
          .orderBy(
            desc(sql`count(*) filter (where ${resultBrandMentions.mentioned})`),
          );
        return text(rows);
      },
    );

    server.registerTool(
      "get_result",
      {
        title: "Get one result",
        description:
          "Fetch a single result row including the full raw engine response payload.",
        inputSchema: z.object({ resultId: z.uuid() }),
      },
      async ({ resultId }) => {
        const [row] = await getDb()
          .select()
          .from(results)
          .where(eq(results.id, resultId));
        if (!row) return text(`Result ${resultId} not found`);
        return text(row);
      },
    );
  },
  {
    serverInfo: { name: "geo-tracker", version: "0.1.0" },
  },
);

const authedHandler = (req: Request) =>
  isApiKeyAuthorized(req) ? handler(req) : Promise.resolve(unauthorized());

export { authedHandler as GET, authedHandler as POST, authedHandler as DELETE };
