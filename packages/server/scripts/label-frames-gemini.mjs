/**
 * Auto-Label Frames with Gemini Flash
 *
 * Reads manifest.csv, sends each frame to Gemini 2.5 Flash for classification.
 * Batches 8 frames per API call for efficiency.
 * Supports resume (skips already-labeled frames).
 *
 * Output: data/labels.csv (frame_path, label, confidence, video_id)
 *
 * Usage: GEMINI_API_KEY=key node scripts/label-frames-gemini.mjs
 *
 * Cost estimate: ~$1.30 for 11,000 frames
 */

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const DATA_DIR = path.resolve('data');
const MANIFEST_PATH = path.join(DATA_DIR, 'manifest.csv');
const LABELS_PATH = path.join(DATA_DIR, 'labels.csv');

const BATCH_SIZE = 8; // frames per API call
const CONCURRENCY = 3; // parallel API calls
const MODEL = 'gemini-2.5-flash'; // Use Flash (not lite) for better labeling accuracy

const PROMPT = `Classify each Valorant game frame into exactly ONE category:
- gameplay: Player is alive and in control. HUD visible (minimap top-left, abilities bottom-center, health bottom-left, weapon bottom-right). First-person view of the game world during an active round.
- death_screen: Player just died. Screen may be desaturated/grayed out. May show "ELIMINATED BY" text, combat report panel on the right, or death animation. Player's own HUD (abilities, health) is ABSENT.
- spectating: Player is dead and watching a teammate play. Shows "SWITCH PLAYER" text at bottom. A DIFFERENT player's HUD/abilities visible. Combat report may be visible on right side.
- buy_phase: Weapon shop/buy menu is open. Dark blue/teal UI panel. Economy numbers visible. Player buying weapons/abilities.
- round_end: Match transition. "WON"/"LOST"/"VICTORY"/"DEFEAT" banner visible on screen. Or end-of-half scoreboard. Or "FLAWLESS" text.
- loading: Black screen, loading screen, agent select screen, map loading, alt-tabbed, or any non-gameplay screen.

For each frame, output the classification. If unclear between two classes, pick the most likely one.`;

const SCHEMA = {
  type: 'object',
  properties: {
    frames: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          label: {
            type: 'string',
            enum: ['gameplay', 'death_screen', 'spectating', 'buy_phase', 'round_end', 'loading'],
          },
          confidence: { type: 'number', description: '0.0 to 1.0' },
        },
        required: ['label', 'confidence'],
      },
    },
  },
  required: ['frames'],
};

async function main() {
  if (!process.env.GEMINI_API_KEY) {
    console.error('GEMINI_API_KEY not set');
    process.exit(1);
  }

  if (!fs.existsSync(MANIFEST_PATH)) {
    console.error('manifest.csv not found. Run extract-training-frames.mjs first.');
    process.exit(1);
  }

  // Build server to get GeminiProvider
  console.log('Building...');
  execSync('npx tsc --project tsconfig.json', { cwd: path.resolve('.'), stdio: 'pipe' });
  const { GeminiProvider } = await import(
    pathToFileURL(path.resolve('dist/services/vlm/gemini.provider.js')).href
  );
  const vlm = new GeminiProvider(MODEL);

  // Read manifest
  const manifest = fs.readFileSync(MANIFEST_PATH, 'utf8').trim().split('\n').slice(1); // skip header
  console.log(`Manifest: ${manifest.length} frames\n`);

  // Load existing labels for resume support
  const existingLabels = new Set();
  if (fs.existsSync(LABELS_PATH)) {
    const existing = fs.readFileSync(LABELS_PATH, 'utf8').trim().split('\n').slice(1);
    for (const line of existing) {
      const framePath = line.split(',')[0];
      existingLabels.add(framePath);
    }
    console.log(`Resuming: ${existingLabels.size} frames already labeled\n`);
  }

  // Filter to unlabeled frames
  const unlabeled = manifest.filter((line) => {
    const framePath = line.split(',')[2];
    return !existingLabels.has(framePath);
  });
  console.log(`To label: ${unlabeled.length} frames\n`);

  if (unlabeled.length === 0) {
    console.log('All frames already labeled!');
    return;
  }

  // Initialize labels file with header if new
  if (!fs.existsSync(LABELS_PATH)) {
    fs.writeFileSync(LABELS_PATH, 'frame_path,label,confidence,video_id\n');
  }

  let totalCost = 0;
  let labeled = 0;
  let errors = 0;
  const startTime = Date.now();

  // Process in batches
  const batches = [];
  for (let i = 0; i < unlabeled.length; i += BATCH_SIZE) {
    batches.push(unlabeled.slice(i, i + BATCH_SIZE));
  }

  console.log(
    `Batches: ${batches.length} (${BATCH_SIZE} frames each, ${CONCURRENCY} concurrent)\n`,
  );

  for (let b = 0; b < batches.length; b += CONCURRENCY) {
    const concurrentBatches = batches.slice(b, b + CONCURRENCY);

    const results = await Promise.all(
      concurrentBatches.map(async (batch) => {
        const images = [];
        const frameInfos = [];

        for (const line of batch) {
          const [videoId, sec, framePath] = line.split(',');
          if (!fs.existsSync(framePath)) continue;

          const base64 = fs.readFileSync(framePath, { encoding: 'base64' });
          images.push({ label: `frame_${videoId}_${sec}`, base64, mimeType: 'image/jpeg' });
          frameInfos.push({ videoId, sec, framePath });
        }

        if (images.length === 0) return [];

        try {
          const resp = await vlm.verifyWithImages(
            images,
            `${PROMPT}\n\nYou are looking at ${images.length} frames. Return exactly ${images.length} classifications in order.`,
            SCHEMA,
            30000,
            MODEL,
            512,
            0, // no thinking needed for classification
          );

          totalCost += resp.costUsd;
          const frameLabels = resp.result?.frames || [];

          const results = [];
          for (let i = 0; i < Math.min(frameInfos.length, frameLabels.length); i++) {
            results.push({
              framePath: frameInfos[i].framePath,
              label: frameLabels[i].label || 'gameplay',
              confidence: frameLabels[i].confidence || 0.5,
              videoId: frameInfos[i].videoId,
            });
          }
          return results;
        } catch {
          errors++;
          return [];
        }
      }),
    );

    // Write results to labels file
    const lines = [];
    for (const batchResult of results) {
      for (const r of batchResult) {
        lines.push(`${r.framePath},${r.label},${r.confidence},${r.videoId}`);
        labeled++;
      }
    }
    if (lines.length > 0) {
      fs.appendFileSync(LABELS_PATH, `${lines.join('\n')}\n`);
    }

    // Progress
    const progress = (((b + concurrentBatches.length) / batches.length) * 100).toFixed(1);
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
    const rate = labeled > 0 ? ((labeled / (Date.now() - startTime)) * 1000).toFixed(1) : 0;
    process.stdout.write(
      `\r  ${progress}% | ${labeled}/${unlabeled.length} frames | $${totalCost.toFixed(4)} | ${rate} frames/sec | ${elapsed}s | ${errors} errors`,
    );
  }

  console.log('\n\n=== DONE ===');
  console.log(`Labeled: ${labeled} frames`);
  console.log(`Errors: ${errors}`);
  console.log(`Cost: $${totalCost.toFixed(4)}`);
  console.log(`Labels: ${LABELS_PATH}`);

  // Print class distribution
  const allLabels = fs.readFileSync(LABELS_PATH, 'utf8').trim().split('\n').slice(1);
  const dist = {};
  for (const line of allLabels) {
    const label = line.split(',')[1];
    dist[label] = (dist[label] || 0) + 1;
  }
  console.log('\nClass distribution:');
  for (const [cls, count] of Object.entries(dist).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${cls}: ${count} (${((count / allLabels.length) * 100).toFixed(1)}%)`);
  }
}

main().catch((err) => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
