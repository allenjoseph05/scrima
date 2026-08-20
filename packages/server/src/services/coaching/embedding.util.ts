/**
 * Embedding helper — shared between observation and graph services.
 *
 * Uses Google `gemini-embedding-001` with output dimensionality 768
 * (matches the pgvector(768) columns in `player_observations` and
 * `coaching_graph_nodes`). Sequential per-text loop to avoid
 * rate-limiting bursts; the embed model has no concurrency advantage
 * for the per-game volume we ship (5–25 texts).
 *
 * Returns one vector per input — empty array for any individual text
 * that fails so callers can preserve positional alignment.
 */

import { env } from '../../config/env.js';

const EMBEDDING_MODEL = 'gemini-embedding-001';
const TARGET_DIMS = 768;

// Singleton client. The brain fan-out can fire several embedTexts calls in
// parallel (observations + graph + user-question embed); spinning up a fresh
// GoogleGenAI per call wastes the SDK's connection pool and slows cold start.
type GenAIClient = { models: { embedContent: (req: any) => Promise<any> } };
let _client: GenAIClient | null = null;
let _clientPromise: Promise<GenAIClient | null> | null = null;

async function getClient(): Promise<GenAIClient | null> {
  if (_client) return _client;
  if (!env.GEMINI_API_KEY) return null;
  if (!_clientPromise) {
    _clientPromise = (async () => {
      const { GoogleGenAI } = await import('@google/genai');
      _client = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY }) as unknown as GenAIClient;
      return _client;
    })();
  }
  return _clientPromise;
}

export async function embedTexts(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const ai = await getClient();
  if (!ai) {
    console.warn('[Embedding] GEMINI_API_KEY not set — returning empty vectors');
    return texts.map(() => []);
  }

  const out: number[][] = [];
  for (const text of texts) {
    try {
      const response = await ai.models.embedContent({
        model: EMBEDDING_MODEL,
        contents: text,
        config: { outputDimensionality: TARGET_DIMS },
      });
      const values = response.embeddings?.[0]?.values ?? [];
      out.push(values);
    } catch (err) {
      console.warn(
        '[Embedding] failed for "%s": %s',
        text.slice(0, 60),
        err instanceof Error ? err.message : err,
      );
      out.push([]);
    }
  }
  return out;
}

/** Convenience for a single text — returns null on failure. */
export async function embedText(text: string): Promise<number[] | null> {
  const [v] = await embedTexts([text]);
  return v && v.length === TARGET_DIMS ? v : null;
}

/** True if the vector is the right shape to insert into a pgvector(768). */
export function isValid768(v: number[] | null | undefined): v is number[] {
  return Array.isArray(v) && v.length === TARGET_DIMS;
}
