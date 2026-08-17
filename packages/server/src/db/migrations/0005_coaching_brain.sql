-- Coaching Brain: Skill mastery tracking, knowledge graph, coaching strategies
-- Foundation for the cognitive coaching architecture.

-- ── Player Skill Mastery (BKT per skill per user) ───────────────────────────

CREATE TABLE IF NOT EXISTS "player_skill_mastery" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "skill_id" text NOT NULL,
  "domain" text NOT NULL,
  "p_mastery" real DEFAULT 0.3 NOT NULL,
  "p_transit" real DEFAULT 0.1 NOT NULL,
  "p_slip" real DEFAULT 0.1 NOT NULL,
  "p_guess" real DEFAULT 0.2 NOT NULL,
  "observations" integer DEFAULT 0 NOT NULL,
  "last_observed_at" timestamp with time zone,
  "trend" text DEFAULT 'stable' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  UNIQUE("user_id", "skill_id")
);

CREATE INDEX IF NOT EXISTS "idx_psm_user" ON "player_skill_mastery" ("user_id");
CREATE INDEX IF NOT EXISTS "idx_psm_user_domain" ON "player_skill_mastery" ("user_id", "domain");

-- ── Coaching Graph Nodes ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "coaching_graph_nodes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "node_type" text NOT NULL,
  "label" text NOT NULL,
  "data" jsonb DEFAULT '{}' NOT NULL,
  "embedding" vector(768),
  "importance" real DEFAULT 0.5 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_accessed_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "idx_cgn_user_type" ON "coaching_graph_nodes" ("user_id", "node_type");
CREATE INDEX IF NOT EXISTS "idx_cgn_user_importance" ON "coaching_graph_nodes" ("user_id", "importance");

-- ── Coaching Graph Edges ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "coaching_graph_edges" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "source_id" uuid NOT NULL REFERENCES "coaching_graph_nodes"("id") ON DELETE CASCADE,
  "target_id" uuid NOT NULL REFERENCES "coaching_graph_nodes"("id") ON DELETE CASCADE,
  "edge_type" text NOT NULL,
  "weight" real DEFAULT 1.0 NOT NULL,
  "data" jsonb DEFAULT '{}' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "idx_cge_source" ON "coaching_graph_edges" ("source_id");
CREATE INDEX IF NOT EXISTS "idx_cge_target" ON "coaching_graph_edges" ("target_id");
CREATE INDEX IF NOT EXISTS "idx_cge_type" ON "coaching_graph_edges" ("edge_type");

-- ── Coaching Strategies (what advice works per player) ──────────────────────

CREATE TABLE IF NOT EXISTS "coaching_strategies" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "strategy_type" text NOT NULL,
  "description" text NOT NULL,
  "q_value" real DEFAULT 0.5 NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "successes" integer DEFAULT 0 NOT NULL,
  "last_used_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  UNIQUE("user_id", "strategy_type", "description")
);

CREATE INDEX IF NOT EXISTS "idx_cs_user" ON "coaching_strategies" ("user_id");
