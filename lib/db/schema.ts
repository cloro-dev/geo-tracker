import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const prompts = pgTable("prompts", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  prompt: text("prompt").notNull(),
  engines: text("engines").array().notNull(),
  country: text("country").notNull().default("US"),
  runsPerDay: integer("runs_per_day").notNull().default(1),
  enabled: boolean("enabled").notNull().default(true),
  lastRunAt: timestamp("last_run_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const results = pgTable(
  "results",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    promptId: uuid("prompt_id")
      .notNull()
      .references(() => prompts.id, { onDelete: "cascade" }),
    engine: text("engine").notNull(),
    // cloro async task id — correlates webhook deliveries and poll sweeps.
    // Null when the submission itself failed.
    taskId: text("task_id"),
    status: text("status", { enum: ["pending", "completed", "failed"] })
      .notNull()
      .default("pending"),
    response: jsonb("response"),
    error: text("error"),
    creditsCharged: integer("credits_charged").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    // Which version of the extractor last derived sources and brand
    // mentions from this row. Null means never. Bumping EXTRACTION_REVISION
    // (or clearing this column, as a brand-list edit does) is what makes the
    // cron pick a finished result up again.
    extractionRevision: integer("extraction_revision"),
  },
  (table) => [
    uniqueIndex("results_task_id_idx").on(table.taskId),
    index("results_prompt_created_idx").on(table.promptId, table.createdAt),
    index("results_created_idx").on(table.createdAt),
    index("results_pending_idx")
      .on(table.createdAt)
      .where(sql`${table.status} = 'pending'`),
    // The refresh queue, and it really is a queue: the predicate matches
    // only rows still waiting, so a caught-up deployment has an EMPTY
    // index and the tick's queue scan costs nothing.
    //
    // This works only because "needs extraction" is `IS NULL` rather than
    // "stamp differs from the current one". A `<>` against a value the
    // index cannot know is not sargable, and Postgres answered it with a
    // sequential scan of every completed row, every tick, forever.
    index("results_unextracted_idx")
      .on(table.completedAt)
      .where(
        sql`${table.status} = 'completed' AND ${table.extractionRevision} IS NULL`,
      ),
  ],
);

export type Prompt = typeof prompts.$inferSelect;
export type Result = typeof results.$inferSelect;
export type NewResult = typeof results.$inferInsert;

/**
 * Brands to look for in answers. User-configured: geo-tracker ships no
 * brand list and makes no judgement about who competes with whom. The
 * extractor only does literal, case-insensitive matching of the names and
 * aliases declared here.
 */
export const brands = pgTable(
  "brands",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    // Extra spellings that count as the same brand ("Acme Corp", "acme.io").
    aliases: text("aliases")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    // Domains that count as this brand being cited, not just named.
    domains: text("domains")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    // Your own brand vs the rest. Drives the "us vs them" panels; purely a
    // label, the extractor treats every brand identically.
    isOwn: boolean("is_own").notNull().default(false),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [uniqueIndex("brands_name_idx").on(sql`lower(${table.name})`)],
);

/**
 * One row per link an engine returned, flattened out of `results.response`.
 *
 * Derived data: every row is reproducible from the raw response, and the
 * refresh rebuilds a result's rows wholesale rather than patching them.
 */
export const resultSources = pgTable(
  "result_sources",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    resultId: uuid("result_id")
      .notNull()
      .references(() => results.id, { onDelete: "cascade" }),
    // Where in the payload the link came from: sources, citation_pill,
    // organic, news, ad, video, people_also_ask. Kept because a citation
    // and an ad are not the same evidence, and no panel should pool them.
    kind: text("kind").notNull(),
    position: integer("position"),
    url: text("url").notNull(),
    // Registrable-ish host, lowercased and stripped of "www.". Denormalised
    // so panels can GROUP BY it without parsing URLs in SQL.
    domain: text("domain").notNull(),
    label: text("label"),
  },
  (table) => [
    index("result_sources_result_idx").on(table.resultId),
    index("result_sources_domain_idx").on(table.domain, table.kind),
  ],
);

/**
 * One row per (completed result × enabled brand) — including the brands
 * that were NOT mentioned.
 *
 * The absent rows are the point: "share of voice" needs a denominator, and
 * a table that only holds hits cannot tell "never named" apart from "never
 * asked". Panels count rows, not nulls.
 */
export const resultBrandMentions = pgTable(
  "result_brand_mentions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    resultId: uuid("result_id")
      .notNull()
      .references(() => results.id, { onDelete: "cascade" }),
    brandId: uuid("brand_id")
      .notNull()
      .references(() => brands.id, { onDelete: "cascade" }),
    mentioned: boolean("mentioned").notNull(),
    mentionCount: integer("mention_count").notNull().default(0),
    // Character offset of the first mention in the answer text. Null when
    // absent. A rank would be more useful and is not honest here: engines
    // return prose, not a numbered list, so "first named" is the strongest
    // claim the text supports.
    firstPosition: integer("first_position"),
    // A brand domain appeared in the links, whether or not the prose named
    // it. Being cited and being named are different outcomes.
    cited: boolean("cited").notNull().default(false),
    citedSourceCount: integer("cited_source_count").notNull().default(0),
  },
  (table) => [
    uniqueIndex("result_brand_mentions_result_brand_idx").on(
      table.resultId,
      table.brandId,
    ),
    index("result_brand_mentions_brand_idx").on(table.brandId),
  ],
);

/**
 * One row, holding the extraction stamp the stored rows were built at.
 *
 * The tick compares this to the current stamp and, when they differ,
 * clears `results.extraction_revision` in one statement. That is what lets
 * the queue be an `IS NULL` test — a sargable one — instead of a
 * comparison against a constant no index can hold.
 */
export const extractionState = pgTable("extraction_state", {
  // A single row, pinned: `true` is the only value the check allows.
  id: boolean("id").primaryKey().default(true),
  stamp: integer("stamp").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type ExtractionState = typeof extractionState.$inferSelect;

export type Brand = typeof brands.$inferSelect;
export type NewBrand = typeof brands.$inferInsert;
export type ResultSource = typeof resultSources.$inferSelect;
export type NewResultSource = typeof resultSources.$inferInsert;
export type ResultBrandMention = typeof resultBrandMentions.$inferSelect;
export type NewResultBrandMention = typeof resultBrandMentions.$inferInsert;

/**
 * The literal queries an engine typed, flattened out of the payload.
 *
 * A stage upstream of every other derived table: `result_brand_mentions`
 * records that a brand was named and `result_sources` that a page was
 * retrieved; this is what the model searched for before either happened.
 * It does not search your prompt — it rewrites the prompt, often with a
 * vendor list already attached.
 */
export const resultSearchQueries = pgTable(
  "result_search_queries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    resultId: uuid("result_id")
      .notNull()
      .references(() => results.id, { onDelete: "cascade" }),
    // `issued` is what the model actually searched. `suggested` is the
    // follow-up chips it offered the reader. Kept apart because they are
    // different acts: one is the engine's own reasoning, the other is
    // navigation furniture, and pooling them would misread the first.
    kind: text("kind").notNull(),
    position: integer("position"),
    query: text("query").notNull(),
  },
  (table) => [
    index("result_search_queries_result_idx").on(table.resultId),
    index("result_search_queries_kind_idx").on(table.kind),
  ],
);

/**
 * Names from `lib/brand-candidates.json` that an answer mentioned.
 *
 * Separate from `result_brand_mentions` because these are not tracked
 * brands: there is no denominator to hold, no citation to check, and a
 * candidate that never appears needs no row. This table only ever says
 * "this name was named this often", which is the evidence for deciding
 * whether to promote it into `brands`.
 */
export const resultCandidateMentions = pgTable(
  "result_candidate_mentions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    resultId: uuid("result_id")
      .notNull()
      .references(() => results.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    mentionCount: integer("mention_count").notNull(),
  },
  (table) => [
    uniqueIndex("result_candidate_mentions_result_name_idx").on(
      table.resultId,
      table.name,
    ),
    index("result_candidate_mentions_name_idx").on(table.name),
  ],
);

export type ResultSearchQuery = typeof resultSearchQueries.$inferSelect;
export type NewResultSearchQuery = typeof resultSearchQueries.$inferInsert;
export type ResultCandidateMention =
  typeof resultCandidateMentions.$inferSelect;
export type NewResultCandidateMention =
  typeof resultCandidateMentions.$inferInsert;
