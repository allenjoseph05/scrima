"""
Train Digit Classifier for Valorant HUD Numbers

Takes Gemini-labeled HUD crops and trains a model to read numbers
from specific HUD regions (health, shield, ammo, timer, score, credits).

Architecture: MobileNetV2 backbone with per-region classification heads.
Instead of OCR, this treats number reading as classification:
  - Health: 0-150 → binned into ranges or exact values
  - Shield: {0, 25, 50} → 3-class
  - Score: 0-24 → 25-class
  - Timer minutes: 0-2 → 3-class
  - Timer seconds: 0-59 → 60-class

For health/ammo/credits where the value range is large, we use
individual digit segmentation + 10-class digit classification.

Usage:
  python scripts/train_digit_classifier.py

Output:
  src/services/coaching/models/digit-classifier.onnx
  src/services/coaching/models/shield-classifier.onnx
  src/services/coaching/models/score-classifier.onnx
"""

import os
import csv
import random
from pathlib import Path
from collections import Counter

import cv2
import numpy as np
import torch
import torch.nn as nn
import torch.optim as optim
from torch.utils.data import Dataset, DataLoader
from torchvision import transforms, models
from PIL import Image
from sklearn.metrics import classification_report

# ── Config ──────────────────────────────────────────────────────────────────

DATA_DIR = Path("data/datasets/digit-classifier")
LABELS_FILE = DATA_DIR / "labels.csv"
CROPS_DIR = DATA_DIR / "crops"
MODEL_DIR = Path("src/services/coaching/models")
MODEL_DIR.mkdir(parents=True, exist_ok=True)

DIGIT_SIZE = 32  # resize individual digits to 32x32
BATCH_SIZE = 64
NUM_EPOCHS = 15
LR = 1e-3
SEED = 42

# ── Digit Segmentation ──────────────────────────────────────────────────────

def segment_digits(crop_path, upscale=3, threshold=170):
    """
    Segment individual digits from a HUD number crop.

    Returns list of (digit_image, x_position) tuples sorted left-to-right.
    """
    img = cv2.imread(str(crop_path))
    if img is None:
        return []

    # Upscale for better segmentation
    img = cv2.resize(img, None, fx=upscale, fy=upscale, interpolation=cv2.INTER_CUBIC)

    # Convert to grayscale
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)

    # Threshold to isolate bright text (white/yellow numbers on dark BG)
    _, binary = cv2.threshold(gray, threshold, 255, cv2.THRESH_BINARY)

    # Find contours
    contours, _ = cv2.findContours(binary, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

    digits = []
    h_img = img.shape[0]

    for contour in contours:
        x, y, w, h = cv2.boundingRect(contour)

        # Filter by size — digits should be a reasonable size
        if h < h_img * 0.3:  # too small (noise)
            continue
        if w < 3 or h < 5:  # too tiny
            continue
        if w > h * 2:  # too wide (probably multiple merged chars)
            continue

        # Extract digit with small padding
        pad = 3
        x1 = max(0, x - pad)
        y1 = max(0, y - pad)
        x2 = min(binary.shape[1], x + w + pad)
        y2 = min(binary.shape[0], y + h + pad)

        digit_img = binary[y1:y2, x1:x2]

        # Resize to standard size
        digit_img = cv2.resize(digit_img, (DIGIT_SIZE, DIGIT_SIZE),
                              interpolation=cv2.INTER_AREA)

        digits.append((digit_img, x))

    # Sort left to right
    digits.sort(key=lambda d: d[1])

    return [(d[0], d[1]) for d in digits]


def create_digit_dataset(labels_file, crops_dir, output_dir):
    """
    Create a digit classification dataset from labeled HUD crops.

    Process:
    1. Read Gemini labels to get ground truth numbers
    2. Segment digits from corresponding narrow crops
    3. Match segmented digits to expected digit values
    4. Save as individual digit images labeled 0-9
    """
    output_dir.mkdir(parents=True, exist_ok=True)

    # Create class directories
    for d in range(10):
        (output_dir / str(d)).mkdir(exist_ok=True)
    # Special classes
    (output_dir / "colon").mkdir(exist_ok=True)  # ":"
    (output_dir / "pipe").mkdir(exist_ok=True)    # "|" or "/"

    if not labels_file.exists():
        print("No labels file found. Run label_hud_digits_gemini.py first.")
        return 0

    total_digits = 0

    with open(labels_file) as f:
        reader = csv.DictReader(f)
        for row in reader:
            region = row["region"]
            crop_path = row["crop_path"]

            # Get the expected number for this region
            expected = None
            if region == "health_shield_wide":
                # Try health number
                if row.get("health") and row["health"].strip():
                    expected_str = row["health"].strip()
                    narrow_crop = crop_path.replace("health_shield_wide", "health")
                    if Path(narrow_crop).exists():
                        total_digits += _extract_digits(
                            narrow_crop, expected_str, output_dir, f"health_{total_digits}")

                # Try shield number
                if row.get("shield") and row["shield"].strip():
                    expected_str = row["shield"].strip()
                    narrow_crop = crop_path.replace("health_shield_wide", "shield")
                    if Path(narrow_crop).exists():
                        total_digits += _extract_digits(
                            narrow_crop, expected_str, output_dir, f"shield_{total_digits}")

            elif region == "ammo_wide":
                if row.get("ammo_magazine") and row["ammo_magazine"].strip():
                    expected_str = row["ammo_magazine"].strip()
                    narrow_crop = crop_path.replace("ammo_wide", "ammo_mag")
                    if Path(narrow_crop).exists():
                        total_digits += _extract_digits(
                            narrow_crop, expected_str, output_dir, f"ammo_{total_digits}")

            elif region == "top_hud_wide":
                if row.get("score_left") and row["score_left"].strip():
                    expected_str = row["score_left"].strip()
                    narrow_crop = crop_path.replace("top_hud_wide", "score_left")
                    if Path(narrow_crop).exists():
                        total_digits += _extract_digits(
                            narrow_crop, expected_str, output_dir, f"scorel_{total_digits}")

                if row.get("score_right") and row["score_right"].strip():
                    expected_str = row["score_right"].strip()
                    narrow_crop = crop_path.replace("top_hud_wide", "score_right")
                    if Path(narrow_crop).exists():
                        total_digits += _extract_digits(
                            narrow_crop, expected_str, output_dir, f"scorer_{total_digits}")

            elif region == "credits_wide":
                if row.get("credits") and row["credits"].strip():
                    expected_str = row["credits"].strip().replace(",", "")
                    narrow_crop = crop_path.replace("credits_wide", "credits")
                    if Path(narrow_crop).exists():
                        total_digits += _extract_digits(
                            narrow_crop, expected_str, output_dir, f"credits_{total_digits}")

    return total_digits


def _extract_digits(crop_path, expected_str, output_dir, prefix):
    """Extract and save individual digits from a crop, matched to expected string."""
    # Only process pure digit strings (ignore timers with colons for now)
    expected_digits = [c for c in expected_str if c.isdigit()]
    if not expected_digits:
        return 0

    # Segment digits from the crop
    segmented = segment_digits(crop_path)

    # If segment count matches expected digits, we can label them
    if len(segmented) != len(expected_digits):
        return 0  # Can't reliably match

    saved = 0
    for (digit_img, _), expected_char in zip(segmented, expected_digits):
        digit_dir = output_dir / expected_char
        filename = f"{prefix}_{saved}.png"
        cv2.imwrite(str(digit_dir / filename), digit_img)
        saved += 1

    return saved


# ── Digit Classifier Dataset ────────────────────────────────────────────────

class DigitDataset(Dataset):
    def __init__(self, samples, transform=None):
        self.samples = samples  # list of (path, label)
        self.transform = transform

    def __len__(self):
        return len(self.samples)

    def __getitem__(self, idx):
        path, label = self.samples[idx]
        img = Image.open(path).convert("L")  # grayscale
        img = img.resize((DIGIT_SIZE, DIGIT_SIZE))

        if self.transform:
            img = self.transform(img)
        else:
            img = transforms.ToTensor()(img)

        return img, label


# ── Training ─────────────────────────────────────────────────────────────────

class DigitClassifier(nn.Module):
    """Simple CNN for single digit classification (0-9)."""

    def __init__(self, num_classes=10):
        super().__init__()
        self.features = nn.Sequential(
            nn.Conv2d(1, 32, 3, padding=1),
            nn.BatchNorm2d(32),
            nn.ReLU(inplace=True),
            nn.MaxPool2d(2),

            nn.Conv2d(32, 64, 3, padding=1),
            nn.BatchNorm2d(64),
            nn.ReLU(inplace=True),
            nn.MaxPool2d(2),

            nn.Conv2d(64, 128, 3, padding=1),
            nn.BatchNorm2d(128),
            nn.ReLU(inplace=True),
            nn.AdaptiveAvgPool2d(4),
        )
        self.classifier = nn.Sequential(
            nn.Flatten(),
            nn.Linear(128 * 4 * 4, 256),
            nn.ReLU(inplace=True),
            nn.Dropout(0.3),
            nn.Linear(256, num_classes),
        )

    def forward(self, x):
        x = self.features(x)
        x = self.classifier(x)
        return x


def load_digit_samples(digit_dir):
    """Load all digit samples from class directories."""
    samples = []
    for cls_dir in sorted(digit_dir.iterdir()):
        if not cls_dir.is_dir():
            continue
        cls_name = cls_dir.name
        if not cls_name.isdigit():
            continue  # skip colon/pipe for now
        label = int(cls_name)
        for img_path in cls_dir.glob("*.png"):
            samples.append((str(img_path), label))
    return samples


def train_digit_model():
    """Train the digit classifier."""
    digit_dir = DATA_DIR / "digits"

    # First, create digit dataset from Gemini labels
    print("=" * 60)
    print("STEP 1: Creating digit dataset from Gemini labels")
    print("=" * 60)

    total = create_digit_dataset(LABELS_FILE, CROPS_DIR, digit_dir)
    print(f"Total digits extracted: {total}")

    if total < 50:
        print(f"Not enough digits ({total}). Need at least 50. "
              f"Run label_hud_digits_gemini.py first to create labels.")
        return

    # Load samples
    samples = load_digit_samples(digit_dir)
    print(f"\nLoaded {len(samples)} digit samples")

    # Print class distribution
    counter = Counter(l for _, l in samples)
    for digit in range(10):
        print(f"  {digit}: {counter.get(digit, 0)} samples")

    # Split: 80/10/10
    random.seed(SEED)
    random.shuffle(samples)
    n = len(samples)
    n_test = max(1, int(n * 0.1))
    n_val = max(1, int(n * 0.1))
    test = samples[:n_test]
    val = samples[n_test:n_test + n_val]
    train = samples[n_test + n_val:]

    print(f"Split: train={len(train)}, val={len(val)}, test={len(test)}")

    # Transforms
    train_transform = transforms.Compose([
        transforms.RandomAffine(degrees=5, translate=(0.1, 0.1), scale=(0.9, 1.1)),
        transforms.ToTensor(),
    ])
    val_transform = transforms.Compose([
        transforms.ToTensor(),
    ])

    train_loader = DataLoader(DigitDataset(train, train_transform),
                             batch_size=BATCH_SIZE, shuffle=True, num_workers=2)
    val_loader = DataLoader(DigitDataset(val, val_transform),
                           batch_size=BATCH_SIZE, shuffle=False, num_workers=2)
    test_loader = DataLoader(DigitDataset(test, val_transform),
                            batch_size=BATCH_SIZE, shuffle=False, num_workers=2)

    # Model
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    print(f"\nDevice: {device}")

    model = DigitClassifier(num_classes=10).to(device)
    criterion = nn.CrossEntropyLoss()
    optimizer = optim.Adam(model.parameters(), lr=LR)
    scheduler = optim.lr_scheduler.CosineAnnealingLR(optimizer, T_max=NUM_EPOCHS)

    best_acc = 0
    best_state = None

    print(f"\n{'='*60}")
    print(f"STEP 2: Training digit classifier ({NUM_EPOCHS} epochs)")
    print(f"{'='*60}")

    for epoch in range(NUM_EPOCHS):
        model.train()
        total_loss = 0
        correct = 0
        total = 0

        for images, labels in train_loader:
            images, labels = images.to(device), labels.to(device)
            optimizer.zero_grad()
            outputs = model(images)
            loss = criterion(outputs, labels)
            loss.backward()
            optimizer.step()

            total_loss += loss.item()
            _, predicted = outputs.max(1)
            total += labels.size(0)
            correct += predicted.eq(labels).sum().item()

        scheduler.step()

        # Validate
        model.eval()
        val_correct = 0
        val_total = 0
        with torch.no_grad():
            for images, labels in val_loader:
                images, labels = images.to(device), labels.to(device)
                outputs = model(images)
                _, predicted = outputs.max(1)
                val_total += labels.size(0)
                val_correct += predicted.eq(labels).sum().item()

        val_acc = val_correct / max(val_total, 1)
        train_acc = correct / max(total, 1)
        marker = " *BEST*" if val_acc > best_acc else ""

        print(f"  Epoch {epoch+1}/{NUM_EPOCHS}: loss={total_loss/len(train_loader):.4f}, "
              f"train_acc={train_acc:.3f}, val_acc={val_acc:.3f}{marker}")

        if val_acc > best_acc:
            best_acc = val_acc
            best_state = {k: v.cpu().clone() for k, v in model.state_dict().items()}

    # Test evaluation
    print(f"\n{'='*60}")
    print(f"STEP 3: Test evaluation (best val_acc={best_acc:.3f})")
    print(f"{'='*60}")

    model.load_state_dict(best_state)
    model = model.to(device)
    model.eval()

    all_preds = []
    all_labels = []
    with torch.no_grad():
        for images, labels in test_loader:
            images = images.to(device)
            outputs = model(images)
            _, predicted = outputs.max(1)
            all_preds.extend(predicted.cpu().tolist())
            all_labels.extend(labels.tolist())

    print(classification_report(all_labels, all_preds,
                                target_names=[str(i) for i in range(10)], digits=3))

    # Export to ONNX
    print(f"\n{'='*60}")
    print(f"STEP 4: Export to ONNX")
    print(f"{'='*60}")

    model = model.cpu()
    model.eval()
    output_path = MODEL_DIR / "digit-classifier.onnx"
    dummy = torch.randn(1, 1, DIGIT_SIZE, DIGIT_SIZE)
    torch.onnx.export(
        model, dummy, str(output_path),
        input_names=["input"],
        output_names=["output"],
        dynamic_axes={"input": {0: "batch"}, "output": {0: "batch"}},
        opset_version=17,
    )
    size_kb = output_path.stat().st_size / 1024
    print(f"Model saved: {output_path} ({size_kb:.0f} KB)")
    print(f"Best val accuracy: {best_acc:.3f}")


if __name__ == "__main__":
    train_digit_model()
