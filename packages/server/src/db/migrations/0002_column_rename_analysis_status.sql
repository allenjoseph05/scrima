ALTER TABLE "matches" RENAME COLUMN "tier2_status" TO "analysis_status";--> statement-breakpoint
ALTER TABLE "matches" DROP COLUMN "tier3_status";--> statement-breakpoint
ALTER TABLE "matches" ALTER COLUMN "analysis_status" SET DEFAULT 'none';
