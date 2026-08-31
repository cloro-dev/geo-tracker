import { and, asc, eq, isNotNull, isNull, lt, lte, or } from "drizzle-orm";

import { fetchTask, submitTask } from "./cloro";
import { getDb } from "./db";
import { prompts, results, type NewResult, type Prompt } from "./db/schema";
import { refreshDerived, type RefreshSummary } from "./refresh";
import { webhookCallbackUrl } from "./webhooks";
import type { Engine } from "./engines";

const DAY_MS = 24 * 60 * 60 * 1000;
// Absorbs tick jitter: an hourly tick firing a few minutes late must not
// push a due prompt into the next interval.
const DUE_SLACK_MS = 5 * 60 * 1000;
// Leave young pending rows to the webhook; only poll ones it likely missed.
const SWEEP_AFTER_MS = 10 * 60 * 1000;
const SWEEP_LIMIT = 50;
const PENDING_TIMEOUT_MS = 24 * 60 * 60 * 1000;

export interface SubmittedResult {
  id: string;
  engine: string;
  taskId: string | null;
  status: "pending" | "failed";
  error: string | null;
}

/**
 * Submit one prompt to all its engines as async cloro tasks and record a
 * pending result row per engine. A failed submission (bad key, no credits)
 * is recorded immediately as a failed row.
 */
export async function submitPromptOnce(
  prompt: Prompt,
): Promise<SubmittedResult[]> {
  const db = getDb();
  const callbackUrl = webhookCallbackUrl() ?? undefined;

  const settled = await Promise.allSettled(
    prompt.engines.map((engine) =>
      submitTask(engine as Engine, prompt.prompt, prompt.country, {
        webhookUrl: callbackUrl,
      }),
    ),
  );

  const rows: NewResult[] = settled.map((outcome, index) =>
    outcome.status === "fulfilled"
      ? {
          promptId: prompt.id,
          engine: prompt.engines[index],
          taskId: outcome.value,
          status: "pending" as const,
        }
      : {
          promptId: prompt.id,
          engine: prompt.engines[index],
          status: "failed" as const,
          error:
            outcome.reason instanceof Error
              ? outcome.reason.message
              : String(outcome.reason),
          completedAt: new Date(),
        },
  );

  const inserted = await db.insert(results).values(rows).returning({
    id: results.id,
    engine: results.engine,
    taskId: results.taskId,
    status: results.status,
    error: results.error,
  });

  return inserted as SubmittedResult[];
}

export interface TickSummary {
  submitted: { promptId: string; name: string; results: SubmittedResult[] }[];
  sweep: { checked: number; updated: number; timedOut: number };
  refresh: RefreshSummary;
}

/**
 * One scheduler tick: claim and submit every due prompt, then sweep stale
 * pending rows by polling. Due-logic: a prompt with runsPerDay=N is due when
 * its last run is at least 24h/N (minus slack) old, so any external tick
 * frequency works — granularity is simply capped by how often ticks arrive.
 *
 * The derived-table refresh runs last, on purpose: it is the only step that
 * can be cut short without losing anything. Submissions are time-sensitive
 * and the sweep closes out rows the webhook missed, so if the function runs
 * out of budget it must run out here, where the leftover work is still
 * queued in a column and the next tick resumes it.
 */
export async function runTick(): Promise<TickSummary> {
  const db = getDb();
  const enabled = await db
    .select()
    .from(prompts)
    .where(eq(prompts.enabled, true))
    .orderBy(asc(prompts.lastRunAt));

  const submitted: TickSummary["submitted"] = [];
  for (const prompt of enabled) {
    const runsPerDay = Math.min(Math.max(prompt.runsPerDay, 1), 24);
    const intervalMs = DAY_MS / runsPerDay;
    const threshold = new Date(Date.now() - (intervalMs - DUE_SLACK_MS));

    // Atomic claim: set lastRunAt before submitting so overlapping ticks
    // (e.g. two cron sources) can never double-submit the same prompt.
    const claimed = await db
      .update(prompts)
      .set({ lastRunAt: new Date() })
      .where(
        and(
          eq(prompts.id, prompt.id),
          eq(prompts.enabled, true),
          or(isNull(prompts.lastRunAt), lte(prompts.lastRunAt, threshold)),
        ),
      )
      .returning();
    if (claimed.length === 0) continue;

    submitted.push({
      promptId: prompt.id,
      name: prompt.name,
      results: await submitPromptOnce(claimed[0]),
    });
  }

  const sweep = await sweepPending();
  return { submitted, sweep, refresh: await refreshDerived() };
}

/**
 * Poll cloro for pending rows old enough that their webhook has probably
 * been missed (or was never configured, e.g. local dev). Rows pending for
 * over 24h are closed out as failed.
 */
export async function sweepPending(): Promise<TickSummary["sweep"]> {
  const db = getDb();
  const staleCutoff = new Date(Date.now() - SWEEP_AFTER_MS);
  const timeoutCutoff = new Date(Date.now() - PENDING_TIMEOUT_MS);

  const stale = await db
    .select()
    .from(results)
    .where(
      and(
        eq(results.status, "pending"),
        lt(results.createdAt, staleCutoff),
        isNotNull(results.taskId),
      ),
    )
    .orderBy(asc(results.createdAt))
    .limit(SWEEP_LIMIT);

  let updated = 0;
  let timedOut = 0;
  for (const row of stale) {
    try {
      const task = await fetchTask(row.taskId!);
      if (task.status !== "pending") {
        await completeResult(row.taskId!, {
          status: task.status,
          response: task.response,
          creditsCharged: task.creditsCharged,
          error: task.status === "failed" ? "Task failed" : null,
        });
        updated += 1;
        continue;
      }
    } catch (error) {
      // Poll failure (network, task GC'd) — leave the row pending; the
      // timeout below eventually closes it out.
      console.error(`Sweep poll failed for task ${row.taskId}:`, error);
    }

    if (row.createdAt < timeoutCutoff) {
      await db
        .update(results)
        .set({
          status: "failed",
          error: "Timed out waiting for result",
          completedAt: new Date(),
        })
        .where(and(eq(results.id, row.id), eq(results.status, "pending")));
      timedOut += 1;
    }
  }

  return { checked: stale.length, updated, timedOut };
}

/**
 * Transition a pending result row to its final state. Idempotent: webhook
 * redeliveries and webhook-vs-sweep races only ever apply once. Returns
 * false when no pending row matched the task id.
 */
export async function completeResult(
  taskId: string,
  outcome: {
    status: "completed" | "failed";
    response: unknown;
    creditsCharged: number;
    error: string | null;
  },
): Promise<boolean> {
  const db = getDb();
  const updatedRows = await db
    .update(results)
    .set({
      status: outcome.status,
      response: outcome.response ?? null,
      creditsCharged: outcome.creditsCharged,
      error: outcome.error,
      completedAt: new Date(),
    })
    .where(and(eq(results.taskId, taskId), eq(results.status, "pending")))
    .returning({ id: results.id });
  return updatedRows.length > 0;
}
