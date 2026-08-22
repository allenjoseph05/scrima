"""
Auto-label HUD digit crops using Gemini Flash.

Sends the WIDE context crops to Gemini and asks it to read all numbers.
This creates ground truth labels for training the digit classifier.

Usage:
  python scripts/label_hud_digits_gemini.py

Cost estimate: ~$0.50-1.00 for ~500 crops (4 wide regions × ~125 frames)
"""

import os
import csv
import json
import time
import base64
from pathlib import Path
from collections import defaultdict

import google.generativeai as genai

# ── Config ──────────────────────────────────────────────────────────────────

DATA_DIR = Path("data/datasets/digit-classifier")
MANIFEST = DATA_DIR / "manifest.csv"
LABELS_PATH = DATA_DIR / "labels.csv"

API_KEY = os.environ.get("GEMINI_API_KEY")
if not API_KEY:
    raise ValueError("GEMINI_API_KEY environment variable is required")
MODEL = "gemini-2.5-flash"

BATCH_SIZE = 4  # wide crops per API call (4 regions from same frame)
CONCURRENCY_DELAY = 0.5  # seconds between API calls

# Only label the wide context crops (easier for Gemini to read)
WIDE_REGIONS = ["health_shield_wide", "ammo_wide", "top_hud_wide", "credits_wide"]

PROMPT = """Read ALL numbers visible in this Valorant HUD crop. The crop is from a specific region of the game screen.

Rules:
- Report ONLY the numeric values you can clearly see
- If you see a health/shield display like "50 | 100", report shield and health separately
- If you see ammo like "25 | 40" or "25  40", report magazine and reserve separately
- If you see a timer like "1:30", report it exactly including the colon
- If you see a score like "3  0", report left and right scores
- If you see credits like "8,400" or "2,050", report without comma
- If the crop is too dark, blurry, or shows a non-gameplay state (buy menu, death screen), report "unclear"
- Ignore any text that is NOT a number (like "Client Version", player names, etc.)

Respond in this exact JSON format:
{
  "region_type": "health_shield_wide" | "ammo_wide" | "top_hud_wide" | "credits_wide",
  "values": {
    "health": <number or null>,
    "shield": <number or null>,
    "ammo_magazine": <number or null>,
    "ammo_reserve": <number or null>,
    "timer": "<MM:SS string or null>",
    "score_left": <number or null>,
    "score_right": <number or null>,
    "credits": <number or null>
  },
  "readable": true | false,
  "game_state": "gameplay" | "buy_phase" | "death" | "other"
}

Only fill in values relevant to the region shown. Leave others as null."""


def load_manifest():
    """Load crop manifest and filter to wide regions only."""
    crops = []
    with open(MANIFEST) as f:
        reader = csv.DictReader(f)
        for row in reader:
            if row["region"] in WIDE_REGIONS:
                crops.append(row)
    return crops


def load_existing_labels():
    """Load already-labeled crops to support resume."""
    labeled = set()
    if LABELS_PATH.exists():
        with open(LABELS_PATH) as f:
            reader = csv.DictReader(f)
            for row in reader:
                labeled.add(row["crop_path"])
    return labeled


def image_to_part(image_path):
    """Convert image file to Gemini API part."""
    with open(image_path, "rb") as f:
        data = f.read()
    return {
        "inline_data": {
            "mime_type": "image/jpeg",
            "data": base64.b64encode(data).decode("utf-8"),
        }
    }


def label_batch(model, crops):
    """Send a batch of crops to Gemini and parse results."""
    parts = []

    for i, crop in enumerate(crops):
        region = crop["region"]
        parts.append(f"\n--- Image {i+1} (region: {region}, from {crop['video']} at t={crop['timestamp']}s) ---")
        parts.append(image_to_part(crop["crop_path"]))

    parts.append(f"\nRead the numbers in each of the {len(crops)} images above. Return a JSON array with one object per image, in order.")

    try:
        response = model.generate_content(
            [PROMPT] + parts,
            generation_config=genai.GenerationConfig(
                response_mime_type="application/json",
                temperature=0.1,
            ),
        )

        text = response.text.strip()
        # Parse JSON - handle both array and object responses
        if text.startswith("["):
            results = json.loads(text)
        elif text.startswith("{"):
            results = [json.loads(text)]
        else:
            # Try to extract JSON from the response
            import re
            json_match = re.search(r'[\[{].*[\]}]', text, re.DOTALL)
            if json_match:
                results = json.loads(json_match.group())
                if isinstance(results, dict):
                    results = [results]
            else:
                print(f"  Could not parse response: {text[:200]}")
                return [None] * len(crops)

        return results

    except Exception as e:
        print(f"  API error: {e}")
        return [None] * len(crops)


def main():
    genai.configure(api_key=API_KEY)
    model = genai.GenerativeModel(MODEL)

    print("Loading manifest...")
    all_crops = load_manifest()
    labeled = load_existing_labels()

    # Filter out already-labeled crops
    crops_to_label = [c for c in all_crops if c["crop_path"] not in labeled]

    print(f"Total wide crops: {len(all_crops)}")
    print(f"Already labeled: {len(labeled)}")
    print(f"To label: {len(crops_to_label)}")

    if not crops_to_label:
        print("Nothing to label!")
        return

    # Group crops by frame (so we can send all 4 wide regions together)
    by_frame = defaultdict(list)
    for crop in crops_to_label:
        frame_key = f"{crop['video']}_t{crop['timestamp']}"
        by_frame[frame_key].append(crop)

    print(f"Frames to process: {len(by_frame)}")

    # Open labels file for appending
    write_header = not LABELS_PATH.exists()
    label_file = open(LABELS_PATH, "a", newline="")
    writer = csv.writer(label_file)
    if write_header:
        writer.writerow([
            "crop_path", "region", "video", "timestamp",
            "health", "shield", "ammo_magazine", "ammo_reserve",
            "timer", "score_left", "score_right", "credits",
            "readable", "game_state"
        ])

    total_labeled = 0
    total_frames = len(by_frame)

    for i, (frame_key, frame_crops) in enumerate(by_frame.items()):
        print(f"\n[{i+1}/{total_frames}] {frame_key} ({len(frame_crops)} crops)")

        results = label_batch(model, frame_crops)

        for crop, result in zip(frame_crops, results):
            if result is None:
                print(f"  SKIP: No result for {crop['region']}")
                continue

            values = result.get("values", {})
            readable = result.get("readable", False)
            game_state = result.get("game_state", "unknown")

            writer.writerow([
                crop["crop_path"],
                crop["region"],
                crop["video"],
                crop["timestamp"],
                values.get("health", ""),
                values.get("shield", ""),
                values.get("ammo_magazine", ""),
                values.get("ammo_reserve", ""),
                values.get("timer", ""),
                values.get("score_left", ""),
                values.get("score_right", ""),
                values.get("credits", ""),
                readable,
                game_state,
            ])
            total_labeled += 1

        label_file.flush()
        time.sleep(CONCURRENCY_DELAY)

    label_file.close()
    print(f"\n{'='*60}")
    print(f"Labeled {total_labeled} crops")
    print(f"Saved to: {LABELS_PATH}")


if __name__ == "__main__":
    main()
