/**
 * @deprecated This module is replaced by cv-analysis.service.ts.
 * Do not use - all functions return empty/stub data.
 * TODO: Remove this file once all references are cleaned up.
 *
 * Video Analyzer — Main orchestrator (DEPRECATED)
 *
 * Processes a gameplay video through the full CV pipeline:
 *   1. Extract frames at 1 fps
 *   2. Classify each frame's game state (ONNX model)
 *   3. Route to appropriate detectors based on state
 *   4. Build structured game timeline
 *   5. Generate coaching via text-only LLM
 *
 * All detection is local (ONNX models + pixel analysis).
 * Gemini is only called for:
 *   - Agent/map identification (once per game, $0.001)
 *   - Coaching text generation ($0.01-0.02)
 *   - Optional death frame positioning analysis ($0.005)
 */

import { GameTimelineBuilder, timelineToCoachingPrompt } from './game-timeline-builder.js';
import type { FrameDetectionResult, GameState, GameTimeline } from './game-timeline-builder.js';

// ── Types ──────────────────────────────────────────────────────────────────

interface AnalyzerConfig {
  /** Frames per second to extract (default: 1) */
  fps: number;
  /** Video resolution (auto-detected) */
  width: number;
  height: number;
  /** Path to ONNX models */
  modelDir: string;
  /** Path to game icon assets */
  assetsDir: string;
}

/** HUD region coordinates at 1280x720 (scaled for other resolutions) */
const _HUD_REGIONS_720P = {
  healthShield: { x: 310, y: 672, w: 200, h: 46 },
  abilityBar: { x: 430, y: 675, w: 320, h: 45 },
  credits: { x: 1130, y: 688, w: 150, h: 32 },
  killBanner: { x: 400, y: 400, w: 480, h: 100 }, // center-bottom area
  topHud: { x: 530, y: 28, w: 220, h: 42 },
  deathPanel: { x: 700, y: 50, w: 570, h: 450 },
  minimap: { x: 8, y: 30, w: 207, h: 210 },
} as const;

// ── Main Analyzer ──────────────────────────────────────────────────────────

/**
 * @deprecated Replaced by cv-analysis.service.ts. Do not use.
 *
 * Analyze a gameplay video and produce a structured timeline.
 *
 * This is the main entry point for the CV pipeline.
 *
 * @param videoPath Path to the gameplay video file
 * @param config Analyzer configuration
 * @returns Structured game timeline ready for coaching LLM
 */
export async function analyzeVideo(
  _videoPath: string,
  config: Partial<AnalyzerConfig> = {},
): Promise<GameTimeline> {
  const cfg: AnalyzerConfig = {
    fps: config.fps ?? 1,
    width: config.width ?? 1280,
    height: config.height ?? 720,
    modelDir: config.modelDir ?? 'src/services/coaching/models',
    assetsDir: config.assetsDir ?? 'data/assets',
  };

  // Scale HUD regions for actual resolution
  const _scaleX = cfg.width / 1280;
  const _scaleY = cfg.height / 720;

  const builder = new GameTimelineBuilder();

  // TODO: Load ONNX models
  // const stateClassifier = await loadOnnxModel(cfg.modelDir + '/valorant-classifier.onnx');
  // const healthReader = await loadOnnxModel(cfg.modelDir + '/health-reader.onnx');
  // const shieldReader = await loadOnnxModel(cfg.modelDir + '/shield-reader.onnx');
  // const creditsReader = await loadOnnxModel(cfg.modelDir + '/credits-reader.onnx');

  // TODO: Extract frames from video at cfg.fps
  // const frames = await extractFrames(videoPath, cfg.fps);

  // TODO: For each frame, run detection pipeline
  // for (const { image, timestamp } of frames) {
  //   const gameState = classifyGameState(stateClassifier, image);
  //   const result = await detectFrame(image, timestamp, gameState, cfg, scaleX, scaleY);
  //   builder.processFrame(result);
  // }

  // TODO: Identify agent and map (once per game)
  // const { agent, map } = await identifyAgentAndMap(firstGameplayFrame);
  // builder.setPlayerAgent(agent);
  // builder.setMap(map);

  return builder.build();
}

/**
 * Detect all relevant information from a single frame.
 * Routes to different detectors based on game state.
 */
function detectFrame(
  _image: Buffer,
  timestamp: number,
  gameState: GameState,
  _config: AnalyzerConfig,
  _scaleX: number,
  _scaleY: number,
): FrameDetectionResult {
  const result: FrameDetectionResult = { timestamp, gameState };

  switch (gameState) {
    case 'gameplay': {
      // Run health/shield reader on cropped region
      // result.health = runHealthReader(crop(image, HUD_REGIONS_720P.healthShield, scaleX, scaleY));
      // result.shield = runShieldReader(crop(image, HUD_REGIONS_720P.healthShield, scaleX, scaleY));

      // Check for kill banner (HSV yellow detection)
      // result.killDetected = detectKillBanner(image, scaleX, scaleY);

      // Check ability bar brightness for usage tracking
      // result.abilityStatuses = checkAbilityBar(image, scaleX, scaleY);
      break;
    }
    case 'death_screen': {
      // Read death screen info (enemy agent, weapon, damage)
      // result.deathScreenInfo = readDeathScreen(crop(image, HUD_REGIONS_720P.deathPanel, scaleX, scaleY));
      break;
    }
    case 'buy_phase': {
      // Read credits
      // result.creditsRange = runCreditsReader(crop(image, HUD_REGIONS_720P.credits, scaleX, scaleY));
      break;
    }
  }

  return result;
}

// ── HSV Kill Banner Detection ──────────────────────────────────────────────

/**
 * Detect kill banner by looking for yellow highlight in the killfeed area.
 * HSV range: H=[27,41], S=[47,135], V=[187,255]
 *
 * @returns true if a kill banner is detected in this frame
 */
export function detectKillBanner(_hsvImage: unknown, _scaleX: number, _scaleY: number): boolean {
  // TODO: Implement with cv2-equivalent in Node.js (sharp or opencv4nodejs)
  // const roi = cropRegion(hsvImage, killBannerRegion);
  // const yellowMask = inRange(roi, [27, 47, 187], [41, 135, 255]);
  // const yellowRatio = countNonZero(yellowMask) / (roi.width * roi.height);
  // return yellowRatio > 0.05; // >5% yellow pixels = kill banner
  return false;
}

// ── Ability Bar Brightness Check ───────────────────────────────────────────

/**
 * Check ability bar icons for brightness to determine availability.
 * Available ability = bright icon (V > 150)
 * Used/cooldown = dim icon (V < 100)
 *
 * @returns Map of ability slot → status
 */
export function checkAbilityBar(
  _image: unknown,
  _scaleX: number,
  _scaleY: number,
): Record<string, string> {
  // TODO: Implement
  // For each of 4 ability slots (C, Q, E, X):
  //   1. Crop the ability icon region
  //   2. Convert to HSV
  //   3. Measure average brightness (V channel)
  //   4. If V > 150: "available", else "used"
  return {};
}

// ── Coaching Generation ────────────────────────────────────────────────────

/**
 * Generate coaching text from a game timeline.
 * Sends structured text (not video) to Gemini.
 *
 * @param timeline The structured game timeline
 * @returns Coaching text
 */
export async function generateCoaching(timeline: GameTimeline): Promise<string> {
  const prompt = timelineToCoachingPrompt(timeline);

  // TODO: Send to Gemini text-only model
  // const response = await gemini.generateContent({
  //   contents: [{ role: 'user', parts: [{ text: coachingSystemPrompt + prompt }] }],
  // });

  return prompt; // For now, return the structured data
}
