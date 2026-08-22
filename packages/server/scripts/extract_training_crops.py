"""
Extract training crops from downloaded gameplay videos.

For each video (known agent + map):
  1. Extract frames at 1 fps (full resolution)
  2. Run game state classifier to filter gameplay/death/buy frames
  3. Crop HUD regions:
     - Ability bar (bottom-center) → labeled by agent
     - Minimap (top-left) → labeled by map
     - Death screen right panel → for enemy agent/weapon training
  4. Save crops organized by class for training

Auto-labeling: each video filename encodes the agent name.
Map is identified from the first gameplay frame via Gemini (once per video, $0.001).
"""

import os
import csv
import sys
import subprocess
import json
from pathlib import Path
from collections import Counter

import cv2
import numpy as np

# ── Config ──────────────────────────────────────────────────────────────────

VIDEO_DIR = Path("data/training-videos")
OUTPUT_DIR = Path("data/training-crops")
FRAMES_DIR = OUTPUT_DIR / "frames"

# Frame extraction rate
FPS = 1
MAX_FRAMES = 300  # per video (~5 min of gameplay)

# HUD regions at 1280x720
REGIONS = {
    "ability_bar": (430, 675, 750, 720),
    "minimap": (8, 30, 215, 240),
    "death_right_panel": (700, 50, 1270, 500),  # "KILLED BY" panel on death screen
    "health_shield": (310, 672, 510, 718),
}

# ── Functions ───────────────────────────────────────────────────────────────

def get_video_info(path):
    """Get video resolution and duration."""
    result = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=width,height", "-show_entries", "format=duration",
         "-of", "json", str(path)],
        capture_output=True, text=True
    )
    try:
        data = json.loads(result.stdout)
        w = data["streams"][0]["width"]
        h = data["streams"][0]["height"]
        dur = float(data["format"]["duration"])
        return w, h, dur
    except Exception:
        return 1280, 720, 0


def extract_frames(video_path, out_dir, fps=1, max_frames=300):
    """Extract frames from video at given fps."""
    out_dir.mkdir(parents=True, exist_ok=True)

    # Check if already extracted
    existing = list(out_dir.glob("*.jpg"))
    if len(existing) >= max_frames * 0.8:
        print(f"    Already extracted {len(existing)} frames")
        return existing

    # Use ffmpeg to extract
    pattern = str(out_dir / "frame_%05d.jpg")
    subprocess.run(
        ["ffmpeg", "-i", str(video_path), "-vf", f"fps={fps}",
         "-frames:v", str(max_frames), "-q:v", "3", pattern, "-y"],
        capture_output=True, text=True
    )

    frames = sorted(out_dir.glob("*.jpg"))
    print(f"    Extracted {len(frames)} frames")
    return frames


def classify_frames_simple(frames, video_w, video_h):
    """
    Simple heuristic classification (no ONNX needed):
    - death_screen: low saturation across frame
    - buy_phase: blue-tinted UI overlay
    - gameplay: normal HUD visible
    - loading: dark frame or non-game screen
    """
    results = {}

    for frame_path in frames:
        img = cv2.imread(str(frame_path))
        if img is None:
            results[frame_path] = "unknown"
            continue

        hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
        h, s, v = cv2.split(hsv)

        avg_sat = np.mean(s)
        avg_val = np.mean(v)

        # Dark frame = loading
        if avg_val < 30:
            results[frame_path] = "loading"
        # Very low saturation = death screen (desaturated)
        elif avg_sat < 25 and avg_val > 40:
            results[frame_path] = "death_screen"
        # Blue-heavy center = buy phase
        elif avg_sat > 40:
            # Check center region for buy menu
            center = img[int(h.shape[0]*0.3):int(h.shape[0]*0.7),
                        int(h.shape[1]*0.3):int(h.shape[1]*0.7)]
            center_hsv = cv2.cvtColor(center, cv2.COLOR_BGR2HSV)
            blue_mask = cv2.inRange(center_hsv, (90, 50, 50), (130, 255, 255))
            blue_ratio = np.sum(blue_mask > 0) / blue_mask.size
            if blue_ratio > 0.15:
                results[frame_path] = "buy_phase"
            else:
                results[frame_path] = "gameplay"
        else:
            results[frame_path] = "gameplay"

    return results


def crop_and_save(frame_path, agent, map_name, state, video_w, video_h):
    """Crop relevant HUD regions and save to class directories."""
    img = cv2.imread(str(frame_path))
    if img is None:
        return 0

    sx = video_w / 1280
    sy = video_h / 720
    saved = 0
    ts = frame_path.stem  # frame_00042

    if state == "gameplay":
        # Crop ability bar → save under agent class
        x1, y1, x2, y2 = REGIONS["ability_bar"]
        crop = img[int(y1*sy):int(y2*sy), int(x1*sx):int(x2*sx)]
        if crop.size > 0:
            out_dir = OUTPUT_DIR / "ability_bar" / agent.lower()
            out_dir.mkdir(parents=True, exist_ok=True)
            cv2.imwrite(str(out_dir / f"{agent}_{ts}.jpg"), crop)
            saved += 1

        # Crop minimap → save under map class
        if map_name and map_name != "unknown":
            x1, y1, x2, y2 = REGIONS["minimap"]
            crop = img[int(y1*sy):int(y2*sy), int(x1*sx):int(x2*sx)]
            if crop.size > 0:
                out_dir = OUTPUT_DIR / "minimap" / map_name.lower()
                out_dir.mkdir(parents=True, exist_ok=True)
                cv2.imwrite(str(out_dir / f"{map_name}_{ts}.jpg"), crop)
                saved += 1

    elif state == "death_screen":
        # Crop death screen right panel
        x1, y1, x2, y2 = REGIONS["death_right_panel"]
        crop = img[int(y1*sy):int(y2*sy), int(x1*sx):int(x2*sx)]
        if crop.size > 0:
            out_dir = OUTPUT_DIR / "death_screens"
            out_dir.mkdir(parents=True, exist_ok=True)
            cv2.imwrite(str(out_dir / f"{agent}_{ts}.jpg"), crop)
            saved += 1

    return saved


def main():
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    # Find all training videos
    videos = sorted(VIDEO_DIR.glob("*.mp4"))
    if not videos:
        print("No videos found in data/training-videos/")
        print("Run download_gameplay_videos.sh first.")
        return

    print(f"Found {len(videos)} training videos\n")

    total_crops = 0
    agent_counts = Counter()
    map_counts = Counter()

    for video_path in videos:
        # Parse agent from filename (format: agent-youtubeId.mp4)
        agent = video_path.stem.split("-")[0].capitalize()
        print(f"{'='*50}")
        print(f"Video: {video_path.name}")
        print(f"Agent: {agent}")

        video_w, video_h, duration = get_video_info(video_path)
        print(f"Resolution: {video_w}x{video_h}, Duration: {duration:.0f}s")

        # Extract frames
        frame_dir = FRAMES_DIR / video_path.stem
        frames = extract_frames(video_path, frame_dir, fps=FPS, max_frames=MAX_FRAMES)

        if not frames:
            print("  No frames extracted, skipping")
            continue

        # Classify frames
        print("    Classifying frames...")
        states = classify_frames_simple(frames, video_w, video_h)
        state_counts = Counter(states.values())
        print(f"    States: {dict(state_counts)}")

        # For map: we'll use "unknown" for now, identify later
        map_name = "unknown"

        # Crop and save
        crops = 0
        for frame_path, state in states.items():
            crops += crop_and_save(frame_path, agent, map_name, state, video_w, video_h)

        total_crops += crops
        agent_counts[agent] += state_counts.get("gameplay", 0)
        print(f"    Saved {crops} crops")

    # Summary
    print(f"\n{'='*50}")
    print(f"EXTRACTION COMPLETE")
    print(f"{'='*50}")
    print(f"Total crops: {total_crops}")
    print(f"\nAbility bar crops per agent:")
    for d in sorted((OUTPUT_DIR / "ability_bar").iterdir()) if (OUTPUT_DIR / "ability_bar").exists() else []:
        if d.is_dir():
            count = len(list(d.glob("*.jpg")))
            print(f"  {d.name}: {count}")

    print(f"\nDeath screen crops: ", end="")
    ds_dir = OUTPUT_DIR / "death_screens"
    if ds_dir.exists():
        print(len(list(ds_dir.glob("*.jpg"))))
    else:
        print("0")


if __name__ == "__main__":
    main()
