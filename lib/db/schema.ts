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
  },
  (table) => [
    uniqueIndex("results_task_id_idx").on(table.taskId),
    index("results_prompt_created_idx").on(table.promptId, table.createdAt),
    index("results_created_idx").on(table.createdAt),
    index("results_pending_idx")
      .on(table.createdAt)
      .where(sql`${table.status} = 'pending'`),
  ],
);

export type Prompt = typeof prompts.$inferSelect;
export type Result = typeof results.$inferSelect;
export type NewResult = typeof results.$inferInsert;
