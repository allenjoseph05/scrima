/**
 * Era Summary Service (Phase 5)
 *
 * Generates a chapter title + 2-3 sentence narrative summary for a completed
 * era of the player's growth. One LLM call per era closure — trivial cost on
 * the free tier (~1 call/month/user).
 *
 * See: docs/YOUR_COACH_LIVING_MIND.md §5.3
 */

import { GoogleGenAI } from '@google/genai';
import { env } from '../../config/env.js';

export interface EraSummaryInput {
  primarySkillName: string;
  domain: string;
  startMastery: number;
  endMastery: number;
  gamesCount: number;
  durationDays: number;
  drillNames?: string[];
  topObservations?: string[];
}

export interface EraSummaryOutput {
  title: string; // 3-5 words, evocative
  summary: string; // 2-3 sentences
}

export class EraSummaryService {
  async generate(input: EraSummaryInput): Promise<EraSummaryOutput> {
    // No API key or empty data → use deterministic fallback
    if (!env.GEMINI_API_KEY) return this.fallback(input);

    const system = `You are the Scrima Valorant coach writing a chapter-title + summary for a completed ERA of a player's growth.

An era = the period they worked on improving one specific skill. Now that skill has graduated (mastery ≥ 70%).

Write:
1. A CHAPTER TITLE — 3-5 words, evocative. Style: "The Crosshair Era", "The Utility Breakthrough", "The Composure Chapter", "The Trading Turn". Write it so the player remembers this chapter of their growth.
2. A SUMMARY — 2-3 sentences. What was learned, what changed, the mastery delta, what it unlocks going forward.

Tone: warm but tight. Imperative when naming actions. No fluff. Agent-agnostic — never reference specific agents or ability names.

Output ONLY valid JSON:
{ "title": "...", "summary": "..." }`;

    const user = `COMPLETED ERA:
- Skill: ${input.primarySkillName} (${input.domain})
- Mastery change: ${Math.round(input.startMastery * 100)}% → ${Math.round(input.endMastery * 100)}%
- Duration: ${input.gamesCount} games over ${input.durationDays} days
${input.drillNames && input.drillNames.length > 0 ? `- Drills used: ${input.drillNames.slice(0, 3).join(', ')}` : ''}
${input.topObservations && input.topObservations.length > 0 ? `- Key observations: ${input.topObservations.slice(0, 3).join('; ')}` : ''}

Generate the chapter title + summary as JSON.`;

    try {
      const ai = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY ?? '' });
      const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash-lite',
        contents: [{ role: 'user', parts: [{ text: user }] }],
        config: {
          systemInstruction: system,
          temperature: 0.7,
          maxOutputTokens: 400,
          thinkingConfig: { thinkingBudget: 0 },
        },
      });

      const text =
        response.candidates?.[0]?.content?.parts?.map((p: any) => p.text ?? '').join('') ||
        response.text ||
        '';

      const jsonStart = text.indexOf('{');
      const jsonEnd = text.lastIndexOf('}');
      if (jsonStart === -1 || jsonEnd <= jsonStart) return this.fallback(input);

      const parsed = JSON.parse(text.slice(jsonStart, jsonEnd + 1)) as Partial<EraSummaryOutput>;
      const title = typeof parsed.title === 'string' ? parsed.title.trim().slice(0, 60) : '';
      const summary = typeof parsed.summary === 'string' ? parsed.summary.trim().slice(0, 400) : '';

      if (!title || !summary) return this.fallback(input);
      return { title, summary };
    } catch (err) {
      console.warn('[Era] summary LLM failed:', err instanceof Error ? err.message : err);
      return this.fallback(input);
    }
  }

  private fallback(input: EraSummaryInput): EraSummaryOutput {
    const deltaPct = Math.round((input.endMastery - input.startMastery) * 100);
    return {
      title: `The ${input.primarySkillName} Era`,
      summary: `You took ${input.primarySkillName.toLowerCase()} from ${Math.round(input.startMastery * 100)}% to ${Math.round(input.endMastery * 100)}% mastery across ${input.gamesCount} games (+${deltaPct}%). Skill graduated — keep it automatic while we focus on your next gap.`,
    };
  }
}
