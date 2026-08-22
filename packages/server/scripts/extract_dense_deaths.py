"""
Extract dense frames around death moments from training videos.

1. Run HSV-style death detection (saturation drop + scene change)
2. For each detected death, extract at 5fps for ±5 seconds around it
3. Also extract spectating frames (5-15s after death)

Output: data/frames/{video_id}/death_dense_NNNNN.jpg (224x224 for training)
        data/review-deaths/{video_id}/death_NNNNN_full.jpg (720p for review)
"""

import os
import subprocess
import struct
import json
from pathlib import Path

DATA_DIR = Path("data")
FRAMES_DIR = DATA_DIR / "frames"
REVIEW_DIR = DATA_DIR / "review-deaths"

TRAINING_VIDEOS = {
    "cypher-aGs9eOH7Cjs": DATA_DIR / "training-videos" / "cypher-aGs9eOH7Cjs.mp4",
    "killjoy-_phEery87U4": DATA_DIR / "training-videos" / "killjoy-_phEery87U4.mp4",
    "omen-i7EmxFPkoQU": DATA_DIR / "training-videos" / "omen-i7EmxFPkoQU.mp4",
    "sova-j_JFmD7dOEI": DATA_DIR / "training-videos" / "sova-j_JFmD7dOEI.mp4",
}

# Also include local recordings if available
RECORDINGS_DIR = Path(os.environ.get("LOCALAPPDATA", "")) / "Scrima" / "recordings"
if RECORDINGS_DIR.exists():
    for f in RECORDINGS_DIR.glob("*.mp4"):
        if f.stem.startswith("test"):
            continue
        vid_id = f.stem[:8]  # short id
        TRAINING_VIDEOS[vid_id] = f

THUMB_W = 160
THUMB_H = 90
FRAME_BYTES = THUMB_W * THUMB_H * 3


def extract_thumbnails(video_path):
    """Extract 1fps RGB thumbnails for death detection."""
    import tempfile
    raw_path = tempfile.mktemp(suffix=".rgb")

    # Try CUDA first
    try:
        subprocess.run([
            "ffmpeg", "-hwaccel", "cuda", "-i", str(video_path),
            "-vf", f"fps=1,scale={THUMB_W}:{THUMB_H}",
            "-f", "rawvideo", "-pix_fmt", "rgb24",
            "-v", "quiet", "-y", raw_path,
        ], check=True, timeout=900)
    except (subprocess.CalledProcessError, FileNotFoundError):
        subprocess.run([
            "ffmpeg", "-i", str(video_path),
            "-vf", f"fps=1,scale={THUMB_W}:{THUMB_H}",
            "-f", "rawvideo", "-pix_fmt", "rgb24",
            "-v", "quiet", "-y", raw_path,
        ], check=True, timeout=900)

    with open(raw_path, "rb") as f:
        data = f.read()
    os.unlink(raw_path)
    return data


def detect_deaths_simple(raw_data):
    """Simple death detection: saturation drop + scene change."""
    num_frames = len(raw_data) // FRAME_BYTES
    if num_frames < 20:
        return []

    # Compute per-frame saturation
    saturations = []
    for i in range(num_frames):
        offset = i * FRAME_BYTES
        frame = raw_data[offset:offset + FRAME_BYTES]
        total_sat = 0
        count = 0
        for p in range(0, len(frame), 12):  # sample every 4th pixel
            r, g, b = frame[p], frame[p+1], frame[p+2]
            mx = max(r, g, b)
            mn = min(r, g, b)
            total_sat += (mx - mn) / mx if mx > 0 else 0
            count += 1
        saturations.append(total_sat / count if count > 0 else 0)

    # Compute scene diffs
    scene_diffs = [0]
    for i in range(1, num_frames):
        offset = i * FRAME_BYTES
        prev_offset = (i - 1) * FRAME_BYTES
        diff_sum = 0
        count = 0
        for p in range(0, FRAME_BYTES, 12):
            diff_sum += abs(raw_data[offset + p] - raw_data[prev_offset + p])
            diff_sum += abs(raw_data[offset + p + 1] - raw_data[prev_offset + p + 1])
            diff_sum += abs(raw_data[offset + p + 2] - raw_data[prev_offset + p + 2])
            count += 3
        scene_diffs.append(diff_sum / count if count > 0 else 0)

    # Find deaths: saturation drops below 75% of median
    med_sat = sorted(saturations)[len(saturations) // 2]
    threshold = med_sat * 0.70

    deaths = []
    i = 0
    while i < num_frames:
        if saturations[i] < threshold and scene_diffs[i] > 8:
            # Found potential death — expand window
            start = i
            while i < num_frames and saturations[i] < threshold * 1.3:
                i += 1
            end = i
            duration = end - start
            if duration >= 2:
                deaths.append(start)
                i = end + 8  # skip spectating gap
            else:
                i += 1
        else:
            i += 1

    return deaths


def extract_dense_frames(video_path, death_timestamps, video_id):
    """Extract frames at 5fps around each death moment."""
    frames_dir = FRAMES_DIR / video_id
    review_dir = REVIEW_DIR / video_id
    frames_dir.mkdir(parents=True, exist_ok=True)
    review_dir.mkdir(parents=True, exist_ok=True)

    total_extracted = 0

    for death_sec in death_timestamps:
        # Extract T-3 to T+12 at 5fps (death screen + spectating transition)
        start = max(0, death_sec - 3)
        duration = 15

        # Training frames (224x224)
        prefix = f"death_dense_{death_sec:05d}"
        subprocess.run([
            "ffmpeg", "-ss", str(start), "-i", str(video_path),
            "-t", str(duration),
            "-vf", f"fps=5,scale=224:224",
            "-q:v", "3", "-v", "quiet", "-y",
            str(frames_dir / f"{prefix}_%03d.jpg"),
        ], timeout=30)

        # Review frames (720p, readable)
        subprocess.run([
            "ffmpeg", "-ss", str(start), "-i", str(video_path),
            "-t", str(duration),
            "-vf", f"fps=5,scale=1280:720",
            "-q:v", "3", "-v", "quiet", "-y",
            str(review_dir / f"{prefix}_%03d.jpg"),
        ], timeout=30)

        count = len(list(frames_dir.glob(f"{prefix}_*.jpg")))
        total_extracted += count

    return total_extracted


def main():
    total_deaths = 0
    total_frames = 0

    for video_id, video_path in TRAINING_VIDEOS.items():
        if not video_path.exists():
            print(f"SKIP {video_id} — file not found: {video_path}")
            continue

        # Skip if dense frames already extracted for this video
        existing_dense = list((FRAMES_DIR / video_id).glob("death_dense_*.jpg"))
        if len(existing_dense) > 50:
            print(f"SKIP {video_id} — {len(existing_dense)} dense frames already exist")
            continue

        print(f"\n{'='*60}")
        print(f"Processing: {video_id}")
        print(f"  File: {video_path} ({video_path.stat().st_size / 1048576:.0f} MB)")

        # Step 1: Detect deaths
        print("  Extracting thumbnails for death detection...")
        raw = extract_thumbnails(video_path)
        num_frames = len(raw) // FRAME_BYTES
        print(f"  {num_frames} frames ({num_frames/60:.0f} min)")

        deaths = detect_deaths_simple(raw)
        print(f"  Detected {len(deaths)} deaths at: {deaths}")
        total_deaths += len(deaths)

        if not deaths:
            print("  No deaths found — skipping dense extraction")
            continue

        # Step 2: Dense extraction
        print(f"  Extracting dense frames (5fps × 15s × {len(deaths)} deaths)...")
        count = extract_dense_frames(video_path, deaths, video_id)
        print(f"  Extracted {count} training frames")
        total_frames += count

    print(f"\n{'='*60}")
    print(f"TOTAL: {total_deaths} deaths → {total_frames} dense frames")
    print(f"Training frames: {FRAMES_DIR}")
    print(f"Review frames (720p): {REVIEW_DIR}")


if __name__ == "__main__":
    main()
