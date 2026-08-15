import { timingSafeEqual } from "node:crypto";

import { env } from "./env";

function bearerToken(req: Request): string | null {
  const header = req.headers.get("authorization");
  if (!header?.startsWith("Bearer ")) return null;
  return header.slice("Bearer ".length);
}

function tokenEquals(token: string | null, expected: string): boolean {
  if (!token) return false;
  const a = Buffer.from(token);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** REST + MCP auth: `Authorization: Bearer <APP_API_KEY>`. */
export function isApiKeyAuthorized(req: Request): boolean {
  return tokenEquals(bearerToken(req), env.appApiKey);
}

/**
 * Cron auth: Vercel Cron sends `Authorization: Bearer <CRON_SECRET>`
 * automatically; the deployer's APP_API_KEY is accepted too so a tick can
 * be triggered manually.
 */
export function isCronAuthorized(req: Request): boolean {
  const token = bearerToken(req);
  return (
    tokenEquals(token, env.cronSecret) || tokenEquals(token, env.appApiKey)
  );
}

export function unauthorized(): Response {
  return Response.json({ error: { message: "Unauthorized" } }, { status: 401 });
}
