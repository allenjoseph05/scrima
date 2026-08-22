"""
Pre-label new video frames using the existing ONNX classifier.

For each new video's frames:
  1. Run ONNX inference on every frame
  2. Add high-confidence predictions to labels.csv automatically
  3. Copy death_screen candidates + low-confidence frames to a review folder
     for human verification

Usage:
  cd packages/server
  python scripts/prelabel_new_frames.py
"""

import os
import csv
import shutil
from pathlib import Path
from collections import Counter

import numpy as np
from PIL import Image

try:
    import onnxruntime as ort
except ImportError:
    print("Install onnxruntime: pip install onnxruntime")
    exit(1)

# ── Config ──────────────────────────────────────────────────────────────────

DATA_DIR = Path("data")
FRAMES_DIR = DATA_DIR / "frames"
LABELS_FILE = DATA_DIR / "labels.csv"
MODEL_PATH = Path("src/services/coaching/models/valorant-classifier.onnx")

CLASSES = ["gameplay", "death_screen", "spectating", "buy_phase", "round_end", "loading"]

# Videos to process (new ones without labels)
NEW_VIDEOS = [
    "cypher-aGs9eOH7Cjs",
    "killjoy-_phEery87U4",
    "omen-i7EmxFPkoQU",
    "sova-j_JFmD7dOEI",
]

# Confidence thresholds
AUTO_LABEL_THRESHOLD = 0.85   # Above this → auto-add to labels.csv
REVIEW_THRESHOLD = 0.60       # Below this OR death_screen/spectating → needs review

# Review folder for human classification
REVIEW_DIR = DATA_DIR / "review"

IMAGE_SIZE = 224

# ── Load model ──────────────────────────────────────────────────────────────

def load_model():
    if not MODEL_PATH.exists():
        print(f"Model not found: {MODEL_PATH}")
        exit(1)
    session = ort.InferenceSession(str(MODEL_PATH))
    input_name = session.get_inputs()[0].name
    print(f"Loaded ONNX model: {MODEL_PATH}")
    return session, input_name

def preprocess(img_path):
    """Preprocess image for MobileNetV2 (ImageNet normalization)."""
    img = Image.open(img_path).convert("RGB").resize((IMAGE_SIZE, IMAGE_SIZE))
    arr = np.array(img, dtype=np.float32) / 255.0
    # ImageNet normalization
    mean = np.array([0.485, 0.456, 0.406], dtype=np.float32)
    std = np.array([0.229, 0.224, 0.225], dtype=np.float32)
    arr = (arr - mean) / std
    # HWC → CHW → NCHW
    arr = arr.transpose(2, 0, 1)
    arr = np.expand_dims(arr, axis=0)
    return arr

def classify(session, input_name, img_path):
    """Run inference, return (label, confidence)."""
    inp = preprocess(img_path)
    outputs = session.run(None, {input_name: inp})
    logits = outputs[0][0]
    logits_shifted = logits - np.max(logits)
    probs = np.exp(logits_shifted) / np.sum(np.exp(logits_shifted))  # softmax
    idx = np.argmax(probs)
    return CLASSES[idx], float(probs[idx])

# ── Load existing labels ────────────────────────────────────────────────────

def load_existing_labels():
    """Load existing labels.csv to know which frames are already labeled."""
    existing = set()
    if LABELS_FILE.exists():
        with open(LABELS_FILE, "r") as f:
            reader = csv.DictReader(f)
            for row in reader:
                existing.add(row["frame_path"])
    return existing

# ── Main ────────────────────────────────────────────────────────────────────

def main():
    session, input_name = load_model()
    existing_labels = load_existing_labels()
    print(f"Existing labels: {len(existing_labels)}")

    # Prepare review directories
    for cls in CLASSES:
        (REVIEW_DIR / cls).mkdir(parents=True, exist_ok=True)
    (REVIEW_DIR / "uncertain").mkdir(parents=True, exist_ok=True)

    new_labels = []  # (path, label, confidence, video_id)
    review_count = 0
    auto_count = 0
    stats = Counter()
    review_stats = Counter()

    for video_id in NEW_VIDEOS:
        video_dir = FRAMES_DIR / video_id
        if not video_dir.exists():
            print(f"SKIP {video_id} — no frames directory")
            continue

        frames = sorted(video_dir.glob("frame_*.jpg"))
        print(f"\nProcessing {video_id}: {len(frames)} frames")

        for i, frame_path in enumerate(frames):
            abs_path = str(frame_path.resolve())

            # Skip if already labeled
            if abs_path in existing_labels:
                continue

            label, confidence = classify(session, input_name, frame_path)
            stats[label] += 1

            # Always review death_screen and spectating (we need more of these)
            needs_review = (
                label in ("death_screen", "spectating") or
                confidence < REVIEW_THRESHOLD
            )

            if needs_review:
                # Copy to review folder organized by predicted class
                review_label = label if confidence >= 0.4 else "uncertain"
                dest_dir = REVIEW_DIR / review_label
                dest_name = f"{video_id}_frame{i+1:05d}_conf{confidence:.2f}.jpg"
                shutil.copy2(frame_path, dest_dir / dest_name)
                review_count += 1
                review_stats[review_label] += 1

                # Still add to labels with the prediction (can be corrected later)
                new_labels.append((abs_path, label, confidence, video_id))
            else:
                # High confidence, non-death → auto-label
                if confidence >= AUTO_LABEL_THRESHOLD:
                    new_labels.append((abs_path, label, confidence, video_id))
                    auto_count += 1
                else:
                    # Medium confidence → still auto-label but flag
                    new_labels.append((abs_path, label, confidence, video_id))
                    auto_count += 1

            if (i + 1) % 500 == 0:
                print(f"  {i+1}/{len(frames)} — {dict(stats)}")

    # Append new labels to labels.csv
    print(f"\n{'='*60}")
    print(f"Results:")
    print(f"  Auto-labeled: {auto_count}")
    print(f"  Needs review: {review_count}")
    print(f"  Classification distribution: {dict(stats)}")
    print(f"  Review distribution: {dict(review_stats)}")

    if new_labels:
        with open(LABELS_FILE, "a", newline="") as f:
            writer = csv.writer(f)
            for path, label, conf, vid in new_labels:
                writer.writerow([path, label, conf, vid])
        print(f"\nAppended {len(new_labels)} labels to {LABELS_FILE}")

    print(f"\nReview folder: {REVIEW_DIR.resolve()}")
    print(f"  - Check each subfolder (death_screen/, spectating/, uncertain/)")
    print(f"  - Move misclassified frames to the correct folder")
    print(f"  - Then run: python scripts/apply_review.py")

if __name__ == "__main__":
    main()
