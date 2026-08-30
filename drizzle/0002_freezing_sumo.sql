CREATE TABLE "result_candidate_mentions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"result_id" uuid NOT NULL,
	"name" text NOT NULL,
	"mention_count" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "result_search_queries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"result_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"position" integer,
	"query" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "result_candidate_mentions" ADD CONSTRAINT "result_candidate_mentions_result_id_results_id_fk" FOREIGN KEY ("result_id") REFERENCES "public"."results"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "result_search_queries" ADD CONSTRAINT "result_search_queries_result_id_results_id_fk" FOREIGN KEY ("result_id") REFERENCES "public"."results"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "result_candidate_mentions_result_name_idx" ON "result_candidate_mentions" USING btree ("result_id","name");--> statement-breakpoint
CREATE INDEX "result_candidate_mentions_name_idx" ON "result_candidate_mentions" USING btree ("name");--> statement-breakpoint
CREATE INDEX "result_search_queries_result_idx" ON "result_search_queries" USING btree ("result_id");--> statement-breakpoint
CREATE INDEX "result_search_queries_kind_idx" ON "result_search_queries" USING btree ("kind");