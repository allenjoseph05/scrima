-- Knowledge Pipeline: game_knowledge + knowledge_sync_log tables
CREATE TABLE IF NOT EXISTS "game_knowledge" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"game_id" text NOT NULL,
	"category" text NOT NULL,
	"entry_key" text NOT NULL,
	"display_name" text NOT NULL,
	"api_data" jsonb,
	"coaching_data" jsonb NOT NULL,
	"merged_data" jsonb NOT NULL,
	"source" text DEFAULT 'static' NOT NULL,
	"api_version" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_gk_game_cat_key" UNIQUE("game_id","category","entry_key")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "knowledge_sync_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"game_id" text NOT NULL,
	"sync_type" text NOT NULL,
	"status" text NOT NULL,
	"api_version" text,
	"entries_added" integer DEFAULT 0 NOT NULL,
	"entries_updated" integer DEFAULT 0 NOT NULL,
	"entries_removed" integer DEFAULT 0 NOT NULL,
	"error_msg" text,
	"duration_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_gk_game_category" ON "game_knowledge" USING btree ("game_id","category");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_ksl_game_created" ON "knowledge_sync_log" USING btree ("game_id","created_at");
