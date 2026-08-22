"""
Auto-label dense death frames. Only flag truly ambiguous ones for review.

Since these frames were extracted AROUND death moments, the distribution is:
  - ~33% death_screen (the actual death)
  - ~33% spectating (watching teammate after death)
  - ~33% gameplay (the seconds before death)

Strategy:
  - High confidence (>0.85): auto-label, no review needed
  - Medium confidence (0.60-0.85): auto-label but copy to review
  - death_screen predictions: ALWAYS copy to review (most important class)
  - Low confidence (<0.60): copy to review as uncertain
"""

import os
import csv
import shutil
from pathlib import Path
from collections import Counter

import numpy as np
from PIL import Image
import onnxruntime as ort

DATA_DIR = Path("data")
FRAMES_DIR = DATA_DIR / "frames"
LABELS_FILE = DATA_DIR / "labels.csv"
MODEL_PATH = Path("src/services/coaching/models/valorant-classifier.onnx")
REVIEW_DIR = DATA_DIR / "review-deaths"

CLASSES = ["gameplay", "death_screen", "spectating", "buy_phase", "round_end", "loading"]
IMAGE_SIZE = 224

def preprocess(img_path):
    img = Image.open(img_path).convert("RGB").resize((IMAGE_SIZE, IMAGE_SIZE))
    arr = np.array(img, dtype=np.float32) / 255.0
    mean = np.array([0.485, 0.456, 0.406], dtype=np.float32)
    std = np.array([0.229, 0.224, 0.225], dtype=np.float32)
    arr = (arr - mean) / std
    arr = arr.transpose(2, 0, 1)
    return np.expand_dims(arr, axis=0)

def classify(session, input_name, img_path):
    inp = preprocess(img_path)
    outputs = session.run(None, {input_name: inp})
    logits = outputs[0][0]
    logits_shifted = logits - np.max(logits)
    probs = np.exp(logits_shifted) / np.sum(np.exp(logits_shifted))
    idx = np.argmax(probs)
    return CLASSES[idx], float(probs[idx])


if __name__ == '__main__':
    # Load model
    session = ort.InferenceSession(str(MODEL_PATH))
    input_name = session.get_inputs()[0].name

    # Load existing labels
    existing = set()
    if LABELS_FILE.exists():
        with open(LABELS_FILE, "r") as f:
            for row in csv.DictReader(f):
                existing.add(row["frame_path"])

    # Find all dense frames
    dense_frames = []
    for vid_dir in sorted(FRAMES_DIR.iterdir()):
        if not vid_dir.is_dir():
            continue
        for f in sorted(vid_dir.glob("death_dense_*.jpg")):
            if str(f.resolve()) not in existing:
                dense_frames.append((vid_dir.name, f))

    print(f"Found {len(dense_frames)} unlabeled dense frames")

    # Classify all
    new_labels = []
    review_count = 0
    auto_count = 0
    stats = Counter()
    review_stats = Counter()

    # Prepare review dirs
    for cls in CLASSES + ["uncertain"]:
        (REVIEW_DIR / cls).mkdir(parents=True, exist_ok=True)

    for i, (video_id, frame_path) in enumerate(dense_frames):
        label, confidence = classify(session, input_name, frame_path)
        stats[label] += 1
        abs_path = str(frame_path.resolve())

        # Always add to labels
        new_labels.append((abs_path, label, confidence, video_id))

        # Decide if review needed
        needs_review = (
            label == "death_screen" or  # always review death predictions
            confidence < 0.60           # uncertain
        )

        if needs_review:
            dest_cls = label if confidence >= 0.40 else "uncertain"
            dest = REVIEW_DIR / dest_cls / f"{video_id}_{frame_path.stem}_conf{confidence:.2f}.jpg"
            if not dest.exists():
                shutil.copy2(frame_path, dest)
            review_count += 1
            review_stats[dest_cls] += 1
        else:
            auto_count += 1

        if (i + 1) % 2000 == 0:
            print(f"  {i+1}/{len(dense_frames)} — auto:{auto_count} review:{review_count}")

    # Append to labels.csv
    if new_labels:
        with open(LABELS_FILE, "a", newline="") as f:
            writer = csv.writer(f)
            for path, label, conf, vid in new_labels:
                writer.writerow([path, label, conf, vid])

    print(f"\n{'='*60}")
    print(f"Done! {len(dense_frames)} dense frames processed:")
    print(f"  Auto-labeled (no review needed): {auto_count}")
    print(f"  Needs your review: {review_count}")
    print(f"  Classification: {dict(stats)}")
    print(f"  Review breakdown: {dict(review_stats)}")
    print(f"\nAppended {len(new_labels)} labels to {LABELS_FILE}")
    print(f"Review at: {REVIEW_DIR.resolve()}")
