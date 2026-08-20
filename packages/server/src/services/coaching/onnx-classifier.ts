/**
 * @deprecated Replaced by frame-analysis.service.ts.
 * Kept for backwards compatibility with old client video uploads.
 * Will be removed in a future version.
 */

/**
 * ONNX Frame Classifier
 *
 * Loads the trained MobileNetV2 ONNX model and classifies Valorant frames
 * into 6 game states: gameplay, death_screen, spectating, buy_phase, round_end, loading.
 *
 * - Lazy-loads model on first use (singleton)
 * - Preprocesses frames with sharp (resize 224x224, normalize ImageNet)
 * - Inference via onnxruntime-node (~30ms CPU, ~10ms GPU)
 * - Returns class label + confidence score
 */

import fs from 'node:fs';
import path from 'node:path';
import * as ort from 'onnxruntime-node';
import sharp from 'sharp';

// ── Config ───────────────────────────────────────────────────────────────────

const CLASSES = [
  'gameplay',
  'death_screen',
  'spectating',
  'buy_phase',
  'round_end',
  'loading',
] as const;
export type FrameClass = (typeof CLASSES)[number];

const IMAGE_SIZE = 224;
const IMAGENET_MEAN = [0.485, 0.456, 0.406];
const IMAGENET_STD = [0.229, 0.224, 0.225];

// Model path — relative to the compiled dist directory
const MODEL_PATH = path.resolve(
  path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Z]:)/, '$1'),
  'models',
  'valorant-classifier.onnx',
);

// ── Types ────────────────────────────────────────────────────────────────────

export interface ClassificationResult {
  label: FrameClass;
  confidence: number;
  allScores: Record<FrameClass, number>;
}

// ── Singleton session ────────────────────────────────────────────────────────

let session: ort.InferenceSession | null = null;
let sessionLoading: Promise<ort.InferenceSession> | null = null;

async function getSession(): Promise<ort.InferenceSession> {
  if (session) return session;
  if (sessionLoading) return sessionLoading;

  sessionLoading = (async () => {
    // Check model file exists
    // Try multiple possible paths
    let modelPath = MODEL_PATH;
    if (!fs.existsSync(modelPath)) {
      // Try from src directory (dev mode)
      const srcPath = path.resolve('src/services/coaching/models/valorant-classifier.onnx');
      if (fs.existsSync(srcPath)) modelPath = srcPath;
      else {
        // Try from project root
        const rootPath = path.resolve('models/valorant-classifier.onnx');
        if (fs.existsSync(rootPath)) modelPath = rootPath;
        else throw new Error(`ONNX model not found at ${MODEL_PATH} or ${srcPath}`);
      }
    }

    console.log('[OnnxClassifier] loading model from:', modelPath);
    const s = await ort.InferenceSession.create(modelPath, {
      executionProviders: ['cpu'], // CPU is fast enough (~30ms) and most compatible
    });
    console.log('[OnnxClassifier] model loaded, inputs:', s.inputNames, 'outputs:', s.outputNames);
    session = s;
    return s;
  })().catch((err) => {
    sessionLoading = null; // Allow retry on next call
    throw err;
  });

  return sessionLoading;
}

// ── Preprocessing ────────────────────────────────────────────────────────────

/**
 * Preprocess a JPEG image buffer into a normalized float32 tensor.
 * Resize to 224x224, convert to RGB float32, normalize with ImageNet stats.
 * Output shape: [1, 3, 224, 224] (NCHW format)
 */
async function preprocessFrame(imageBuffer: Buffer): Promise<ort.Tensor> {
  // Resize to 224x224 and get raw RGB pixels
  const { data } = await sharp(imageBuffer)
    .resize(IMAGE_SIZE, IMAGE_SIZE, { fit: 'fill' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  // Convert to float32 NCHW format with ImageNet normalization
  const float32 = new Float32Array(3 * IMAGE_SIZE * IMAGE_SIZE);
  const pixelCount = IMAGE_SIZE * IMAGE_SIZE;

  for (let i = 0; i < pixelCount; i++) {
    float32[i] = (data[i * 3] / 255 - IMAGENET_MEAN[0]) / IMAGENET_STD[0]; // R
    float32[i + pixelCount] = (data[i * 3 + 1] / 255 - IMAGENET_MEAN[1]) / IMAGENET_STD[1]; // G
    float32[i + 2 * pixelCount] = (data[i * 3 + 2] / 255 - IMAGENET_MEAN[2]) / IMAGENET_STD[2]; // B
  }

  return new ort.Tensor('float32', float32, [1, 3, IMAGE_SIZE, IMAGE_SIZE]);
}

/** Softmax function */
function softmax(logits: Float32Array | number[]): number[] {
  const maxLogit = Math.max(...logits);
  const exps = Array.from(logits).map((l) => Math.exp(l - maxLogit));
  const sum = exps.reduce((a, b) => a + b, 0);
  return exps.map((e) => e / sum);
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Classify a single frame.
 * @param imageBuffer - JPEG or PNG image buffer
 * @returns Classification result with label, confidence, and all class scores
 */
export async function classifyFrame(imageBuffer: Buffer): Promise<ClassificationResult> {
  const sess = await getSession();
  const inputTensor = await preprocessFrame(imageBuffer);

  const results = await sess.run({ input: inputTensor });
  const output = results[sess.outputNames[0]];
  const logits = output.data as Float32Array;

  const probs = softmax(logits);
  let maxIdx = 0;
  for (let i = 1; i < probs.length; i++) {
    if (probs[i] > probs[maxIdx]) maxIdx = i;
  }

  const allScores = {} as Record<FrameClass, number>;
  for (let i = 0; i < CLASSES.length; i++) {
    allScores[CLASSES[i]] = probs[i];
  }

  return {
    label: CLASSES[maxIdx],
    confidence: probs[maxIdx],
    allScores,
  };
}

/**
 * Classify multiple frames in sequence.
 * @param imageBuffers - Array of JPEG/PNG image buffers
 * @returns Array of classification results
 */
export async function classifyFrames(imageBuffers: Buffer[]): Promise<ClassificationResult[]> {
  const results: ClassificationResult[] = [];
  for (const buf of imageBuffers) {
    results.push(await classifyFrame(buf));
  }
  return results;
}

/**
 * Check if the ONNX model file exists and can be loaded.
 */
export function isModelAvailable(): boolean {
  return (
    fs.existsSync(MODEL_PATH) ||
    fs.existsSync(path.resolve('src/services/coaching/models/valorant-classifier.onnx'))
  );
}
