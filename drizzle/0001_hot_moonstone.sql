CREATE TABLE "brands" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"aliases" text[] DEFAULT '{}'::text[] NOT NULL,
	"domains" text[] DEFAULT '{}'::text[] NOT NULL,
	"is_own" boolean DEFAULT false NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "result_brand_mentions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"result_id" uuid NOT NULL,
	"brand_id" uuid NOT NULL,
	"mentioned" boolean NOT NULL,
	"mention_count" integer DEFAULT 0 NOT NULL,
	"first_position" integer,
	"cited" boolean DEFAULT false NOT NULL,
	"cited_source_count" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "result_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"result_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"position" integer,
	"url" text NOT NULL,
	"domain" text NOT NULL,
	"label" text
);
--> statement-breakpoint
ALTER TABLE "results" ADD COLUMN "extraction_revision" integer;--> statement-breakpoint
ALTER TABLE "result_brand_mentions" ADD CONSTRAINT "result_brand_mentions_result_id_results_id_fk" FOREIGN KEY ("result_id") REFERENCES "public"."results"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "result_brand_mentions" ADD CONSTRAINT "result_brand_mentions_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "result_sources" ADD CONSTRAINT "result_sources_result_id_results_id_fk" FOREIGN KEY ("result_id") REFERENCES "public"."results"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "brands_name_idx" ON "brands" USING btree (lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "result_brand_mentions_result_brand_idx" ON "result_brand_mentions" USING btree ("result_id","brand_id");--> statement-breakpoint
CREATE INDEX "result_brand_mentions_brand_idx" ON "result_brand_mentions" USING btree ("brand_id");--> statement-breakpoint
CREATE INDEX "result_sources_result_idx" ON "result_sources" USING btree ("result_id");--> statement-breakpoint
CREATE INDEX "result_sources_domain_idx" ON "result_sources" USING btree ("domain","kind");--> statement-breakpoint
CREATE INDEX "results_unextracted_idx" ON "results" USING btree ("completed_at") WHERE "results"."status" = 'completed';