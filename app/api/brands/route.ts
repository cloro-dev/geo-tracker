import { asc } from "drizzle-orm";

import { isApiKeyAuthorized, unauthorized } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { brands } from "@/lib/db/schema";
import {
  HttpError,
  isUniqueViolation,
  parseOr400,
  withErrors,
} from "@/lib/http";
import { markAllForReextraction } from "@/lib/refresh";
import { createBrandSchema } from "@/lib/validation";

export const runtime = "nodejs";

export const GET = withErrors(async (req) => {
  if (!isApiKeyAuthorized(req)) return unauthorized();
  const db = getDb();
  const rows = await db.select().from(brands).orderBy(asc(brands.name));
  return Response.json({ brands: rows });
});

export const POST = withErrors(async (req) => {
  if (!isApiKeyAuthorized(req)) return unauthorized();
  const input = parseOr400(
    createBrandSchema,
    await req.json().catch(() => null),
  );

  const db = getDb();
  let created;
  try {
    [created] = await db.insert(brands).values(input).returning();
  } catch (error) {
    // The unique index is on lower(name), so "Acme" and "acme" collide.
    // That is deliberate — they are one brand — but the raw driver error
    // does not say so.
    if (isUniqueViolation(error)) {
      throw new HttpError(409, `A brand named "${input.name}" already exists`);
    }
    throw error;
  }

  // A new brand has to be scored against answers that already arrived, not
  // only the ones still to come. Without this its chart would begin on the
  // day somebody remembered to add it, which reads as a brand that appeared
  // out of nowhere rather than one we started watching late.
  const queued = await markAllForReextraction();

  return Response.json(
    { brand: created, queuedForExtraction: queued },
    { status: 201 },
  );
});
