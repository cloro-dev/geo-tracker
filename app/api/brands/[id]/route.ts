import { eq } from "drizzle-orm";

import { isApiKeyAuthorized, unauthorized } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { brands } from "@/lib/db/schema";
import {
  HttpError,
  isUniqueViolation,
  parseOr400,
  withErrors,
} from "@/lib/http";
import { affectsExtraction, markAllForReextraction } from "@/lib/refresh";
import { idSchema, updateBrandSchema } from "@/lib/validation";

export const runtime = "nodejs";

function parseId(id: string): string {
  const parsed = idSchema.safeParse(id);
  if (!parsed.success) throw new HttpError(400, "Invalid brand id");
  return parsed.data;
}

export const GET = withErrors(async (req, { params }) => {
  if (!isApiKeyAuthorized(req)) return unauthorized();
  const id = parseId((await params).id);
  const db = getDb();
  const [row] = await db.select().from(brands).where(eq(brands.id, id));
  if (!row) throw new HttpError(404, "Brand not found");
  return Response.json({ brand: row });
});

export const PATCH = withErrors(async (req, { params }) => {
  if (!isApiKeyAuthorized(req)) return unauthorized();
  const id = parseId((await params).id);
  const input = parseOr400(
    updateBrandSchema,
    await req.json().catch(() => null),
  );

  const db = getDb();
  let updated;
  try {
    [updated] = await db
      .update(brands)
      .set(input)
      .where(eq(brands.id, id))
      .returning();
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new HttpError(409, `A brand named "${input.name}" already exists`);
    }
    throw error;
  }
  if (!updated) throw new HttpError(404, "Brand not found");

  // Only re-derive when the edit changes what the extractor reads. Renaming
  // a brand or adding an alias rewrites its whole history; flipping `isOwn`
  // changes a label the extractor never looks at.
  const queued = affectsExtraction(input) ? await markAllForReextraction() : 0;

  return Response.json({ brand: updated, queuedForExtraction: queued });
});

export const DELETE = withErrors(async (req, { params }) => {
  if (!isApiKeyAuthorized(req)) return unauthorized();
  const id = parseId((await params).id);
  const db = getDb();
  const deleted = await db
    .delete(brands)
    .where(eq(brands.id, id))
    .returning({ id: brands.id });
  if (deleted.length === 0) throw new HttpError(404, "Brand not found");

  // No re-extraction: the foreign key cascades this brand's mention rows
  // away, and no other brand's rows depend on it. Deleting is the one brand
  // change that costs nothing.
  return Response.json({ deleted: true });
});
