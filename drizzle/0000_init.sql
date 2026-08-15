CREATE TABLE "prompts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"prompt" text NOT NULL,
	"engines" text[] NOT NULL,
	"country" text DEFAULT 'US' NOT NULL,
	"runs_per_day" integer DEFAULT 1 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_run_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"prompt_id" uuid NOT NULL,
	"engine" text NOT NULL,
	"task_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"response" jsonb,
	"error" text,
	"credits_charged" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "results" ADD CONSTRAINT "results_prompt_id_prompts_id_fk" FOREIGN KEY ("prompt_id") REFERENCES "public"."prompts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "results_task_id_idx" ON "results" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "results_prompt_created_idx" ON "results" USING btree ("prompt_id","created_at");--> statement-breakpoint
CREATE INDEX "results_created_idx" ON "results" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "results_pending_idx" ON "results" USING btree ("created_at") WHERE "results"."status" = 'pending';