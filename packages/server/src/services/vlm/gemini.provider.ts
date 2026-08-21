/**
 * Gemini VLM Provider
 *
 * Uploads video to the Gemini Files API, runs inference, then deletes
 * the uploaded file. Video never persists on Google's side.
 *
 * Key API optimizations (from official Gemini docs):
 * - System instructions: static coaching knowledge separated from per-game context
 * - Structured output: responseMimeType + responseJsonSchema for guaranteed JSON
 * - Video-first ordering: video part placed before text (Google recommendation)
 * - Temperature 1.0 for Gemini 3.x (Google warning: <1.0 causes unexpected behavior)
 * - Thinking disabled: Google docs recommend disabling for visual/classification tasks
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { FileState, GoogleGenAI, MediaResolution } from '@google/genai';
import { env } from '../../config/env.js';
import { gameRegistry } from '../../games/registry.js';
import { VlmError } from '../../shared/errors.js';

const execFileAsync = promisify(execFile);
import type {
  CoachingReport,
  GameContext,
  TokenEstimate,
  TokenEstimationInput,
  VlmCoachingResult,
} from '@scrima/shared';

// ── Shared types ─────────────────────────────────────────────────────────────

/** Handle for a video file already uploaded to Gemini Files API. */
export interface UploadedFileHandle {
  fileName: string;
  fileUri: string;
  mimeType: string;
}

export interface PreScreenResult {
  isGame: boolean;
  confidence: 'high' | 'medium' | 'low';
  rejectionReason: string;
  detectedAgent?: string;
  agentConfidence?: 'high' | 'medium' | 'low';
  detectedMap?: string;
  mapConfidence?: 'high' | 'medium' | 'low';
  costUsd: number;
}

// Fallback pre-screen config — used when game module doesn't provide one
const PRE_SCREEN_SCHEMA = {
  type: 'object',
  properties: {
    is_valorant: {
      type: 'boolean',
      description: 'true if this video shows gameplay with a HUD visible.',
    },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    rejection_reason: {
      type: 'string',
      description: 'If false, what you see. If true, empty string.',
    },
    detected_agent: { type: 'string', description: 'Character/agent name or "unknown".' },
    detected_map: { type: 'string', description: 'Map name or "unknown".' },
    agent_confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    map_confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
  },
  required: ['is_valorant', 'confidence', 'rejection_reason'],
};

const PRE_SCREEN_PROMPT =
  'Is this a competitive FPS game? Look for a gameplay HUD. If yes, try to identify the character and map. Output JSON.';

// ── Types ─────────────────────────────────────────────────────────────────────

export type GeminiModelId =
  | 'gemini-2.5-flash-lite'
  | 'gemini-2.5-flash'
  | 'gemini-2.5-pro'
  | 'gemini-2.0-flash'
  | 'gemini-3.1-flash-lite-preview'
  | 'gemini-3.1-pro-preview'
  | 'gemma-3-27b-it'
  | 'gemma-4-26b-a4b-it'
  | 'gemma-4-31b-it';

// Pricing per million tokens. Google tiers at 200K context — above that, price doubles.
// Thinking tokens are billed at a separate (higher) rate.
const PRICING: Record<
  GeminiModelId,
  { input: number; inputLong: number; output: number; outputLong: number; thinking: number }
> = {
  'gemini-2.5-flash-lite': {
    input: 0.1,
    inputLong: 0.2,
    output: 0.4,
    outputLong: 0.8,
    thinking: 0.4,
  },
  'gemini-2.5-flash': { input: 0.3, inputLong: 0.3, output: 2.5, outputLong: 2.5, thinking: 2.5 },
  'gemini-2.5-pro': { input: 1.25, inputLong: 2.5, output: 10.0, outputLong: 20.0, thinking: 10.0 },
  'gemini-2.0-flash': { input: 0.1, inputLong: 0.1, output: 0.4, outputLong: 0.4, thinking: 0.4 },
  'gemini-3.1-flash-lite-preview': {
    input: 0.25,
    inputLong: 0.5,
    output: 1.5,
    outputLong: 3.0,
    thinking: 1.5,
  },
  'gemini-3.1-pro-preview': {
    input: 2.0,
    inputLong: 4.0,
    output: 12.0,
    outputLong: 24.0,
    thinking: 12.0,
  },
  // Hosted Gemma on the Gemini API is currently free-tier only in Google's
  // public pricing table. Track it as zero-cost instead of falling back to
  // Gemini Flash pricing in estimates/logs.
  'gemma-3-27b-it': { input: 0.0, inputLong: 0.0, output: 0.0, outputLong: 0.0, thinking: 0.0 },
  'gemma-4-26b-a4b-it': { input: 0.0, inputLong: 0.0, output: 0.0, outputLong: 0.0, thinking: 0.0 },
  'gemma-4-31b-it': { input: 0.0, inputLong: 0.0, output: 0.0, outputLong: 0.0, thinking: 0.0 },
};

const MEDIA_RESOLUTION_MAP: Record<string, MediaResolution> = {
  LOW: MediaResolution.MEDIA_RESOLUTION_LOW,
  MEDIUM: MediaResolution.MEDIA_RESOLUTION_MEDIUM,
  HIGH: MediaResolution.MEDIA_RESOLUTION_HIGH,
};

// ── Provider ──────────────────────────────────────────────────────────────────

export class GeminiProvider {
  readonly providerId = 'google';
  readonly modelId: string;
  readonly maxInputTokens = 1_000_000;

  private ai: GoogleGenAI;
  private pricing: {
    input: number;
    inputLong: number;
    output: number;
    outputLong: number;
    thinking: number;
  };
  private mediaResolution: MediaResolution;

  private videoFps: number;

  constructor(modelId: GeminiModelId = 'gemini-2.5-flash') {
    const apiKey = env.GEMINI_API_KEY ?? '';
    this.ai = new GoogleGenAI({ apiKey });
    this.modelId = modelId;
    this.pricing = PRICING[modelId] ?? PRICING['gemini-2.5-flash'];
    this.mediaResolution =
      MEDIA_RESOLUTION_MAP[env.VLM_MEDIA_RESOLUTION] ?? MediaResolution.MEDIA_RESOLUTION_LOW;
    this.videoFps = env.VLM_VIDEO_FPS ?? 3;
  }

  // ── File upload (reusable across pre-screen + main analysis) ────────────────

  /**
   * Upload a video buffer to Gemini Files API and wait until ACTIVE.
   * Burns a visible timestamp overlay (HH:MM:SS) into the top-left corner
   * so the VLM can read exact timestamps from the frames.
   * Returns a handle that can be passed to both preScreenVideo and analyzeFullGame.
   *
   * @param skipProcessing — If true, skip timestamp burn + audio strip (e.g. for pre-processed clip compilations).
   */
  async uploadVideoFile(
    videoBuffer: Buffer,
    timeoutMs?: number,
    skipProcessing = false,
  ): Promise<UploadedFileHandle> {
    // Scale timeout with file size: base 180s + 2s per MB (generous for slow uploads)
    const sizeMB = videoBuffer.length / 1024 / 1024;
    const effectiveTimeout = timeoutMs ?? Math.max(180_000, Math.round(180_000 + sizeMB * 2000));
    console.log(
      '[GeminiProvider] upload timeout: %ds for %sMB file',
      effectiveTimeout / 1000,
      sizeMB.toFixed(1),
    );

    const ts = Date.now();
    const rawPath = path.join(os.tmpdir(), `scrima-raw-${ts}.mp4`);
    const stampedPath = path.join(os.tmpdir(), `scrima-stamped-${ts}.mp4`);
    await fs.promises.writeFile(rawPath, videoBuffer);

    let uploadPath = rawPath;

    try {
      // Burn visible timestamp + strip audio + downsample to 1fps 720p.
      // The client already downsamples to 1fps 720p. Server just burns MM:SS
      // timestamps onto the existing frames — no decode/re-encode of 60fps needed.
      // Timeout: 30s base + 0.5s per MB (input is already small ~10-20 MB).
      if (!skipProcessing)
        try {
          const burnStart = Date.now();
          const timeoutMs = Math.max(30_000, 30_000 + sizeMB * 500);
          await execFileAsync(
            'ffmpeg',
            [
              '-i',
              rawPath,
              '-vf',
              "drawtext=text='%{pts\\:hms}':fontsize=28:fontcolor=white:borderw=2:bordercolor=black:x=10:y=10",
              '-preset',
              'ultrafast',
              '-crf',
              '32',
              '-an',
              '-y',
              stampedPath,
            ],
            { timeout: timeoutMs },
          );

          if (fs.existsSync(stampedPath) && fs.statSync(stampedPath).size > 0) {
            uploadPath = stampedPath;
            const rawSize = fs.statSync(rawPath).size;
            const stampedSize = fs.statSync(stampedPath).size;
            console.log(
              '[GeminiProvider] timestamp burned + audio stripped in %dms (raw=%sMB → stamped=%sMB)',
              Date.now() - burnStart,
              (rawSize / 1024 / 1024).toFixed(1),
              (stampedSize / 1024 / 1024).toFixed(1),
            );

            // Verify audio was actually stripped
            try {
              const { stdout: probeOut } = await execFileAsync(
                'ffprobe',
                [
                  '-v',
                  'quiet',
                  '-show_streams',
                  '-select_streams',
                  'a',
                  '-of',
                  'csv=p=0',
                  stampedPath,
                ],
                { timeout: 5000 },
              );
              if (probeOut.trim().length > 0) {
                console.warn('[GeminiProvider] WARNING: stamped file still has audio streams!');
              } else {
                console.log('[GeminiProvider] confirmed: no audio streams in output');
              }
            } catch {
              /* ffprobe check is best-effort */
            }
          } else {
            console.warn(
              '[GeminiProvider] timestamp burn produced empty file, using ORIGINAL (may have audio!)',
            );
          }
        } catch (err) {
          console.warn(
            '[GeminiProvider] timestamp burn FAILED, using ORIGINAL (may have audio!):',
            err instanceof Error ? err.message : err,
          );
        }

      const uploaded = await withTimeout(
        this.ai.files.upload({
          file: uploadPath,
          config: {
            mimeType: 'video/mp4',
            displayName: `scrima-game-${ts}`,
          },
        }),
        effectiveTimeout,
        `Gemini file upload timed out after ${effectiveTimeout / 1000}s (${sizeMB.toFixed(0)}MB)`,
      );

      const fileName = uploaded.name ?? null;
      if (!fileName) throw new VlmError('File upload returned no name', 'UPLOAD_FAILED');

      await this.waitForFileReady(fileName, effectiveTimeout);
      const file = await this.ai.files.get({ name: fileName });

      return {
        fileName,
        fileUri: file.uri ?? '',
        mimeType: file.mimeType ?? 'video/mp4',
      };
    } finally {
      fs.rmSync(rawPath, { force: true });
      fs.rmSync(stampedPath, { force: true });
    }
  }

  /**
   * Delete a previously uploaded file from Gemini Files API.
   */
  async deleteVideoFile(fileName: string): Promise<void> {
    await this.ai.files.delete({ name: fileName }).catch(() => {});
  }

  async listUploadedFiles(): Promise<{ name: string; state: string }[]> {
    const resp = await this.ai.files.list({ config: { pageSize: 100 } });
    const files: { name: string; state: string }[] = [];
    for await (const f of resp) {
      if (f.name) files.push({ name: f.name, state: f.state ?? 'unknown' });
    }
    return files;
  }

  // ── Full game analysis ─────────────────────────────────────────────────────

  async analyzeFullGameBuffer(
    videoBuffer: Buffer,
    promptParts: { systemInstruction: string; userPrompt: string },
    context: GameContext,
    reportSchema?: Record<string, unknown>,
    existingFile?: UploadedFileHandle,
  ): Promise<VlmCoachingResult> {
    const startTime = Date.now();
    let uploadedFileName: string | null = null;
    const ownsFile = !existingFile; // only delete if we uploaded it ourselves

    try {
      let fileHandle: UploadedFileHandle;

      if (existingFile) {
        fileHandle = existingFile;
      } else {
        fileHandle = await this.uploadVideoFile(videoBuffer);
      }
      uploadedFileName = fileHandle.fileName;

      // videoMetadata.fps tells Gemini how many frames/sec to sample from the video.
      // Must match the client's FFmpeg output fps so Gemini samples every frame.
      const videoPart = {
        fileData: { mimeType: fileHandle.mimeType, fileUri: fileHandle.fileUri },
        videoMetadata: { fps: this.videoFps },
      };

      // Google docs: place video BEFORE text for optimal video understanding
      // 3-minute timeout: Gemini typically responds in 7-60s. Longest observed: ~60s for 40-min video.
      // 3 min is generous enough for server load spikes while still catching actual hangs.
      const INFERENCE_TIMEOUT_MS = 180_000;
      const response = await withTimeout(
        this.ai.models.generateContent({
          model: this.modelId,
          contents: [{ parts: [videoPart, { text: promptParts.userPrompt }] }],
          config: {
            // System instruction: static coaching knowledge (cacheable by Gemini)
            systemInstruction: promptParts.systemInstruction,
            // Gemini 3.x docs: "strongly recommend temperature 1.0; <1.0 may cause unexpected behavior"
            // Gemini 2.x: lower temperature is fine for analytical tasks
            temperature: this.isGemini3() ? 1.0 : 0.1,
            maxOutputTokens: 65536,
            mediaResolution: this.mediaResolution,
            // Thinking lets the model reason about gameplay before producing the report.
            // Flash needs thinking to scan through long videos reliably.
            thinkingConfig: this.buildThinkingConfig(8192),
            // Structured output: guaranteed valid JSON matching game-specific schema
            responseMimeType: 'application/json',
            responseJsonSchema:
              reportSchema ?? gameRegistry.getOrThrow(context.game ?? 'valorant').getReportSchema(),
          },
        }),
        INFERENCE_TIMEOUT_MS,
        `Gemini inference timed out after ${INFERENCE_TIMEOUT_MS / 1000}s`,
      );

      // With structured output, response.text should always be valid JSON
      const text: string =
        response.candidates?.[0]?.content?.parts?.map((p: any) => p.text ?? '').join('') ||
        response.text ||
        '';

      const usage = response.usageMetadata;
      const finishReason = response.candidates?.[0]?.finishReason;
      const thinkingTokens = (usage as any)?.thoughtsTokenCount ?? 0;
      const inputTokens = usage?.promptTokenCount ?? 0;
      const outputTokens = usage?.candidatesTokenCount ?? 0;
      const cost = this.calcCost(inputTokens, outputTokens, thinkingTokens);

      // Detailed cost breakdown for debugging
      const isLong = inputTokens > 200_000;
      const inRate = isLong ? this.pricing.inputLong : this.pricing.input;
      const outRate = isLong ? this.pricing.outputLong : this.pricing.output;
      console.log(
        '[GeminiProvider] response: tokens_in=%d tokens_out=%d tokens_thinking=%d finish=%s model=%s',
        inputTokens,
        outputTokens,
        thinkingTokens,
        finishReason,
        this.modelId,
      );
      console.log(
        '[GeminiProvider] cost breakdown: input=$%s (%dk@$%s/M%s) + output=$%s + thinking=$%s = total=$%s',
        ((inputTokens / 1_000_000) * inRate).toFixed(4),
        Math.round(inputTokens / 1000),
        inRate,
        isLong ? ' LONG' : '',
        ((outputTokens / 1_000_000) * outRate).toFixed(4),
        ((thinkingTokens / 1_000_000) * this.pricing.thinking).toFixed(4),
        cost.toFixed(4),
      );

      const parsed = this.parseCoachingReport(text, context.game ?? 'valorant');

      return {
        success: true,
        coachingReport: parsed,
        tokensUsed: {
          input: usage?.promptTokenCount ?? 0,
          output: usage?.candidatesTokenCount ?? 0,
          thinking: thinkingTokens,
        },
        costUsd: this.calcCost(
          usage?.promptTokenCount ?? 0,
          usage?.candidatesTokenCount ?? 0,
          thinkingTokens,
        ),
        latencyMs: Date.now() - startTime,
        modelId: this.modelId,
      };
    } finally {
      if (ownsFile && uploadedFileName) {
        await this.ai.files.delete({ name: uploadedFileName }).catch(() => {});
      }
    }
  }

  // ── Pre-screen (cheap validation with flash-lite) ──────────────────────────

  async preScreenVideo(
    videoBuffer: Buffer,
    gamePrompt?: string,
    gameSchema?: Record<string, unknown>,
    existingFile?: UploadedFileHandle,
  ): Promise<PreScreenResult> {
    const preScreenModel = 'gemini-2.5-flash-lite';
    const preScreenPricing = PRICING[preScreenModel];
    let uploadedFileName: string | null = null;
    const ownsFile = !existingFile;

    const prompt = gamePrompt ?? PRE_SCREEN_PROMPT;
    const schema = gameSchema ?? PRE_SCREEN_SCHEMA;

    try {
      let fileHandle: UploadedFileHandle;

      if (existingFile) {
        fileHandle = existingFile;
      } else {
        fileHandle = await this.uploadVideoFile(videoBuffer, 60_000);
      }
      uploadedFileName = fileHandle.fileName;

      // Low fps = fewer frames sampled = cheaper pre-screen
      // 0.05fps → ~1 frame per 20 seconds → 5-min video ≈ 15 frames, 20-min ≈ 60 frames
      const videoPart = {
        fileData: { mimeType: fileHandle.mimeType, fileUri: fileHandle.fileUri },
        videoMetadata: { fps: 0.05 },
      };

      const response = await this.ai.models.generateContent({
        model: preScreenModel,
        contents: [{ parts: [videoPart, { text: prompt }] }],
        config: {
          temperature: 0.1,
          maxOutputTokens: 256,
          mediaResolution: MediaResolution.MEDIA_RESOLUTION_LOW,
          thinkingConfig: this.buildThinkingConfig(0, preScreenModel),
          responseMimeType: 'application/json',
          responseJsonSchema: schema,
        },
      });

      const text =
        response.candidates?.[0]?.content?.parts?.map((p: any) => p.text ?? '').join('') ||
        response.text ||
        '';
      const usage = response.usageMetadata;
      const inputTokens = usage?.promptTokenCount ?? 0;
      const outputTokens = usage?.candidatesTokenCount ?? 0;
      const costUsd =
        (inputTokens / 1_000_000) * preScreenPricing.input +
        (outputTokens / 1_000_000) * preScreenPricing.output;

      console.log(
        '[GeminiProvider] pre-screen: tokens_in=%d tokens_out=%d cost=$%s model=%s',
        inputTokens,
        outputTokens,
        costUsd.toFixed(6),
        preScreenModel,
      );

      let parsed: any;
      try {
        parsed = JSON.parse(text.trim());
      } catch {
        parsed = { is_valorant: true, confidence: 'low', rejection_reason: '' };
      }

      // Only trust agent/map if confidence is high or medium
      const agentConf = parsed.agent_confidence ?? 'low';
      const mapConf = parsed.map_confidence ?? 'low';
      const agent =
        agentConf === 'high' || agentConf === 'medium' ? parsed.detected_agent : undefined;
      const map = mapConf === 'high' || mapConf === 'medium' ? parsed.detected_map : undefined;

      return {
        isGame: parsed.is_valorant ?? true,
        confidence: parsed.confidence ?? 'low',
        rejectionReason: parsed.rejection_reason ?? '',
        detectedAgent: agent,
        agentConfidence: agentConf,
        detectedMap: map,
        mapConfidence: mapConf,
        costUsd,
      };
    } catch (err) {
      // If pre-screen itself fails, let the full analysis handle validation
      console.error(
        '[GeminiProvider] pre-screen failed, skipping:',
        err instanceof Error ? err.message : err,
      );
      return { isGame: true, confidence: 'low', rejectionReason: '', costUsd: 0 };
    } finally {
      if (ownsFile && uploadedFileName) {
        await this.ai.files.delete({ name: uploadedFileName }).catch(() => {});
      }
    }
  }

  // ── Fact verification with inline images ──────────────────────────────────

  /**
   * Send a batch of base64 images to flash-lite at HIGH resolution for factual verification.
   * Used after main analysis to verify weapon names, enemy agents, abilities from death screens.
   * Images are sent inline (no Files API upload needed).
   */
  async verifyWithImages(
    images: { label: string; base64: string; mimeType: string }[],
    prompt: string,
    schema: Record<string, unknown>,
    timeoutMs = 30_000,
    modelOverride?: GeminiModelId,
    maxOutputTokens = 4096,
    thinkingBudget = 0,
  ): Promise<{
    result: Record<string, unknown>;
    costUsd: number;
    tokensUsed: { input: number; output: number };
  }> {
    const verifyModel: GeminiModelId = modelOverride ?? 'gemini-2.5-flash';
    const verifyPricing = PRICING[verifyModel];

    // Split prompt into system instruction (rules/methodology) and user content
    // (death-specific instructions). The model must know the rules BEFORE seeing
    // images, otherwise it processes 160 images without knowing what to look for
    // and falls back to training data instead of reading the frames.
    //
    // Split at "═══ DEATHS TO ANALYZE" — everything before is methodology,
    // everything after is per-analysis instructions.
    const splitMarker = '═══ DEATHS TO ANALYZE';
    const splitIdx = prompt.indexOf(splitMarker);
    let systemInstruction: string;
    let userPrompt: string;
    if (splitIdx > 0) {
      systemInstruction = prompt.slice(0, splitIdx).trim();
      userPrompt = prompt.slice(splitIdx).trim();
    } else {
      // Fallback: put entire prompt as system instruction
      systemInstruction = prompt;
      userPrompt = 'Analyze the attached frames and produce the coaching report as JSON.';
    }

    // Build content: instructions FIRST, then images with labels
    // Google recommends text before images for analysis tasks.
    const parts: any[] = [];
    parts.push({ text: userPrompt });
    for (const img of images) {
      parts.push({ inlineData: { data: img.base64, mimeType: img.mimeType } });
      parts.push({ text: `[${img.label}]` });
    }

    const response = await withTimeout(
      this.ai.models.generateContent({
        model: verifyModel,
        contents: [{ parts }],
        config: {
          systemInstruction,
          // Gemini 3.x docs: "strongly recommend temperature 1.0; <1.0 may cause unexpected behavior"
          temperature: this.isGemini3(verifyModel) ? 1.0 : 0.1,
          maxOutputTokens,
          mediaResolution: MediaResolution.MEDIA_RESOLUTION_HIGH,
          thinkingConfig: this.buildThinkingConfig(thinkingBudget, verifyModel),
          responseMimeType: 'application/json',
          responseJsonSchema: schema,
        },
      }),
      timeoutMs,
      `Gemini verify timed out after ${timeoutMs / 1000}s (${images.length} images, model=${verifyModel})`,
    );

    const text =
      response.candidates?.[0]?.content?.parts?.map((p: any) => p.text ?? '').join('') ||
      response.text ||
      '';
    const usage = response.usageMetadata;
    const inputTokens = usage?.promptTokenCount ?? 0;
    const outputTokens = usage?.candidatesTokenCount ?? 0;
    const thinkingTokens = (usage as any)?.thoughtsTokenCount ?? 0;

    const isLong = inputTokens > 200_000;
    const inRate = isLong ? verifyPricing.inputLong : verifyPricing.input;
    const outRate = isLong ? verifyPricing.outputLong : verifyPricing.output;
    const costUsd =
      (inputTokens / 1_000_000) * inRate +
      (outputTokens / 1_000_000) * outRate +
      (thinkingTokens / 1_000_000) * verifyPricing.thinking;

    const finishReason = response.candidates?.[0]?.finishReason ?? 'unknown';
    console.log(
      '[GeminiProvider] verify: tokens_in=%d tokens_out=%d tokens_thinking=%d finish=%s cost=$%s images=%d model=%s',
      inputTokens,
      outputTokens,
      thinkingTokens,
      finishReason,
      costUsd.toFixed(6),
      images.length,
      verifyModel,
    );

    // If model returned zero output, log the raw response for diagnostics
    if (outputTokens === 0 || !text.trim()) {
      const blockReason = (response as any).promptFeedback?.blockReason ?? 'none';
      console.warn(
        '[GeminiProvider] verify: EMPTY RESPONSE — finishReason=%s blockReason=%s text="%s"',
        finishReason,
        blockReason,
        text.slice(0, 200),
      );
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(text.trim());
    } catch {
      parsed = {};
    }

    return { result: parsed, costUsd, tokensUsed: { input: inputTokens, output: outputTokens } };
  }

  private isGemini3(model?: string): boolean {
    return (model ?? this.modelId).startsWith('gemini-3');
  }

  /**
   * Build the correct thinkingConfig for the model generation.
   * Gemini 3.x uses thinkingLevel (MINIMAL/LOW/MEDIUM/HIGH).
   * Gemini 2.x uses thinkingBudget (token count, 0 = disabled).
   */
  private buildThinkingConfig(budget: number, model?: string): Record<string, unknown> {
    if (this.isGemini3(model)) {
      // 3.x models use thinkingLevel instead of thinkingBudget.
      // IMPORTANT: thinkingLevel has NO TOKEN CAP — even LOW can generate thousands of tokens.
      // Map conservatively to avoid cost spikes vs 2.x's hard-capped thinkingBudget.
      if (budget <= 0) return { thinkingLevel: 'MINIMAL' };
      if (budget <= 2048) return { thinkingLevel: 'MINIMAL' }; // Phase B: structured output, no deep reasoning needed
      if (budget <= 8192) return { thinkingLevel: 'LOW' }; // Phase A: identity tasks
      return { thinkingLevel: 'MEDIUM' }; // Legacy single-pass: needs some reasoning
    }
    return { thinkingBudget: budget };
  }

  async estimateTokens(_input: TokenEstimationInput): Promise<TokenEstimate> {
    return { inputTokens: 0, estimatedCostUsd: 0 };
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private async waitForFileReady(fileName: string, timeoutMs = 120_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const file = await this.ai.files.get({ name: fileName });
      if (file.state === FileState.ACTIVE) return;
      if (file.state === FileState.FAILED) {
        throw new VlmError('Gemini video processing failed', 'FILE_PROCESSING_FAILED');
      }
      await sleep(1000);
    }
    throw new VlmError('Gemini video processing timed out', 'TIMEOUT');
  }

  private calcCost(input: number, output: number, thinking = 0): number {
    // Google tiers pricing at 200K context — above that, rates double
    const LONG_CTX_THRESHOLD = 200_000;
    const isLong = input > LONG_CTX_THRESHOLD;
    const inRate = isLong ? this.pricing.inputLong : this.pricing.input;
    const outRate = isLong ? this.pricing.outputLong : this.pricing.output;
    return (
      (input / 1_000_000) * inRate +
      (output / 1_000_000) * outRate +
      (thinking / 1_000_000) * this.pricing.thinking
    );
  }

  private parseCoachingReport(
    text: string,
    gameId: string,
  ): CoachingReport & Record<string, unknown> {
    const json = this.extractJson(text);
    if (!json) {
      return { overallAssessment: text, moments: [], topIssues: [], positiveHighlights: [] };
    }

    const game = gameRegistry.get(gameId);
    if (game) {
      return game.parseReport(json);
    }

    // Fallback for unknown games — return raw with minimal mapping
    return {
      ...json,
      overallAssessment: (json.match_verdict as string) ?? '',
      moments: [],
      topIssues: [],
      positiveHighlights: [],
    };
  }

  /**
   * Robustly extract JSON from Gemini's response text.
   * Handles: plain JSON, markdown code fences, leading/trailing whitespace.
   */
  private extractJson(text: string): Record<string, any> | null {
    const t = text.trim();

    try {
      return JSON.parse(t);
    } catch {
      /* continue */
    }

    const fenceMatch = t.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
    if (fenceMatch) {
      try {
        return JSON.parse(fenceMatch[1].trim());
      } catch {
        /* continue */
      }
    }

    const firstBrace = t.indexOf('{');
    const lastBrace = t.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      try {
        return JSON.parse(t.slice(firstBrace, lastBrace + 1));
      } catch {
        /* continue */
      }
    }

    // Last resort: log the failure so we can debug
    console.error(
      '[GeminiProvider] extractJson failed. text length:',
      t.length,
      'first 200 chars:',
      t.slice(0, 200),
    );
    return null;
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Race a promise against a timeout. Throws VlmError on timeout. */
function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new VlmError(message, 'TIMEOUT')), ms);
    promise.then(
      (val) => {
        clearTimeout(timer);
        resolve(val);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
