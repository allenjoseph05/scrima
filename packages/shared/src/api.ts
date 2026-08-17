/**
 * API request/response schemas and types.
 * Based on Section 7 of the Technical Specification.
 *
 * These Zod schemas are shared between client and server
 * for type-safe API communication.
 */

import { z } from 'zod';

// ============================================================
// SHARED SCHEMAS
// ============================================================

export const GameContextSchema = z.object({
  game: z.string(),
  gameMode: z.string().optional(),
  durationMs: z.number().int().optional(),
  map: z.string().default('unknown'),
  agent: z.string().default('unknown'),
  rank: z.string().default('unknown'),
  matchEvents: z
    .array(
      z.object({
        type: z.string(),
        round: z.number().int().optional(),
        timestampMs: z.number().int(),
        won: z.boolean().optional(),
        data: z.record(z.unknown()).optional(),
      }),
    )
    .default([]),
  deathDetails: z
    .array(
      z.object({
        index: z.number().int(),
        round: z.number().int(),
        timestampMs: z.number().int(),
        timestampFormatted: z.string(),
        killer: z.string(),
        weapon: z.string(),
        headshot: z.boolean(),
        hpBefore: z.number().int(),
        teamAlive: z.number().int(),
        enemyAlive: z.number().int(),
        abilitiesAvailable: z.array(z.string()),
        money: z.number().int(),
        teamMoneyAvg: z.number().int(),
      }),
    )
    .default([]),
  economyTimeline: z
    .array(
      z.object({
        round: z.number().int(),
        money: z.number().int(),
        buyType: z.enum(['full_buy', 'half_buy', 'eco', 'force_buy', 'save']),
      }),
    )
    .default([]),
  abilityUsage: z
    .object({
      totalUsed: z.number().int(),
      totalAvailable: z.number().int(),
      usageRate: z.number(),
      byAbility: z.record(
        z.object({
          used: z.number().int(),
          available: z.number().int(),
        }),
      ),
    })
    .default({ totalUsed: 0, totalAvailable: 0, usageRate: 0, byAbility: {} }),
  playerPatterns: z
    .object({
      gamesAnalyzed: z.number().int(),
      totalCoachableMoments: z.number().int(),
      categoryBreakdown: z.record(z.number()),
      topIssues: z.array(
        z.object({
          categoryId: z.string(),
          percentage: z.number(),
          description: z.string(),
        }),
      ),
    })
    .optional(),
});

// ============================================================
// MATCH ENDPOINTS
// ============================================================

export const RegisterMatchRequestSchema = z.object({
  matchId: z.string().uuid(),
  game: z.string(),
  map: z.string().optional(),
  agent: z.string().optional(),
  rank: z.string().optional(),
  gameMode: z.string().optional(),
  won: z.boolean().optional(),
  scoreTeam: z.number().int().optional(),
  scoreEnemy: z.number().int().optional(),
  kills: z.number().int().default(0),
  deaths: z.number().int().default(0),
  assists: z.number().int().default(0),
  durationMs: z.number().int().optional(),
  playedAt: z.string().datetime(),
});

export type RegisterMatchRequest = z.infer<typeof RegisterMatchRequestSchema>;

export const MatchResponseSchema = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid(),
  game: z.string(),
  map: z.string().nullable(),
  agent: z.string().nullable(),
  rank: z.string().nullable(),
  won: z.boolean().nullable(),
  kills: z.number().int(),
  deaths: z.number().int(),
  assists: z.number().int(),
  durationMs: z.number().int().nullable(),
  playedAt: z.string().datetime(),
  analysisStatus: z.enum(['none', 'queued', 'uploaded', 'analyzed', 'failed']),
  createdAt: z.string().datetime(),
});

export type MatchResponse = z.infer<typeof MatchResponseSchema>;

// ============================================================
// GAME ANALYSIS ENDPOINTS
// ============================================================

export const DeepAnalyzeRequestSchema = z.object({
  matchId: z.string().uuid(),
  // Video uploaded via presigned URL to R2, URI provided here
  videoUri: z.string().url(),
  context: GameContextSchema,
});

export type DeepAnalyzeRequest = z.infer<typeof DeepAnalyzeRequestSchema>;

export const DeepAnalyzeResponseSchema = z.object({
  jobId: z.string().uuid(),
  status: z.enum(['queued', 'processing', 'completed', 'failed']),
  estimatedTimeMs: z.number().int(),
});

export type DeepAnalyzeResponse = z.infer<typeof DeepAnalyzeResponseSchema>;

export const DeepAnalyzeResultSchema = z.object({
  jobId: z.string().uuid(),
  matchId: z.string().uuid(),
  status: z.enum(['queued', 'processing', 'completed', 'failed']),
  report: z
    .object({
      overallAssessment: z.string(),
      moments: z.array(
        z.object({
          timestamp: z.string(),
          round: z.number().int().optional(),
          category: z.string(),
          whatHappened: z.string(),
          whatWasWrong: z.string(),
          whatToDo: z.string(),
          severity: z.enum(['critical', 'moderate', 'minor']),
        }),
      ),
      topIssues: z.array(
        z.object({
          category: z.string(),
          frequency: z.string(),
          description: z.string(),
          drill: z.string(),
        }),
      ),
      positiveHighlights: z.array(
        z.object({
          timestamp: z.string(),
          description: z.string(),
        }),
      ),
    })
    .nullable(),
  error: z.string().nullable(),
});

export type DeepAnalyzeResult = z.infer<typeof DeepAnalyzeResultSchema>;

// ============================================================
// ERROR RESPONSE
// ============================================================

export const ErrorResponseSchema = z.object({
  error: z.string(),
  code: z.string(),
  statusCode: z.number().int(),
});

export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;

// ============================================================
// SUBSCRIPTION TIERS
// ============================================================

export const SUBSCRIPTION_TIERS = {
  free: {
    analysesPerWeek: 3,
    vlmModel: null,
    priceUsd: 0,
  },
  pro: {
    stripePriceId: 'price_pro_monthly',
    priceUsd: 10,
    analysesPerWeek: 35, // 5/day
    vlmModel: 'gemini-2.5-flash',
  },
  ultra: {
    stripePriceId: 'price_ultra_monthly',
    priceUsd: 25,
    analysesPerWeek: Number.POSITIVE_INFINITY,
    vlmModel: 'gemini-2.5-flash',
  },
} as const;

export type SubscriptionTier = keyof typeof SUBSCRIPTION_TIERS;

// ============================================================
// RATE LIMITS
// ============================================================

export const RATE_LIMITS = {
  'POST /coaching/analyze': { windowMs: 3_600_000, max: 5 },
  'POST /matches': { windowMs: 60_000, max: 5 },
  'GET *': { windowMs: 60_000, max: 120 },
} as const;
