CREATE TABLE "coaching_credits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"month" text NOT NULL,
	"credits_total" integer NOT NULL,
	"credits_used" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_credits_user_month" UNIQUE("user_id","month")
);
--> statement-breakpoint
CREATE TABLE "coaching_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"report_id" uuid,
	"match_id" uuid NOT NULL,
	"bull_job_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"error_msg" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "weekly_coaching_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"week_start" text NOT NULL,
	"week_end" text NOT NULL,
	"status" text DEFAULT 'awaiting_uploads' NOT NULL,
	"games_played" integer DEFAULT 0 NOT NULL,
	"games_analyzed_deep" integer DEFAULT 0 NOT NULL,
	"total_deaths" integer DEFAULT 0 NOT NULL,
	"selected_match_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"pattern_breakdown" jsonb,
	"top_moments" jsonb,
	"positive_highlights" jsonb,
	"assessment" jsonb,
	"drills" jsonb,
	"progress_chart" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_weekly_user_week" UNIQUE("user_id","week_start")
);
--> statement-breakpoint
ALTER TABLE "coaching_reports" ALTER COLUMN "report" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "coaching_reports" ALTER COLUMN "top_issues" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "coaching_reports" ADD COLUMN "trigger" text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "coaching_reports" ADD COLUMN "status" text DEFAULT 'completed' NOT NULL;--> statement-breakpoint
ALTER TABLE "coaching_reports" ADD COLUMN "completed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "coaching_credits" ADD CONSTRAINT "coaching_credits_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coaching_jobs" ADD CONSTRAINT "coaching_jobs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coaching_jobs" ADD CONSTRAINT "coaching_jobs_report_id_coaching_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."coaching_reports"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coaching_jobs" ADD CONSTRAINT "coaching_jobs_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weekly_coaching_reports" ADD CONSTRAINT "weekly_coaching_reports_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_cj_user_status" ON "coaching_jobs" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "idx_cj_pending" ON "coaching_jobs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_wcr_user" ON "weekly_coaching_reports" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_cr_status" ON "coaching_reports" USING btree ("status");