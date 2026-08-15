import { isCronAuthorized, unauthorized } from "@/lib/auth";
import { withErrors } from "@/lib/http";
import { runTick } from "@/lib/runner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Submissions and sweep polls are quick API calls — no scrape is ever
// awaited here. 60s covers many prompts per tick.
export const maxDuration = 60;

/**
 * Scheduler tick: submits every due prompt as async cloro tasks and sweeps
 * stale pending results. Safe to call as often as you like — due-logic and
 * atomic claims make it idempotent. Vercel Cron hits this daily by default;
 * point any external scheduler (GitHub Actions, cron-job.org) at it for
 * more runs per day.
 */
export const GET = withErrors(async (req) => {
  if (!isCronAuthorized(req)) return unauthorized();
  const summary = await runTick();
  return Response.json(summary);
});
