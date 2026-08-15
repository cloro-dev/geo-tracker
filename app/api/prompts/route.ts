import { desc } from "drizzle-orm";

import { isApiKeyAuthorized, unauthorized } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { prompts } from "@/lib/db/schema";
import { parseOr400, withErrors } from "@/lib/http";
import { createPromptSchema } from "@/lib/validation";

export const runtime = "nodejs";

export const GET = withErrors(async (req) => {
  if (!isApiKeyAuthorized(req)) return unauthorized();
  const db = getDb();
  const rows = await db.select().from(prompts).orderBy(desc(prompts.createdAt));
  return Response.json({ prompts: rows });
});

export const POST = withErrors(async (req) => {
  if (!isApiKeyAuthorized(req)) return unauthorized();
  const input = parseOr400(
    createPromptSchema,
    await req.json().catch(() => null),
  );
  const db = getDb();
  const [created] = await db.insert(prompts).values(input).returning();
  return Response.json({ prompt: created }, { status: 201 });
});
