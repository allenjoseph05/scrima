/**
 * Extract Training Frames
 *
 * Extracts 1 frame every 3 seconds at 224x224 from all usable recordings.
 * Uses CUDA acceleration when available.
 *
 * Output: data/frames/{video_id}/frame_NNNN.jpg
 * Manifest: data/manifest.csv (video_id, seconds, frame_path)
 *
 * Usage: node scripts/extract-training-frames.mjs
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const DATA_DIR = path.resolve('data');
const FRAMES_DIR = path.join(DATA_DIR, 'frames');
const MANIFEST_PATH = path.join(DATA_DIR, 'manifest.csv');
const FRAME_INTERVAL = 3; // 1 frame every 3 seconds
const FRAME_SIZE = 224; // 224x224 for MobileNetV2

// All usable videos (>60 seconds)
const VIDEOS = [
  // Analysis copies (1fps, small, preferred)
  {
    path: 'C:/Users/Allen Joseph/AppData/Local/scrima/analysis/4c86a5d9-8612-404f-ac67-cc2c9e356f9c_analysis.mp4',
    id: '4c86a5d9',
  },
  {
    path: 'C:/Users/Allen Joseph/AppData/Local/scrima/analysis/c95a45af-3008-4f78-a81f-ea8b02b4628e_analysis.mp4',
    id: 'c95a45af',
  },
  {
    path: 'C:/Users/Allen Joseph/AppData/Local/scrima/analysis/d15fdc39-6070-441f-94aa-ae3253f1419f_analysis.mp4',
    id: 'd15fdc39',
  },
  {
    path: 'C:/Users/Allen Joseph/AppData/Local/scrima/analysis/c0fc702a-ba66-4a8f-9e94-3fa8d1a8eaf6_analysis.mp4',
    id: 'c0fc702a',
  },
  {
    path: 'C:/Users/Allen Joseph/AppData/Local/scrima/analysis/d0e1f2a3-b4c5-6789-abcd-ef0123456789_analysis.mp4',
    id: 'd0e1f2a3',
  },
  // Full recordings (60fps, will be downsampled)
  {
    path: 'C:/Users/Allen Joseph/AppData/Local/scrima/recordings/test-jett-competitive.mp4',
    id: 'test-jett',
  },
  {
    path: 'C:/Users/Allen Joseph/AppData/Local/scrima/recordings/test-omen-match.mp4',
    id: 'test-omen',
  },
  {
    path: 'C:/Users/Allen Joseph/AppData/Local/scrima/recordings/test-raze-match.mp4',
    id: 'test-raze',
  },
  {
    path: 'C:/Users/Allen Joseph/AppData/Local/scrima/recordings/test-reyna-competitive.mp4',
    id: 'test-reyna',
  },
  {
    path: 'C:/Users/Allen Joseph/AppData/Local/scrima/recordings/test-sage-match.mp4',
    id: 'test-sage',
  },
  {
    path: 'C:/Users/Allen Joseph/AppData/Local/scrima/recordings/test-sova-competitive.mp4',
    id: 'test-sova',
  },
  {
    path: 'C:/Users/Allen Joseph/AppData/Local/scrima/recordings/test-cypher-competitive.mp4',
    id: 'test-cypher',
  },
  {
    path: 'C:/Users/Allen Joseph/AppData/Local/scrima/recordings/test-deathmatch-gameplay.mp4',
    id: 'test-dm',
  },
  // Test videos (YouTube VODs — different quality, overlays)
  {
    path: 'C:/Users/Allen Joseph/Desktop/scrima/test-videos/breach-s0m-lotus-gameplay.mp4',
    id: 'breach-lotus',
  },
  {
    path: 'C:/Users/Allen Joseph/Desktop/scrima/test-videos/waylay-s0m-gameplay.mp4',
    id: 'waylay-s0m',
  },
  {
    path: 'C:/Users/Allen Joseph/Desktop/scrima/test-videos/cypher-abyss-gameplay.mp4',
    id: 'cypher-abyss',
  },
  // Long recording
  {
    path: 'C:/Users/Allen Joseph/AppData/Local/scrima/recordings/a46714a7-5051-4070-9e01-90d747f6e4bd.mp4',
    id: 'a46714a7',
  },
];

async function main() {
  fs.mkdirSync(FRAMES_DIR, { recursive: true });

  const manifest = ['video_id,seconds,frame_path'];
  let totalFrames = 0;
  let totalVideos = 0;

  // Check CUDA
  let hasCuda = false;
  try {
    execFileSync(
      'ffmpeg',
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-hwaccel',
        'cuda',
        '-f',
        'lavfi',
        '-i',
        'nullsrc=s=64x64:d=0.04',
        '-frames:v',
        '1',
        '-f',
        'null',
        '-',
      ],
      { timeout: 5000, stdio: 'pipe' },
    );
    hasCuda = true;
  } catch {}
  console.log('CUDA acceleration:', hasCuda ? 'YES' : 'NO (using CPU)');

  for (const video of VIDEOS) {
    if (!fs.existsSync(video.path)) {
      console.log(`SKIP ${video.id}: file not found`);
      continue;
    }

    // Get duration
    let duration;
    try {
      const out = execFileSync(
        'ffprobe',
        ['-v', 'quiet', '-show_entries', 'format=duration', '-of', 'csv=p=0', video.path],
        { timeout: 10000, encoding: 'utf8' },
      );
      duration = Math.floor(Number.parseFloat(out.trim()));
    } catch {
      console.log(`SKIP ${video.id}: can't read duration`);
      continue;
    }

    if (duration < 60) {
      console.log(`SKIP ${video.id}: too short (${duration}s)`);
      continue;
    }

    const videoFrameDir = path.join(FRAMES_DIR, video.id);

    // Check if already extracted (resume support)
    if (fs.existsSync(videoFrameDir)) {
      const existing = fs.readdirSync(videoFrameDir).filter((f) => f.endsWith('.jpg'));
      const expected = Math.floor(duration / FRAME_INTERVAL);
      if (existing.length >= expected * 0.9) {
        console.log(`SKIP ${video.id}: already extracted (${existing.length} frames)`);
        // Add to manifest
        for (const f of existing) {
          const sec = Number.parseInt(f.replace('frame_', '').replace('.jpg', '')) * FRAME_INTERVAL;
          manifest.push(`${video.id},${sec},${path.join(videoFrameDir, f)}`);
          totalFrames++;
        }
        totalVideos++;
        continue;
      }
    }

    fs.mkdirSync(videoFrameDir, { recursive: true });

    console.log(`Extracting ${video.id} (${duration}s / ${Math.floor(duration / 60)}min)...`);
    const start = Date.now();

    try {
      const ffmpegArgs = [
        ...(hasCuda ? ['-hwaccel', 'cuda'] : []),
        '-i',
        video.path,
        '-vf',
        `fps=1/${FRAME_INTERVAL},scale=${FRAME_SIZE}:${FRAME_SIZE}`,
        '-q:v',
        '2',
        '-v',
        'quiet',
        '-y',
        path.join(videoFrameDir, 'frame_%04d.jpg'),
      ];

      execFileSync('ffmpeg', ffmpegArgs, { timeout: 300000 }); // 5 min timeout

      const frames = fs.readdirSync(videoFrameDir).filter((f) => f.endsWith('.jpg'));
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      console.log(`  → ${frames.length} frames in ${elapsed}s`);

      for (let i = 0; i < frames.length; i++) {
        const sec = (i + 1) * FRAME_INTERVAL;
        manifest.push(`${video.id},${sec},${path.join(videoFrameDir, frames[i])}`);
      }
      totalFrames += frames.length;
      totalVideos++;
    } catch (err) {
      console.log(`  ERROR: ${err.message?.slice(0, 100)}`);
    }
  }

  // Write manifest
  fs.writeFileSync(MANIFEST_PATH, manifest.join('\n'));
  console.log('\n=== DONE ===');
  console.log(`Videos: ${totalVideos}`);
  console.log(`Frames: ${totalFrames}`);
  console.log(`Manifest: ${MANIFEST_PATH}`);
}

main().catch((err) => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
