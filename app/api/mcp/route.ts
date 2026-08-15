import { and, desc, eq } from "drizzle-orm";
import { createMcpHandler } from "mcp-handler";
import { z } from "zod";

import { isApiKeyAuthorized, unauthorized } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { prompts, results } from "@/lib/db/schema";
import { ENGINES } from "@/lib/engines";
import { submitPromptOnce } from "@/lib/runner";

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
