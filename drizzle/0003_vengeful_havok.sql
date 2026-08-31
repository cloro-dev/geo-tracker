CREATE TABLE "extraction_state" (
	"id" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"stamp" integer NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "results_unextracted_idx";--> statement-breakpoint
CREATE INDEX "results_unextracted_idx" ON "results" USING btree ("completed_at") WHERE "results"."status" = 'completed' AND "results"."extraction_revision" IS NULL;