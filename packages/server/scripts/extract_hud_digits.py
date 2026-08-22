"""
Extract HUD digit crops from Valorant gameplay videos.

Extracts frames at regular intervals, crops HUD regions containing numbers,
and prepares them for auto-labeling with Gemini Flash.

HUD regions (1280x720 base, scaled for other resolutions):
  - health: the HP number (bottom-center)
  - shield: the shield number in badge (bottom-center-left)
  - ammo_current: magazine count (bottom-right)
  - ammo_reserve: reserve count (bottom-right)
  - timer: round timer MM:SS (top-center)
  - score_left: left team rounds won (top-center-left)
  - score_right: right team rounds won (top-center-right)
  - credits: credits/money (bottom-right or top during buy)

Output:
  data/datasets/digit-classifier/crops/  - individual HUD region crops
  data/datasets/digit-classifier/manifest.csv  - paths + metadata
"""

import os
import csv
import subprocess
import sys
from pathlib import Path
from PIL import Image

# ── Config ──────────────────────────────────────────────────────────────────

VIDEO_DIR = Path("../../test-videos")
SERVER_VIDEO_DIR = Path(".")
DATA_DIR = Path("data/datasets/digit-classifier")
CROPS_DIR = DATA_DIR / "crops"
FRAMES_DIR = DATA_DIR / "frames_fullres"
MANIFEST = DATA_DIR / "manifest.csv"

# Extract a frame every N seconds
FRAME_INTERVAL = 5

# Max frames per video (to keep dataset manageable)
MAX_FRAMES_PER_VIDEO = 150

# HUD region definitions for 1280x720
# (x1, y1, x2, y2) - these have been refined from visual inspection
REGIONS_720p = {
    # Health number - large white text, bottom-center
    # Adjusted based on actual frame inspection
    "health": (395, 682, 490, 712),

    # Shield number - inside green/blue badge, left of health
    "shield": (335, 682, 385, 712),

    # Ammo current magazine - bottom-right
    "ammo_mag": (1140, 682, 1185, 712),

    # Ammo reserve - smaller, right of magazine
    "ammo_reserve": (1195, 690, 1235, 712),

    # Timer - top center (MM:SS format)
    "timer": (600, 38, 680, 62),

    # Score left team - top center, left of timer
    "score_left": (560, 38, 598, 62),

    # Score right team - top center, right of timer
    "score_right": (682, 38, 720, 62),

    # Credits - bottom-right corner (visible during gameplay + buy)
    "credits": (1175, 698, 1275, 718),

    # Ultimate charge - bottom center, below abilities
    "ult_points": (610, 698, 670, 718),

    # WIDER CONTEXT CROPS (for Gemini labeling - easier to read)
    "health_shield_wide": (310, 672, 510, 718),
    "ammo_wide": (1120, 672, 1260, 718),
    "top_hud_wide": (530, 28, 750, 68),
    "credits_wide": (1130, 688, 1280, 720),
}


def get_video_duration(video_path):
    """Get video duration in seconds using ffprobe."""
    result = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=noprint_wrappers=1:nokey=1", str(video_path)],
        capture_output=True, text=True
    )
    try:
        return float(result.stdout.strip())
    except (ValueError, AttributeError):
        return 0


def get_video_resolution(video_path):
    """Get video resolution using ffprobe."""
    result = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=width,height",
         "-of", "csv=p=0", str(video_path)],
        capture_output=True, text=True
    )
    try:
        w, h = result.stdout.strip().split(",")
        return int(w), int(h)
    except (ValueError, AttributeError):
        return 1280, 720


def extract_frames(video_path, output_dir, interval=5, max_frames=150):
    """Extract frames from video at regular intervals."""
    output_dir.mkdir(parents=True, exist_ok=True)
    duration = get_video_duration(video_path)
    if duration <= 0:
        print(f"  SKIP: Could not get duration for {video_path.name}")
        return []

    video_name = video_path.stem
    frames = []
    timestamps = list(range(30, int(duration) - 5, interval))[:max_frames]

    print(f"  Extracting {len(timestamps)} frames from {video_path.name} ({duration:.0f}s)...")

    for i, ts in enumerate(timestamps):
        frame_path = output_dir / f"{video_name}_t{ts:05d}.jpg"
        if frame_path.exists():
            frames.append((frame_path, ts))
            continue

        result = subprocess.run(
            ["ffmpeg", "-ss", str(ts), "-i", str(video_path),
             "-frames:v", "1", "-q:v", "2", str(frame_path), "-y"],
            capture_output=True, text=True
        )
        if frame_path.exists():
            frames.append((frame_path, ts))

        if (i + 1) % 50 == 0:
            print(f"    ...{i+1}/{len(timestamps)} frames")

    print(f"  Extracted {len(frames)} frames")
    return frames


def crop_hud_regions(frame_path, crops_dir, video_name, timestamp, video_w, video_h):
    """Crop all HUD regions from a frame and save them."""
    try:
        img = Image.open(frame_path)
    except Exception as e:
        return []

    w, h = img.size
    scale_x = w / 1280
    scale_y = h / 720

    crops = []

    for region_name, (x1, y1, x2, y2) in REGIONS_720p.items():
        sx1 = int(x1 * scale_x)
        sy1 = int(y1 * scale_y)
        sx2 = int(x2 * scale_x)
        sy2 = int(y2 * scale_y)

        crop = img.crop((sx1, sy1, sx2, sy2))

        # Skip if crop is too small or all black
        if crop.size[0] < 5 or crop.size[1] < 5:
            continue

        crop_filename = f"{video_name}_t{timestamp:05d}_{region_name}.jpg"
        crop_path = crops_dir / crop_filename
        crop.save(crop_path, quality=95)

        crops.append({
            "crop_path": str(crop_path),
            "frame_path": str(frame_path),
            "video": video_name,
            "timestamp": timestamp,
            "region": region_name,
            "crop_w": crop.size[0],
            "crop_h": crop.size[1],
        })

    return crops


def main():
    CROPS_DIR.mkdir(parents=True, exist_ok=True)
    FRAMES_DIR.mkdir(parents=True, exist_ok=True)

    # Find all gameplay videos
    videos = []
    for search_dir in [VIDEO_DIR, SERVER_VIDEO_DIR]:
        if search_dir.exists():
            for ext in ["*.mp4", "*.mkv", "*.webm"]:
                videos.extend(search_dir.glob(ext))

    # Filter out tiny/test videos
    videos = [v for v in videos if v.stat().st_size > 5_000_000]  # > 5MB
    videos = list(set(videos))  # deduplicate

    print(f"Found {len(videos)} videos:")
    for v in videos:
        size_mb = v.stat().st_size / 1024 / 1024
        print(f"  {v.name} ({size_mb:.0f} MB)")

    all_crops = []

    for video_path in videos:
        print(f"\n{'='*60}")
        print(f"Processing: {video_path.name}")

        video_w, video_h = get_video_resolution(video_path)
        print(f"  Resolution: {video_w}x{video_h}")

        # Extract frames
        frames = extract_frames(video_path, FRAMES_DIR,
                                interval=FRAME_INTERVAL,
                                max_frames=MAX_FRAMES_PER_VIDEO)

        # Crop HUD regions from each frame
        for frame_path, ts in frames:
            crops = crop_hud_regions(
                frame_path, CROPS_DIR, video_path.stem, ts,
                video_w, video_h
            )
            all_crops.extend(crops)

    # Write manifest
    print(f"\n{'='*60}")
    print(f"Total crops: {len(all_crops)}")

    with open(MANIFEST, "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=[
            "crop_path", "frame_path", "video", "timestamp",
            "region", "crop_w", "crop_h"
        ])
        writer.writeheader()
        writer.writerows(all_crops)

    print(f"Manifest saved: {MANIFEST}")

    # Print summary by region
    from collections import Counter
    region_counts = Counter(c["region"] for c in all_crops)
    print("\nCrops per region:")
    for region, count in sorted(region_counts.items()):
        print(f"  {region}: {count}")

    print(f"\nNext step: Run label_hud_digits_gemini.py to auto-label with Gemini Flash")


if __name__ == "__main__":
    main()
