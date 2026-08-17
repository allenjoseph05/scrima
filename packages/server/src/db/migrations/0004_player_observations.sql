-- Player Observations: pgvector-backed semantic memory for coaching
-- Stores text observations per player with 768-dim embeddings for semantic search.
-- Requires pgvector extension (available on Neon).

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS "player_observations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "report_id" uuid REFERENCES "coaching_reports"("id") ON DELETE SET NULL,
  "category" text NOT NULL,
  "text" text NOT NULL,
  "embedding" vector(768) NOT NULL,
  "occurrences" integer DEFAULT 1 NOT NULL,
  "last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
  "archived" boolean DEFAULT false NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "idx_po_user_category" ON "player_observations" ("user_id", "category");
CREATE INDEX IF NOT EXISTS "idx_po_user_active" ON "player_observations" ("user_id", "archived");
CREATE INDEX IF NOT EXISTS "idx_po_embedding_hnsw" ON "player_observations" USING hnsw ("embedding" vector_cosine_ops);
