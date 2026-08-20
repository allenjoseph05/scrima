/**
 * @deprecated Replaced by frame-analysis.service.ts.
 * Kept for backwards compatibility with old client video uploads.
 * Will be removed in a future version.
 */

/**
 * ONNX Model Loader — Manages all trained CV models
 *
 * Loads and provides inference for all ONNX models:
 *   - Game state classifier (6 classes)
 *   - Health reader (5 bins)
 *   - Shield reader (3 classes)
 *   - Credits reader (6 bins)
 *   - Agent classifier (28+ classes) — when trained
 *   - Map classifier — when trained
 *   - Death screen reader — when trained
 *
 * All models are MobileNetV2, 224x224 input (except HUD readers at 128x128).
 * Lazy-loaded on first use. Singleton per model.
 */

import fs from 'node:fs';
import path from 'node:path';
import * as ort from 'onnxruntime-node';
import sharp from 'sharp';

// ── Config ──────────────────────────────────────────────────────────────────

const MODEL_DIR = path.resolve(
  path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Z]:)/, '$1'),
  'models',
);

const IMAGENET_MEAN = [0.485, 0.456, 0.406];
const IMAGENET_STD = [0.229, 0.224, 0.225];

// ── Model Registry ─────────────────────────────────────────────────────────

interface ModelInfo {
  file: string;
  imageSize: number;
  classes: string[];
}

const MODELS: Record<string, ModelInfo> = {
  gameState: {
    file: 'valorant-classifier.onnx',
    imageSize: 224,
    classes: ['gameplay', 'death_screen', 'spectating', 'buy_phase', 'round_end', 'loading'],
  },
  health: { file: 'health-reader.onnx', imageSize: 128, classes: [] },
  shield: { file: 'shield-reader.onnx', imageSize: 128, classes: [] },
  credits: { file: 'credits-reader.onnx', imageSize: 128, classes: [] },
  weapon: { file: 'weapon-classifier.onnx', imageSize: 224, classes: [] },
  agent: { file: 'agent-classifier.onnx', imageSize: 224, classes: [] },
};

// Load class names from .classes.txt files
function loadClasses(modelName: string): string[] {
  const info = MODELS[modelName];
  if (!info) return [];

  // If classes already loaded, return them
  if (info.classes.length > 0) return info.classes;

  // Try loading from .classes.txt
  const classFile = path.join(MODEL_DIR, info.file.replace('.onnx', '.classes.txt'));
  if (fs.existsSync(classFile)) {
    info.classes = fs
      .readFileSync(classFile, 'utf-8')
      .trim()
      .split('\n')
      .map((s) => s.trim());
  }
  return info.classes;
}

// ── Session Cache ──────────────────────────────────────────────────────────

const sessions: Map<string, ort.InferenceSession> = new Map();
const loading: Map<string, Promise<ort.InferenceSession>> = new Map();

async function getSession(modelName: string): Promise<ort.InferenceSession | null> {
  const info = MODELS[modelName];
  if (!info) return null;

  const modelPath = path.join(MODEL_DIR, info.file);
  if (!fs.existsSync(modelPath)) return null;

  if (sessions.has(modelName)) return sessions.get(modelName)!;
  if (loading.has(modelName)) return loading.get(modelName)!;

  const promise = ort.InferenceSession.create(modelPath, {
    executionProviders: ['cpu'], // CPU for reliability, GPU optional
  })
    .then((sess) => {
      sessions.set(modelName, sess);
      loading.delete(modelName);
      return sess;
    })
    .catch((err) => {
      loading.delete(modelName); // Allow retry on next call
      throw err;
    });

  loading.set(modelName, promise);
  return promise;
}

// ── Preprocessing ──────────────────────────────────────────────────────────

/**
 * Preprocess an image for MobileNetV2 inference.
 * Resize → normalize with ImageNet mean/std → convert to tensor format.
 */
async function preprocessImage(imageBuffer: Buffer, imageSize: number): Promise<ort.Tensor> {
  // Resize to target size and get raw RGB pixels
  const { data, info } = await sharp(imageBuffer)
    .resize(imageSize, imageSize, { fit: 'fill' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  // Convert to float32 in NCHW format with ImageNet normalization
  const float32 = new Float32Array(3 * imageSize * imageSize);
  const pixelCount = imageSize * imageSize;

  for (let i = 0; i < pixelCount; i++) {
    const r = data[i * 3] / 255;
    const g = data[i * 3 + 1] / 255;
    const b = data[i * 3 + 2] / 255;

    float32[i] = (r - IMAGENET_MEAN[0]) / IMAGENET_STD[0]; // R channel
    float32[pixelCount + i] = (g - IMAGENET_MEAN[1]) / IMAGENET_STD[1]; // G channel
    float32[2 * pixelCount + i] = (b - IMAGENET_MEAN[2]) / IMAGENET_STD[2]; // B channel
  }

  return new ort.Tensor('float32', float32, [1, 3, imageSize, imageSize]);
}

// ── Inference ──────────────────────────────────────────────────────────────

export interface PredictionResult {
  label: string;
  classIndex: number;
  confidence: number;
  allScores: Record<string, number>;
}

/**
 * Run classification inference on an image.
 *
 * @param modelName Which model to use (gameState, health, shield, credits, weapon, agent)
 * @param imageBuffer JPEG/PNG image buffer
 * @returns Prediction with label, confidence, and all scores
 */
export async function classify(
  modelName: string,
  imageBuffer: Buffer,
): Promise<PredictionResult | null> {
  const info = MODELS[modelName];
  if (!info) return null;

  const session = await getSession(modelName);
  if (!session) return null;

  const classes = loadClasses(modelName);

  // Preprocess
  const tensor = await preprocessImage(imageBuffer, info.imageSize);

  // Run inference
  const feeds = { input: tensor };
  const results = await session.run(feeds);
  const outputName = session.outputNames[0];
  const output = results[outputName];
  if (!output) throw new Error(`Model output '${outputName}' not found`);

  // Get scores
  const scores = output.data as Float32Array;

  // Softmax
  const maxScore = Math.max(...Array.from(scores));
  const expScores = Array.from(scores).map((s) => Math.exp(s - maxScore));
  const sumExp = expScores.reduce((a, b) => a + b, 0);
  const probs = expScores.map((s) => s / sumExp);

  // Find best class
  let bestIdx = 0;
  let bestProb = 0;
  for (let i = 0; i < probs.length; i++) {
    if (probs[i] > bestProb) {
      bestProb = probs[i];
      bestIdx = i;
    }
  }

  const allScores: Record<string, number> = {};
  for (let i = 0; i < probs.length; i++) {
    const label = classes[i] ?? `class_${i}`;
    allScores[label] = probs[i];
  }

  return {
    label: classes[bestIdx] ?? `class_${bestIdx}`,
    classIndex: bestIdx,
    confidence: bestProb,
    allScores,
  };
}

/**
 * Check which models are available.
 */
export function getAvailableModels(): string[] {
  return Object.entries(MODELS)
    .filter(([_, info]) => fs.existsSync(path.join(MODEL_DIR, info.file)))
    .map(([name]) => name);
}
