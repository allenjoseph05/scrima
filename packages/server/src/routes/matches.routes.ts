import { RegisterMatchRequestSchema } from '@scrima/shared';
import { and, desc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db, matches } from '../db/index.js';
import { requireAuth } from '../middleware/auth.middleware.js';

export async function matchesRoutes(app: FastifyInstance) {
  // POST /matches — client registers a completed match
  app.post('/matches', { preHandler: [requireAuth] }, async (req, reply) => {
    const body = RegisterMatchRequestSchema.parse(req.body);

    await db
      .insert(matches)
      .values({
        id: body.matchId,
        userId: req.userId,
        game: body.game,
        map: body.map,
        agent: body.agent,
        rank: body.rank,
        gameMode: body.gameMode,
        won: body.won,
        scoreTeam: body.scoreTeam,
        scoreEnemy: body.scoreEnemy,
        kills: body.kills,
        deaths: body.deaths,
        assists: body.assists,
        durationMs: body.durationMs,
        playedAt: new Date(body.playedAt),
      })
      .onConflictDoNothing();

    return reply.code(201).send({ matchId: body.matchId });
  });

  // GET /matches — paginated list for this user
  app.get('/matches', { preHandler: [requireAuth] }, async (req, reply) => {
    const { limit, offset } = z
      .object({
        limit: z.coerce.number().min(1).max(100).default(20),
        offset: z.coerce.number().min(0).default(0),
      })
      .parse(req.query);

    const rows = await db
      .select()
      .from(matches)
      .where(eq(matches.userId, req.userId))
      .orderBy(desc(matches.playedAt))
      .limit(limit)
      .offset(offset);

    return reply.send({ matches: rows, limit, offset });
  });

  // GET /matches/:id
  app.get('/matches/:id', { preHandler: [requireAuth] }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);

    const match = await db.query.matches.findFirst({
      where: and(eq(matches.id, id), eq(matches.userId, req.userId)),
    });

    if (!match) return reply.code(404).send({ error: 'Match not found', code: 'NOT_FOUND' });
    return reply.send(match);
  });
}
