import { and, asc, eq, isNull, ne, or, sql } from "drizzle-orm";

import { getDb } from "./db";
import {
  brands,
  resultBrandMentions,
  results,
  resultSources,
  type Brand,
  type NewResultBrandMention,
  type NewResultSource,
} from "./db/schema";
import { EXTRACTION_REVISION, extractResult } from "./extract";

/**
 * Derives `result_sources` and `result_brand_mentions` from finished
 * results, a batch at a time, from inside the scheduler tick.
 *
 * This is the "materialised view" for a deployment that has nowhere to run
 * one. Neon's free tier has no `pg_cron`, so there is no scheduler in the
 * database to refresh anything; the one Vercel Cron job is the only clock
 * this app owns. Doing the work here keeps the free tier genuinely free.
 */

// Bounded so a backlog cannot run the tick past Vercel's function timeout.
// Extraction is CPU and database only — no scrape is ever awaited — so a
// batch is fast; the cap is here for the first tick after an import, when
// the backlog is every result at once.
const BATCH_SIZE = 250;
// Leaves room in a 60s function for the submissions and the sweep that ran
// before this. A batch that runs out of budget simply resumes next tick:
// the queue is a column, not an in-memory cursor.
const TIME_BUDGET_MS = 20_000;

export interface RefreshSummary {
  /** Results whose derived rows were rebuilt this tick. */
  extracted: number;
  /** Links written across those results. */
  sources: number;
  /** True when the budget or the batch cap stopped us short of the queue. */
  more: boolean;
  /** Skipped entirely, with nothing written, when no brand is configured. */
  skipped: boolean;
}

/**
 * The brand fields the extractor actually reads.
 *
 * `isOwn` is absent on purpose: it labels a brand as yours for the panels,
 * and the extractor treats every brand identically, so flipping it changes
 * no derived row. Re-deriving the whole history for a cosmetic edit would
 * be pure waste.
 */
const EXTRACTION_INPUTS = ["name", "aliases", "domains", "enabled"] as const;

/** Whether a brand edit changes what the extractor would produce. */
export function affectsExtraction(changed: Record<string, unknown>): boolean {
  return EXTRACTION_INPUTS.some((field) => field in changed);
}

/**
 * Queue every completed result for re-extraction.
 *
 * Call this after any change to the brand list. A brand's mentions are
 * computed against the whole history, not just answers that arrive next,
 * so adding a competitor has to reopen the past — otherwise its chart
 * starts at the day someone remembered to add it, which reads as a brand
 * that suddenly appeared.
 */
export async function markAllForReextraction(): Promise<number> {
  const db = getDb();
  const updated = await db
    .update(results)
    .set({ extractionRevision: null })
    .where(eq(results.status, "completed"))
    .returning({ id: results.id });
  return updated.length;
}

/**
 * Rebuild the derived rows for one result inside a transaction.
 *
 * Delete-then-insert rather than upsert: the extractor's output for a
 * result is a whole set, and a source that disappears between revisions
 * has to disappear from the table too. Upserting would leave it behind
 * with no way to tell it from a current row.
 */
async function extractOne(
  db: ReturnType<typeof getDb>,
  row: { id: string; response: unknown },
  brandList: Brand[],
): Promise<number> {
  const { sources, mentions } = extractResult(row.response, brandList);

  await db.transaction(async (tx) => {
    await tx.delete(resultSources).where(eq(resultSources.resultId, row.id));
    await tx
      .delete(resultBrandMentions)
      .where(eq(resultBrandMentions.resultId, row.id));

    if (sources.length > 0) {
      const sourceRows: NewResultSource[] = sources.map((source) => ({
        resultId: row.id,
        kind: source.kind,
        position: source.position,
        url: source.url,
        domain: source.domain,
        label: source.label,
      }));
      await tx.insert(resultSources).values(sourceRows);
    }

    if (mentions.length > 0) {
      const mentionRows: NewResultBrandMention[] = mentions.map((mention) => ({
        resultId: row.id,
        brandId: mention.brandId,
        mentioned: mention.mentioned,
        mentionCount: mention.mentionCount,
        firstPosition: mention.firstPosition,
        cited: mention.cited,
        citedSourceCount: mention.citedSourceCount,
      }));
      await tx.insert(resultBrandMentions).values(mentionRows);
    }

    // Inside the transaction: a crash between writing the rows and marking
    // the result would otherwise leave it looking extracted when it is
    // half-written, and nothing would ever revisit it.
    await tx
      .update(results)
      .set({ extractionRevision: EXTRACTION_REVISION })
      .where(eq(results.id, row.id));
  });

  return sources.length;
}

/**
 * One refresh pass: extract up to a batch of results that are finished but
 * not yet derived at the current revision.
 */
export async function refreshDerived(
  options: { now?: () => number } = {},
): Promise<RefreshSummary> {
  const db = getDb();
  const now = options.now ?? Date.now;
  const startedAt = now();

  const brandList = await db
    .select()
    .from(brands)
    .where(eq(brands.enabled, true));

  // No brands, no extraction — not even the sources. Deriving links for a
  // deployment that has configured nothing would fill a table nobody is
  // reading and mark the results done, so adding the first brand later
  // would need a full re-extraction to notice them.
  if (brandList.length === 0) {
    return { extracted: 0, sources: 0, more: false, skipped: true };
  }

  const pending = await db
    .select({ id: results.id, response: results.response })
    .from(results)
    .where(
      and(
        eq(results.status, "completed"),
        or(
          isNull(results.extractionRevision),
          ne(results.extractionRevision, EXTRACTION_REVISION),
        ),
      ),
    )
    .orderBy(asc(results.completedAt))
    .limit(BATCH_SIZE);

  let extracted = 0;
  let sources = 0;
  for (const row of pending) {
    // `extracted > 0` guarantees forward progress. Without it a tick whose
    // submissions already ate the budget extracts nothing, and a deployment
    // with a slow tick never derives a single row — the queue would look
    // busy forever while staying exactly the same size.
    if (extracted > 0 && now() - startedAt > TIME_BUDGET_MS) {
      return { extracted, sources, more: true, skipped: false };
    }
    sources += await extractOne(db, row, brandList);
    extracted += 1;
  }

  return {
    extracted,
    sources,
    more: pending.length === BATCH_SIZE,
    skipped: false,
  };
}

/**
 * Rows that no longer have a parent result, for a deployment that pruned
 * old results by hand. The foreign keys cascade, so this is only ever a
 * safety net; it exists because a silently growing derived table is the
 * classic way a free-tier database fills up.
 */
export async function countDerived(): Promise<{
  sources: number;
  mentions: number;
}> {
  const db = getDb();
  const [sourceCount] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(resultSources);
  const [mentionCount] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(resultBrandMentions);
  return { sources: sourceCount.count, mentions: mentionCount.count };
}
