import { eq } from "drizzle-orm";

import { isApiKeyAuthorized, unauthorized } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { prompts } from "@/lib/db/schema";
import { HttpError, withErrors } from "@/lib/http";
import { submitPromptOnce } from "@/lib/runner";
import { idSchema } from "@/lib/validation";

export const runtime = "nodejs";

/**
 * Run a prompt now, regardless of schedule. Tasks are submitted
 * asynchronously — the returned rows are pending until cloro delivers the
 * results (webhook or cron sweep).
 */
export const POST = withErrors(async (req, { params }) => {
  if (!isApiKeyAuthorized(req)) return unauthorized();
  const parsedId = idSchema.safeParse((await params).id);
  if (!parsedId.success) throw new HttpError(400, "Invalid prompt id");

  const db = getDb();
  const [claimed] = await db
    .update(prompts)
    .set({ lastRunAt: new Date() })
    .where(eq(prompts.id, parsedId.data))
    .returning();
  if (!claimed) throw new HttpError(404, "Prompt not found");

  const results = await submitPromptOnce(claimed);
  return Response.json({ promptId: claimed.id, results }, { status: 202 });
});
