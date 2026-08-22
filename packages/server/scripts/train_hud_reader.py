"""
Train HUD Number Reader for Valorant

Instead of OCR or digit segmentation, trains a simple regression/classification
model on the WIDE HUD crops to predict numeric values directly.

For each HUD region type, trains a separate small model:
  - health: regression 0-150
  - shield: classification {0, 25, 50}
  - score: classification 0-13
  - credits: regression 0-9000 (binned)
  - timer_minutes: classification 0-2
  - timer_seconds: classification 0-59

Uses Gemini-labeled wide crops as training data.
"""

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
from sklearn.metrics import classification_report, mean_absolute_error

DATA_DIR = Path("data/datasets/digit-classifier")
LABELS_FILE = DATA_DIR / "labels.csv"
MODEL_DIR = Path("src/services/coaching/models")
MODEL_DIR.mkdir(parents=True, exist_ok=True)

IMAGE_SIZE = 128  # smaller than 224 since crops are narrow strips
BATCH_SIZE = 32
SEED = 42


class CropDataset(Dataset):
    def __init__(self, samples, transform=None):
        self.samples = samples
        self.transform = transform

    def __len__(self):
        return len(self.samples)

    def __getitem__(self, idx):
        path, label = self.samples[idx]
        try:
            img = Image.open(path).convert("RGB")
        except Exception:
            img = Image.new("RGB", (IMAGE_SIZE, IMAGE_SIZE))
        if self.transform:
            img = self.transform(img)
        return img, label


train_transform = transforms.Compose([
    transforms.Resize((IMAGE_SIZE, IMAGE_SIZE)),
    transforms.ColorJitter(brightness=0.15, contrast=0.15),
    transforms.RandomAffine(degrees=2, translate=(0.03, 0.03)),
    transforms.ToTensor(),
    transforms.Normalize([0.485, 0.456, 0.406], [0.229, 0.224, 0.225]),
])

val_transform = transforms.Compose([
    transforms.Resize((IMAGE_SIZE, IMAGE_SIZE)),
    transforms.ToTensor(),
    transforms.Normalize([0.485, 0.456, 0.406], [0.229, 0.224, 0.225]),
])


def build_small_model(num_classes):
    """Build a lightweight classifier from MobileNetV2."""
    model = models.mobilenet_v2(weights=models.MobileNet_V2_Weights.IMAGENET1K_V1)
    model.classifier[1] = nn.Linear(model.last_channel, num_classes)
    return model


def load_health_data():
    """Load health values from labeled crops. Bin into ranges."""
    # Bin health into practical ranges for coaching
    # 0-25 (critical), 26-50 (low), 51-75 (medium), 76-100 (full), 101-150 (overheal)
    bins = [(0, 25, "0-25"), (26, 50, "26-50"), (51, 75, "51-75"),
            (76, 100, "76-100"), (101, 150, "101-150")]
    bin_names = [b[2] for b in bins]

    samples = []
    with open(LABELS_FILE) as f:
        for row in csv.DictReader(f):
            if row["region"] != "health_shield_wide":
                continue
            if row.get("readable") != "True":
                continue
            health_str = row.get("health", "").strip()
            if not health_str or health_str in ("None", "null"):
                continue
            try:
                health = int(float(health_str))
            except ValueError:
                continue

            # Find bin
            bin_idx = None
            for i, (lo, hi, _) in enumerate(bins):
                if lo <= health <= hi:
                    bin_idx = i
                    break
            if bin_idx is None:
                continue

            crop_path = row["crop_path"]
            if Path(crop_path).exists():
                samples.append((crop_path, bin_idx))

    return samples, bin_names


def load_shield_data():
    """Load shield values. Classification: {0, 25, 50}."""
    class_map = {0: 0, 25: 1, 50: 2}
    class_names = ["0", "25", "50"]

    samples = []
    with open(LABELS_FILE) as f:
        for row in csv.DictReader(f):
            if row["region"] != "health_shield_wide":
                continue
            if row.get("readable") != "True":
                continue
            shield_str = row.get("shield", "").strip()
            if not shield_str or shield_str in ("None", "null"):
                continue
            try:
                shield = int(float(shield_str))
            except ValueError:
                continue

            if shield not in class_map:
                # Round to nearest valid value
                shield = min(class_map.keys(), key=lambda x: abs(x - shield))
            cls_idx = class_map[shield]

            crop_path = row["crop_path"]
            if Path(crop_path).exists():
                samples.append((crop_path, cls_idx))

    return samples, class_names


def load_score_data():
    """Load score values (0-13). Uses top_hud_wide crops."""
    # Combine left and right scores
    samples = []
    class_names = [str(i) for i in range(14)]

    with open(LABELS_FILE) as f:
        for row in csv.DictReader(f):
            if row["region"] != "top_hud_wide":
                continue
            if row.get("readable") != "True":
                continue

            crop_path = row["crop_path"]
            if not Path(crop_path).exists():
                continue

            for field in ["score_left", "score_right"]:
                val_str = row.get(field, "").strip()
                if not val_str or val_str in ("None", "null"):
                    continue
                try:
                    val = int(float(val_str))
                except ValueError:
                    continue
                if 0 <= val <= 13:
                    samples.append((crop_path, val))

    return samples, class_names


def load_credits_data():
    """Load credit values. Bin into economy ranges for coaching."""
    # Bins that matter for coaching decisions
    bins = [(0, 1000, "0-1k"), (1001, 2000, "1-2k"), (2001, 3000, "2-3k"),
            (3001, 4000, "3-4k"), (4001, 5000, "4-5k"), (5001, 9999, "5k+")]
    bin_names = [b[2] for b in bins]

    samples = []
    with open(LABELS_FILE) as f:
        for row in csv.DictReader(f):
            if row["region"] != "credits_wide":
                continue
            if row.get("readable") != "True":
                continue
            val_str = row.get("credits", "").strip().replace(",", "")
            if not val_str or val_str in ("None", "null"):
                continue
            try:
                val = int(float(val_str))
            except ValueError:
                continue

            bin_idx = None
            for i, (lo, hi, _) in enumerate(bins):
                if lo <= val <= hi:
                    bin_idx = i
                    break
            if bin_idx is None:
                continue

            crop_path = row["crop_path"]
            if Path(crop_path).exists():
                samples.append((crop_path, bin_idx))

    return samples, bin_names


def train_model(name, samples, class_names, output_filename, epochs=12):
    """Train a small classifier and export ONNX."""
    num_classes = len(class_names)
    print(f"\n{'='*50}")
    print(f"Training: {name} ({num_classes} classes, {len(samples)} samples)")
    print(f"{'='*50}")

    if len(samples) < 20:
        print(f"Not enough samples. Skipping.")
        return

    counter = Counter(l for _, l in samples)
    for i, cn in enumerate(class_names):
        print(f"  [{i}] {cn}: {counter.get(i, 0)}")

    random.seed(SEED)
    random.shuffle(samples)
    n = len(samples)
    n_test = max(1, int(n * 0.1))
    n_val = max(1, int(n * 0.1))
    test = samples[:n_test]
    val = samples[n_test:n_test + n_val]
    train = samples[n_test + n_val:]

    print(f"Split: train={len(train)}, val={len(val)}, test={len(test)}")

    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")

    train_loader = DataLoader(CropDataset(train, train_transform),
                             batch_size=BATCH_SIZE, shuffle=True, num_workers=0)
    val_loader = DataLoader(CropDataset(val, val_transform),
                           batch_size=BATCH_SIZE, shuffle=False, num_workers=0)
    test_loader = DataLoader(CropDataset(test, val_transform),
                            batch_size=BATCH_SIZE, shuffle=False, num_workers=0)

    model = build_small_model(num_classes).to(device)
    criterion = nn.CrossEntropyLoss()
    optimizer = optim.Adam(model.parameters(), lr=1e-4)
    scheduler = optim.lr_scheduler.CosineAnnealingLR(optimizer, T_max=epochs)

    best_acc = 0
    best_state = None

    for epoch in range(epochs):
        model.train()
        total_loss = 0
        correct = 0
        total = 0
        for images, labels in train_loader:
            images, labels = images.to(device), labels.to(device)
            optimizer.zero_grad()
            out = model(images)
            loss = criterion(out, labels)
            loss.backward()
            optimizer.step()
            total_loss += loss.item()
            _, pred = out.max(1)
            total += labels.size(0)
            correct += pred.eq(labels).sum().item()
        scheduler.step()

        # Val
        model.eval()
        vc = vt = 0
        with torch.no_grad():
            for images, labels in val_loader:
                images, labels = images.to(device), labels.to(device)
                _, pred = model(images).max(1)
                vt += labels.size(0)
                vc += pred.eq(labels).sum().item()
        val_acc = vc / max(vt, 1)
        marker = " *BEST*" if val_acc > best_acc else ""
        print(f"  Epoch {epoch+1}/{epochs}: loss={total_loss/max(len(train_loader),1):.4f}, "
              f"train_acc={correct/max(total,1):.3f}, val_acc={val_acc:.3f}{marker}")
        if val_acc > best_acc:
            best_acc = val_acc
            best_state = {k: v.cpu().clone() for k, v in model.state_dict().items()}

    if best_state is None:
        print("No improvement. Skipping export.")
        return

    # Test
    model.load_state_dict(best_state)
    model = model.to(device).eval()
    all_p, all_l = [], []
    with torch.no_grad():
        for images, labels in test_loader:
            images = images.to(device)
            _, pred = model(images).max(1)
            all_p.extend(pred.cpu().tolist())
            all_l.extend(labels.tolist())
    present = sorted(set(all_l + all_p))
    names = [class_names[i] if i < len(class_names) else str(i) for i in present]
    print(classification_report(all_l, all_p, labels=present, target_names=names, digits=3))

    # Export ONNX
    output_path = MODEL_DIR / output_filename
    model = model.cpu()
    dummy = torch.randn(1, 3, IMAGE_SIZE, IMAGE_SIZE)
    torch.onnx.export(model, dummy, str(output_path),
                      input_names=["input"], output_names=["output"],
                      dynamic_axes={"input": {0: "batch"}, "output": {0: "batch"}},
                      opset_version=17)
    size_kb = output_path.stat().st_size / 1024
    print(f"Model saved: {output_path} ({size_kb:.0f} KB)")

    mapping_path = output_path.with_suffix(".classes.txt")
    with open(mapping_path, "w") as f:
        for cn in class_names:
            f.write(f"{cn}\n")


def main():
    print("Loading Gemini-labeled HUD data...")

    # Train each HUD reader
    samples, names = load_health_data()
    train_model("Health Reader", samples, names, "health-reader.onnx")

    samples, names = load_shield_data()
    train_model("Shield Reader", samples, names, "shield-reader.onnx")

    samples, names = load_score_data()
    train_model("Score Reader", samples, names, "score-reader.onnx")

    samples, names = load_credits_data()
    train_model("Credits Reader", samples, names, "credits-reader.onnx")

    print("\nAll HUD readers trained!")


if __name__ == "__main__":
    main()
