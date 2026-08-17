import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
  unique,
  uuid,
  vector,
} from 'drizzle-orm/pg-core';

// ── Users ─────────────────────────────────────────────────────────────────────

export const users = pgTable('users', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  externalAuthId: text('external_auth_id').unique().notNull(),
  email: text('email'),
  displayName: text('display_name'),
  avatarUrl: text('avatar_url'),
  subscriptionTier: text('subscription_tier').notNull().default('free'),
  subscriptionStatus: text('subscription_status').notNull().default('active'),
  stripeCustomerId: text('stripe_customer_id'),
  stripeSubscriptionId: text('stripe_subscription_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ── Matches ───────────────────────────────────────────────────────────────────

export const matches = pgTable(
  'matches',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    game: text('game').notNull().default('valorant'),
    map: text('map'),
    agent: text('agent'),
    rank: text('rank'),
    gameMode: text('game_mode'),
    won: boolean('won'),
    scoreTeam: integer('score_team'),
    scoreEnemy: integer('score_enemy'),
    kills: integer('kills').default(0),
    deaths: integer('deaths').default(0),
    assists: integer('assists').default(0),
    durationMs: integer('duration_ms'),
    playedAt: timestamp('played_at', { withTimezone: true }).notNull(),
    analysisStatus: text('analysis_status').notNull().default('none'),
    // User confirmation of agent/map (wins over VLM detection). Set via UI post-match.
    userConfirmedAgent: text('user_confirmed_agent'),
    userConfirmedMap: text('user_confirmed_map'),
    agentConfirmedAt: timestamp('agent_confirmed_at', { withTimezone: true }),
    mapConfirmedAt: timestamp('map_confirmed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('idx_matches_user_played').on(t.userId, t.playedAt)],
);

// ── Coaching reports ──────────────────────────────────────────────────────────

export const coachingReports = pgTable(
  'coaching_reports',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    type: text('type').notNull(), // 'game_analysis' | 'weekly_report'
    trigger: text('trigger').notNull().default('manual'), // 'manual' | 'weekly_report'
    status: text('status').notNull().default('completed'), // 'processing' | 'completed' | 'failed'
    matchIds: uuid('match_ids').array().notNull(),
    report: jsonb('report'),
    topIssues: jsonb('top_issues'),
    overallAssessment: text('overall_assessment'),
    // VLM raw detection (kept separate from the UI-facing resolved_* for QA + prompt tuning).
    vlmDetectedAgent: text('vlm_detected_agent'),
    vlmDetectedMap: text('vlm_detected_map'),
    vlmAgentConfidence: text('vlm_agent_confidence'), // 'high' | 'medium' | 'low' | 'unknown'
    vlmMapConfidence: text('vlm_map_confidence'),
    // Resolved truth via resolveAgentMap() — this is what UI + coaching read.
    resolvedAgent: text('resolved_agent'),
    resolvedMap: text('resolved_map'),
    // Snapshot of player rank at the time of the report (for rank-aware coaching).
    rankAtTime: text('rank_at_time'),
    // Bumped to 3 once parseToCanonicalV3() ships. Old reports keep 2.
    reportSchemaVersion: integer('report_schema_version').default(2),
    vlmModel: text('vlm_model'),
    vlmCostUsd: real('vlm_cost_usd'),
    tokensInput: integer('tokens_input'),
    tokensOutput: integer('tokens_output'),
    processingTimeMs: integer('processing_time_ms'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (t) => [
    index('idx_cr_user_created').on(t.userId, t.createdAt),
    index('idx_cr_status').on(t.status),
  ],
);

// ── Coaching jobs (async Tier 3 job tracking) ─────────────────────────────────

export const coachingJobs = pgTable(
  'coaching_jobs',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    reportId: uuid('report_id').references(() => coachingReports.id),
    matchId: uuid('match_id')
      .notNull()
      .references(() => matches.id, { onDelete: 'cascade' }),
    bullJobId: text('bull_job_id'),
    status: text('status').notNull().default('pending'), // pending|processing|completed|failed
    attempts: integer('attempts').notNull().default(0),
    errorMsg: text('error_msg'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (t) => [index('idx_cj_user_status').on(t.userId, t.status), index('idx_cj_pending').on(t.status)],
);

// ── Coaching credits (per-user per-month) ─────────────────────────────────────

export const coachingCredits = pgTable(
  'coaching_credits',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    month: text('month').notNull(), // "2026-03"
    creditsTotal: integer('credits_total').notNull(),
    creditsUsed: integer('credits_used').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('uq_credits_user_month').on(t.userId, t.month)],
);

// ── Weekly coaching reports ───────────────────────────────────────────────────

export const weeklyCoachingReports = pgTable(
  'weekly_coaching_reports',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    weekStart: text('week_start').notNull(), // "2026-03-16"
    weekEnd: text('week_end').notNull(), // "2026-03-22"
    status: text('status').notNull().default('awaiting_uploads'), // awaiting_uploads|processing|completed
    gamesPlayed: integer('games_played').notNull().default(0),
    gamesAnalyzedDeep: integer('games_analyzed_deep').notNull().default(0),
    totalDeaths: integer('total_deaths').notNull().default(0),
    selectedMatchIds: uuid('selected_match_ids').array().notNull().default(sql`'{}'::uuid[]`),
    patternBreakdown: jsonb('pattern_breakdown'),
    topMoments: jsonb('top_moments'),
    positiveHighlights: jsonb('positive_highlights'),
    assessment: jsonb('assessment'),
    drills: jsonb('drills'),
    progressChart: jsonb('progress_chart'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('uq_weekly_user_week').on(t.userId, t.weekStart),
    index('idx_wcr_user').on(t.userId),
  ],
);

// ── Usage records ─────────────────────────────────────────────────────────────

export const usageRecords = pgTable(
  'usage_records',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    operation: text('operation').notNull(),
    billingPeriodStart: timestamp('billing_period_start', { withTimezone: true }).notNull(),
    count: integer('count').notNull().default(1),
    totalCostUsd: real('total_cost_usd').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('idx_usage_user_period').on(t.userId, t.billingPeriodStart)],
);

// ── Session tokens (long-lived desktop auth) ─────────────────────────────────

export const sessionTokens = pgTable(
  'session_tokens',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    token: text('token').unique().notNull(),
    label: text('label').default('desktop'), // 'desktop', 'api', etc.
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    lastUsed: timestamp('last_used', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('idx_st_token').on(t.token), index('idx_st_user').on(t.userId)],
);

// ── Game knowledge store ──────────────────────────────────────────────────────

export const gameKnowledge = pgTable(
  'game_knowledge',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    gameId: text('game_id').notNull(),
    category: text('category').notNull(), // 'agent' | 'map' | 'weapon' | 'mechanic' | 'mode_config'
    entryKey: text('entry_key').notNull(), // 'jett', 'bind', 'vandal', 'economy_rules'
    displayName: text('display_name').notNull(),
    apiData: jsonb('api_data'), // raw data from external API (nullable)
    coachingData: jsonb('coaching_data').notNull(), // hand-written coaching overlays
    mergedData: jsonb('merged_data').notNull(), // api_data + coaching_data pre-computed
    source: text('source').notNull().default('static'), // 'api_sync' | 'manual' | 'static' | 'live_fetch'
    apiVersion: text('api_version'),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('uq_gk_game_cat_key').on(t.gameId, t.category, t.entryKey),
    index('idx_gk_game_category').on(t.gameId, t.category),
  ],
);

export const knowledgeSyncLog = pgTable(
  'knowledge_sync_log',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    gameId: text('game_id').notNull(),
    syncType: text('sync_type').notNull(), // 'scheduled' | 'startup' | 'manual' | 'live_fetch'
    status: text('status').notNull(), // 'success' | 'partial' | 'failed' | 'no_changes'
    apiVersion: text('api_version'),
    entriesAdded: integer('entries_added').notNull().default(0),
    entriesUpdated: integer('entries_updated').notNull().default(0),
    entriesRemoved: integer('entries_removed').notNull().default(0),
    errorMsg: text('error_msg'),
    durationMs: integer('duration_ms'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('idx_ksl_game_created').on(t.gameId, t.createdAt)],
);

// ── Coaching response cache ────────────────────────────────────────────────────

export const coachingCache = pgTable(
  'coaching_cache',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    cacheKey: text('cache_key').unique().notNull(),
    response: jsonb('response').notNull(),
    hitCount: integer('hit_count').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => [index('idx_cache_key').on(t.cacheKey)],
);

// ── Player skill mastery (BKT per skill per user) ────────────────────────────

export const playerSkillMastery = pgTable(
  'player_skill_mastery',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    skillId: text('skill_id').notNull(),
    domain: text('domain').notNull(), // 'mechanical' | 'game_sense' | 'utility' | 'mental'
    pMastery: real('p_mastery').notNull().default(0.3),
    pTransit: real('p_transit').notNull().default(0.1),
    pSlip: real('p_slip').notNull().default(0.1),
    pGuess: real('p_guess').notNull().default(0.2),
    observations: integer('observations').notNull().default(0),
    lastObservedAt: timestamp('last_observed_at', { withTimezone: true }),
    trend: text('trend').notNull().default('stable'), // 'improving' | 'stable' | 'regressing'
    // ZPD tracking: activeSinceAt = when mastery first entered 0.3–0.7; lastGradeAt = last time it crossed 0.7.
    activeSinceAt: timestamp('active_since_at', { withTimezone: true }),
    lastGradeAt: timestamp('last_grade_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('uq_psm_user_skill').on(t.userId, t.skillId),
    index('idx_psm_user').on(t.userId),
    index('idx_psm_user_domain').on(t.userId, t.domain),
  ],
);

// ── Coaching graph nodes ─────────────────────────────────────────────────────

export const coachingGraphNodes = pgTable(
  'coaching_graph_nodes',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    nodeType: text('node_type').notNull(), // 'event' | 'pattern' | 'concept' | 'game' | 'reflection'
    label: text('label').notNull(),
    data: jsonb('data').notNull().default({}),
    embedding: vector('embedding', { dimensions: 768 }),
    importance: real('importance').notNull().default(0.5),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastAccessedAt: timestamp('last_accessed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('idx_cgn_user_type').on(t.userId, t.nodeType),
    index('idx_cgn_user_importance').on(t.userId, t.importance),
  ],
);

// ── Coaching graph edges ─────────────────────────────────────────────────────

export const coachingGraphEdges = pgTable(
  'coaching_graph_edges',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    sourceId: uuid('source_id')
      .notNull()
      .references(() => coachingGraphNodes.id, { onDelete: 'cascade' }),
    targetId: uuid('target_id')
      .notNull()
      .references(() => coachingGraphNodes.id, { onDelete: 'cascade' }),
    edgeType: text('edge_type').notNull(), // 'demonstrates' | 'caused_by' | 'related_to' | 'improved_at' | 'preceded_by'
    weight: real('weight').notNull().default(1.0),
    data: jsonb('data').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('idx_cge_source').on(t.sourceId),
    index('idx_cge_target').on(t.targetId),
    index('idx_cge_type').on(t.edgeType),
  ],
);

// ── Coaching strategies (what advice works per player) ───────────────────────

export const coachingStrategies = pgTable(
  'coaching_strategies',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    strategyType: text('strategy_type').notNull(), // 'correction_style' | 'drill_type' | 'framing' | 'focus_area'
    description: text('description').notNull(),
    qValue: real('q_value').notNull().default(0.5),
    attempts: integer('attempts').notNull().default(0),
    successes: integer('successes').notNull().default(0),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('uq_cs_user_strategy').on(t.userId, t.strategyType, t.description),
    index('idx_cs_user').on(t.userId),
  ],
);

// ── Player observations (semantic coaching memory) ────────────────────────────

export const playerObservations = pgTable(
  'player_observations',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    reportId: uuid('report_id').references(() => coachingReports.id, { onDelete: 'set null' }),
    category: text('category').notNull(), // 'habit' | 'strength' | 'insight'
    text: text('text').notNull(),
    embedding: vector('embedding', { dimensions: 768 }).notNull(),
    occurrences: integer('occurrences').notNull().default(1),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    archived: boolean('archived').notNull().default(false),
    // Brain self-model: 0.5 = neutral, 1.0 = user agrees with observation, 0.0 = user disagrees.
    confidence: real('confidence').default(0.5),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    disagreedAt: timestamp('disagreed_at', { withTimezone: true }),
    // Bi-temporal: validFrom is when this belief became true; validUntil is
    // when it was retired or superseded. Active reads filter validUntil IS NULL.
    validFrom: timestamp('valid_from', { withTimezone: true }).notNull().defaultNow(),
    validUntil: timestamp('valid_until', { withTimezone: true }),
    supersededBy: uuid('superseded_by').references((): AnyPgColumn => playerObservations.id, {
      onDelete: 'set null',
    }),
    // Agent the player was using when this observation was extracted.
    // Used for agent-aware retrieval (boost matching agent on chat).
    // Lowercased canonical name (e.g. 'yoru', 'kayo'). NULL for legacy rows.
    agent: text('agent'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('idx_po_user_category').on(t.userId, t.category),
    index('idx_po_user_active').on(t.userId, t.archived),
  ],
);

// ── Chat quota (Ask Your Coach + match Q&A) ───────────────────────────────────
// One row per (userId, dayStart) for the brain chat (matchId = empty string '')
// and one row per (userId, matchId, dayStart) for match Q&A. The composite
// primary key guarantees upsert safety. `count` is incremented for each
// billable question (soft-blocked safety questions do NOT count).
// `dayStart` stores the UTC date that bucket applies to — counters reset
// naturally when the date advances. No TTL cleanup needed; rows are cheap
// and we keep them for 30d of telemetry history.

export const chatQuotaUsage = pgTable(
  'chat_quota_usage',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    matchId: text('match_id').notNull().default(''),
    dayStart: text('day_start').notNull(),
    count: integer('count').notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('idx_cqu_user_day').on(t.userId, t.dayStart),
    unique('uq_cqu_user_match_day').on(t.userId, t.matchId, t.dayStart),
  ],
);
