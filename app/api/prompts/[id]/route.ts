import { eq } from "drizzle-orm";

import { isApiKeyAuthorized, unauthorized } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { prompts } from "@/lib/db/schema";
import { HttpError, parseOr400, withErrors } from "@/lib/http";
import { idSchema, updatePromptSchema } from "@/lib/validation";

export const runtime = "nodejs";

function parseId(id: string): string {
  const parsed = idSchema.safeParse(id);
  if (!parsed.success) throw new HttpError(400, "Invalid prompt id");
  return parsed.data;
}

export const GET = withErrors(async (req, { params }) => {
  if (!isApiKeyAuthorized(req)) return unauthorized();
  const id = parseId((await params).id);
  const db = getDb();
  const [row] = await db.select().from(prompts).where(eq(prompts.id, id));
  if (!row) throw new HttpError(404, "Prompt not found");
  return Response.json({ prompt: row });
});

export const PATCH = withErrors(async (req, { params }) => {
  if (!isApiKeyAuthorized(req)) return unauthorized();
  const id = parseId((await params).id);
  const input = parseOr400(
    updatePromptSchema,
    await req.json().catch(() => null),
  );
  const db = getDb();
  const [updated] = await db
    .update(prompts)
    .set(input)
    .where(eq(prompts.id, id))
    .returning();
  if (!updated) throw new HttpError(404, "Prompt not found");
  return Response.json({ prompt: updated });
});

export const DELETE = withErrors(async (req, { params }) => {
  if (!isApiKeyAuthorized(req)) return unauthorized();
  const id = parseId((await params).id);
  const db = getDb();
  const deleted = await db
    .delete(prompts)
    .where(eq(prompts.id, id))
    .returning({ id: prompts.id });
  if (deleted.length === 0) throw new HttpError(404, "Prompt not found");
  return Response.json({ deleted: true });
});
