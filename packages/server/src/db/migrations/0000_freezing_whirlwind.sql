CREATE TABLE "coaching_cache" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cache_key" text NOT NULL,
	"response" jsonb NOT NULL,
	"hit_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "coaching_cache_cache_key_unique" UNIQUE("cache_key")
);
--> statement-breakpoint
CREATE TABLE "coaching_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"type" text NOT NULL,
	"match_ids" uuid[] NOT NULL,
	"report" jsonb NOT NULL,
	"top_issues" jsonb NOT NULL,
	"overall_assessment" text,
	"vlm_model" text,
	"vlm_cost_usd" real,
	"tokens_input" integer,
	"tokens_output" integer,
	"processing_time_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "death_classifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"match_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"death_index" integer NOT NULL,
	"timestamp_ms" integer NOT NULL,
	"round_number" integer,
	"cause" text NOT NULL,
	"confidence" real NOT NULL,
	"brief_reason" text,
	"killer" text,
	"weapon" text,
	"headshot" boolean DEFAULT false,
	"vlm_model" text,
	"vlm_cost_usd" real,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "matches" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"game" text DEFAULT 'valorant' NOT NULL,
	"map" text,
	"agent" text,
	"rank" text,
	"game_mode" text,
	"won" boolean,
	"score_team" integer,
	"score_enemy" integer,
	"kills" integer DEFAULT 0,
	"deaths" integer DEFAULT 0,
	"assists" integer DEFAULT 0,
	"duration_ms" integer,
	"played_at" timestamp with time zone NOT NULL,
	"tier2_status" text DEFAULT 'pending' NOT NULL,
	"tier3_status" text DEFAULT 'none' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pattern_aggregations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"games_analyzed" integer NOT NULL,
	"total_deaths" integer NOT NULL,
	"cause_crosshair_pct" real DEFAULT 0,
	"cause_positioning_pct" real DEFAULT 0,
	"cause_utility_pct" real DEFAULT 0,
	"cause_decision_pct" real DEFAULT 0,
	"cause_outplayed_pct" real DEFAULT 0,
	"top_death_locations" jsonb,
	"improvement_trend" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "usage_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"operation" text NOT NULL,
	"billing_period_start" timestamp with time zone NOT NULL,
	"count" integer DEFAULT 1 NOT NULL,
	"total_cost_usd" real DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"external_auth_id" text NOT NULL,
	"email" text,
	"display_name" text,
	"avatar_url" text,
	"subscription_tier" text DEFAULT 'free' NOT NULL,
	"subscription_status" text DEFAULT 'active' NOT NULL,
	"stripe_customer_id" text,
	"stripe_subscription_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_external_auth_id_unique" UNIQUE("external_auth_id")
);
--> statement-breakpoint
ALTER TABLE "coaching_reports" ADD CONSTRAINT "coaching_reports_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "death_classifications" ADD CONSTRAINT "death_classifications_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "death_classifications" ADD CONSTRAINT "death_classifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matches" ADD CONSTRAINT "matches_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pattern_aggregations" ADD CONSTRAINT "pattern_aggregations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_records" ADD CONSTRAINT "usage_records_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_cache_key" ON "coaching_cache" USING btree ("cache_key");--> statement-breakpoint
CREATE INDEX "idx_cr_user_created" ON "coaching_reports" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_dc_user_cause" ON "death_classifications" USING btree ("user_id","cause");--> statement-breakpoint
CREATE INDEX "idx_dc_match" ON "death_classifications" USING btree ("match_id");--> statement-breakpoint
CREATE INDEX "idx_matches_user_played" ON "matches" USING btree ("user_id","played_at");--> statement-breakpoint
CREATE INDEX "idx_pa_user_period" ON "pattern_aggregations" USING btree ("user_id","period_end");--> statement-breakpoint
CREATE INDEX "idx_usage_user_period" ON "usage_records" USING btree ("user_id","billing_period_start");