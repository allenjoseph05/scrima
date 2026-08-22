"""
Train Weapon and Agent Classifiers for Valorant

Uses downloaded datasets:
  - Weapon: Gunfight Analyzer 2 (Roboflow, 4,206 imgs, 17 weapons + enemy/head)
  - Agent: Kaggle Structured Collection (8,247 imgs, agents/weapons/maps/abilities)
  - Map: Extracted from agent dataset's map category

Architecture: MobileNetV2 fine-tuned, exported to ONNX (same as game state classifier)

Usage:
  python scripts/train_weapon_agent.py [weapon|agent|map|all]
"""

import os
import sys
import csv
import random
import shutil
from pathlib import Path
from collections import Counter

import torch
import torch.nn as nn
import torch.optim as optim
from torch.utils.data import Dataset, DataLoader, WeightedRandomSampler
from torchvision import transforms, models
from PIL import Image
from sklearn.metrics import classification_report, f1_score

# ── Config ──────────────────────────────────────────────────────────────────

DATA_DIR = Path("data/datasets")
MODEL_DIR = Path("src/services/coaching/models")
MODEL_DIR.mkdir(parents=True, exist_ok=True)

IMAGE_SIZE = 224
BATCH_SIZE = 32
SEED = 42

# ── Shared Dataset Class ────────────────────────────────────────────────────

class ImageClassificationDataset(Dataset):
    def __init__(self, samples, transform=None):
        self.samples = samples  # list of (path, label_idx)
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


# ── Transforms ──────────────────────────────────────────────────────────────

train_transform = transforms.Compose([
    transforms.Resize((IMAGE_SIZE, IMAGE_SIZE)),
    transforms.RandomHorizontalFlip(0.5),
    transforms.ColorJitter(brightness=0.2, contrast=0.2, saturation=0.1),
    transforms.RandomAffine(degrees=5, translate=(0.05, 0.05)),
    transforms.ToTensor(),
    transforms.Normalize([0.485, 0.456, 0.406], [0.229, 0.224, 0.225]),
])

val_transform = transforms.Compose([
    transforms.Resize((IMAGE_SIZE, IMAGE_SIZE)),
    transforms.ToTensor(),
    transforms.Normalize([0.485, 0.456, 0.406], [0.229, 0.224, 0.225]),
])


# ── Weapon Classifier ───────────────────────────────────────────────────────

# The 17 standard weapons (excluding enemy/head detection classes)
WEAPON_CLASSES = [
    "Ares", "Bucky", "Bulldog", "Classic", "Frenzy", "Ghost",
    "Guardian", "Judge", "Marshall", "Odin", "Operator",
    "Phantom", "Sheriff", "Shorty", "Spectre", "Stinger", "Vandal",
]

def load_weapon_dataset():
    """Load weapon dataset from Roboflow YOLO format (classification from crops)."""
    dataset_dir = DATA_DIR / "weapon-classifier"

    # Roboflow YOLO format has train/valid/test dirs with images/ and labels/
    samples = []
    classes_found = set()

    for split in ["train", "valid", "test"]:
        img_dir = dataset_dir / split / "images"
        label_dir = dataset_dir / split / "labels"

        if not img_dir.exists():
            # Try alternative structure
            img_dir = dataset_dir / split
            label_dir = dataset_dir / split

        if not img_dir.exists():
            continue

        for img_path in img_dir.glob("*.jpg"):
            label_path = label_dir / (img_path.stem + ".txt")
            if not label_path.exists():
                continue

            # Read YOLO label — get the class of the largest bounding box
            with open(label_path) as f:
                lines = f.readlines()

            if not lines:
                continue

            # Find the class with the largest bounding box area
            best_class = None
            best_area = 0
            for line in lines:
                parts = line.strip().split()
                if len(parts) >= 5:
                    cls_idx = int(parts[0])
                    w, h = float(parts[3]), float(parts[4])
                    area = w * h
                    if area > best_area:
                        best_area = area
                        best_class = cls_idx

            if best_class is not None:
                samples.append((str(img_path), best_class))
                classes_found.add(best_class)

    # Read class names from data.yaml to filter out non-weapon classes
    yaml_path = dataset_dir / "data.yaml"
    if yaml_path.exists():
        try:
            import yaml
            with open(yaml_path) as f:
                data = yaml.safe_load(f)
            names = data.get("names", [])
            # Filter out enemy/enemy_head — we only want weapon classes
            exclude = {"enemy", "enemy_head"}
            keep_indices = {i for i, n in enumerate(names) if n not in exclude}
            if keep_indices:
                samples = [(p, l) for p, l in samples if l in keep_indices]
                # Remap indices to be contiguous
                old_to_new = {old: new for new, old in enumerate(sorted(keep_indices))}
                samples = [(p, old_to_new[l]) for p, l in samples]
                classes_found = set(range(len(keep_indices)))
        except Exception:
            pass

    return samples, sorted(classes_found)


def load_agent_dataset():
    """Load agent dataset from Roboflow YOLO format (same as weapon)."""
    dataset_dir = DATA_DIR / "agent-classifier"

    # Read class names from data.yaml
    yaml_path = dataset_dir / "data.yaml"
    if not yaml_path.exists():
        print(f"No data.yaml found in {dataset_dir}")
        return [], []

    import yaml
    with open(yaml_path) as f:
        data = yaml.safe_load(f)
    class_names = data.get("names", [])
    print(f"Agent classes from YAML: {class_names}")

    samples = []
    for split in ["train", "valid", "test"]:
        img_dir = dataset_dir / split / "images"
        label_dir = dataset_dir / split / "labels"
        if not img_dir.exists():
            continue

        for img_path in list(img_dir.glob("*.jpg")) + list(img_dir.glob("*.png")):
            label_path = label_dir / (img_path.stem + ".txt")
            if not label_path.exists():
                continue

            with open(label_path) as f:
                lines = f.readlines()
            if not lines:
                continue

            # Get the class with largest bounding box
            best_class = None
            best_area = 0
            for line in lines:
                parts = line.strip().split()
                if len(parts) >= 5:
                    cls_idx = int(parts[0])
                    w, h = float(parts[3]), float(parts[4])
                    area = w * h
                    if area > best_area and cls_idx < len(class_names):
                        best_area = area
                        best_class = cls_idx

            if best_class is not None:
                samples.append((str(img_path), best_class))

    return samples, class_names


def load_map_dataset():
    """Load map classification data from structured collection or video frames."""
    dataset_dir = DATA_DIR / "agent-classifier"

    samples = []
    classes = []

    # Try CSV for map images
    csv_files = list(dataset_dir.rglob("*.csv"))
    if csv_files:
        for csv_file in csv_files:
            with open(csv_file) as f:
                reader = csv.DictReader(f)
                for row in reader:
                    tag = row.get("tag", "").strip().lower()
                    img_path = row.get("image_path", "")

                    if "map" in tag or any(m in tag for m in
                        ["ascent", "bind", "haven", "split", "icebox",
                         "breeze", "fracture", "pearl", "lotus", "sunset",
                         "abyss", "corrode"]):

                        full_path = dataset_dir / img_path
                        if full_path.exists():
                            if tag not in classes:
                                classes.append(tag)
                            samples.append((str(full_path), classes.index(tag)))

    return samples, classes


# ── Training Function ────────────────────────────────────────────────────────

def train_classifier(name, samples, class_names, output_filename,
                     epochs_frozen=3, epochs_unfrozen=12,
                     lr_frozen=1e-3, lr_unfrozen=1e-4):
    """Train a MobileNetV2 classifier and export to ONNX."""

    print(f"\n{'='*60}")
    print(f"TRAINING: {name}")
    print(f"{'='*60}")

    num_classes = len(class_names)
    print(f"Classes ({num_classes}): {class_names}")
    print(f"Total samples: {len(samples)}")

    if len(samples) < 20:
        print(f"Not enough samples ({len(samples)}). Skipping.")
        return

    # Print distribution
    counter = Counter(l for _, l in samples)
    for i, cls in enumerate(class_names):
        name_short = cls[:20] if isinstance(cls, str) else str(cls)
        print(f"  [{i}] {name_short}: {counter.get(i, 0)}")

    # Stratified split
    random.seed(SEED)
    by_class = {i: [] for i in range(num_classes)}
    for s in samples:
        by_class[s[1]].append(s)

    train, val, test = [], [], []
    for cls_samples in by_class.values():
        random.shuffle(cls_samples)
        n = len(cls_samples)
        n_val = max(1, int(n * 0.1))
        n_test = max(1, int(n * 0.1))
        test.extend(cls_samples[:n_test])
        val.extend(cls_samples[n_test:n_test + n_val])
        train.extend(cls_samples[n_test + n_val:])

    print(f"Split: train={len(train)}, val={len(val)}, test={len(test)}")

    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    print(f"Device: {device}")

    # Weighted sampler
    train_labels = [l for _, l in train]
    class_counts = Counter(train_labels)
    weights = [1.0 / max(class_counts[l], 1) for l in train_labels]
    sampler = WeightedRandomSampler(weights, len(weights))

    train_loader = DataLoader(ImageClassificationDataset(train, train_transform),
                             batch_size=BATCH_SIZE, sampler=sampler, num_workers=0,
                             pin_memory=True)
    val_loader = DataLoader(ImageClassificationDataset(val, val_transform),
                           batch_size=BATCH_SIZE, shuffle=False, num_workers=0,
                           pin_memory=True)
    test_loader = DataLoader(ImageClassificationDataset(test, val_transform),
                            batch_size=BATCH_SIZE, shuffle=False, num_workers=0,
                            pin_memory=True)

    # Model
    model = models.mobilenet_v2(weights=models.MobileNet_V2_Weights.IMAGENET1K_V1)
    model.classifier[1] = nn.Linear(model.last_channel, num_classes)
    model = model.to(device)

    # Class weights for loss
    total = sum(class_counts.values())
    class_weights = torch.tensor(
        [total / (num_classes * max(class_counts.get(i, 1), 1))
         for i in range(num_classes)],
        dtype=torch.float32
    ).to(device)
    criterion = nn.CrossEntropyLoss(weight=class_weights)

    best_f1 = 0
    best_state = None

    # Phase 1: Frozen backbone
    print(f"\n--- Phase 1: Frozen backbone ({epochs_frozen} epochs) ---")
    for param in model.features.parameters():
        param.requires_grad = False
    optimizer = optim.Adam(model.classifier.parameters(), lr=lr_frozen)

    for epoch in range(epochs_frozen):
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

        val_f1 = _evaluate(model, val_loader, device)
        print(f"  Epoch {epoch+1}/{epochs_frozen}: loss={total_loss/len(train_loader):.4f}, "
              f"train_acc={correct/total:.3f}, val_F1={val_f1:.3f}")
        if val_f1 > best_f1:
            best_f1 = val_f1
            best_state = {k: v.cpu().clone() for k, v in model.state_dict().items()}

    # Phase 2: Full fine-tuning
    print(f"\n--- Phase 2: Full fine-tuning ({epochs_unfrozen} epochs) ---")
    for param in model.parameters():
        param.requires_grad = True
    optimizer = optim.Adam(model.parameters(), lr=lr_unfrozen)
    scheduler = optim.lr_scheduler.CosineAnnealingLR(optimizer, T_max=epochs_unfrozen)

    for epoch in range(epochs_unfrozen):
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
        val_f1 = _evaluate(model, val_loader, device)
        marker = " *BEST*" if val_f1 > best_f1 else ""
        print(f"  Epoch {epoch+1}/{epochs_unfrozen}: loss={total_loss/len(train_loader):.4f}, "
              f"train_acc={correct/total:.3f}, val_F1={val_f1:.3f}{marker}")
        if val_f1 > best_f1:
            best_f1 = val_f1
            best_state = {k: v.cpu().clone() for k, v in model.state_dict().items()}

    # Test evaluation
    print(f"\n--- Test evaluation (best val F1={best_f1:.3f}) ---")
    model.load_state_dict(best_state)
    model = model.to(device)
    _evaluate(model, test_loader, device, detailed=True, class_names=class_names)

    # Export ONNX
    output_path = MODEL_DIR / output_filename
    model = model.cpu()
    model.eval()
    dummy = torch.randn(1, 3, IMAGE_SIZE, IMAGE_SIZE)
    torch.onnx.export(
        model, dummy, str(output_path),
        input_names=["input"],
        output_names=["output"],
        dynamic_axes={"input": {0: "batch"}, "output": {0: "batch"}},
        opset_version=17,
    )
    size_mb = output_path.stat().st_size / 1024 / 1024
    print(f"\nModel saved: {output_path} ({size_mb:.1f} MB)")

    # Save class mapping
    mapping_path = output_path.with_suffix(".classes.txt")
    with open(mapping_path, "w") as f:
        for cls in class_names:
            f.write(f"{cls}\n")
    print(f"Classes saved: {mapping_path}")

    return best_f1


def _evaluate(model, loader, device, detailed=False, class_names=None):
    """Evaluate model and return macro F1."""
    model.eval()
    all_preds = []
    all_labels = []
    with torch.no_grad():
        for images, labels in loader:
            images = images.to(device)
            outputs = model(images)
            _, predicted = outputs.max(1)
            all_preds.extend(predicted.cpu().tolist())
            all_labels.extend(labels.tolist())

    if detailed and class_names:
        # Only include classes that appear in predictions or labels
        present = sorted(set(all_labels + all_preds))
        names = [str(class_names[i]) if i < len(class_names) else str(i)
                 for i in present]
        print(classification_report(all_labels, all_preds,
                                    labels=present, target_names=names, digits=3))

    return f1_score(all_labels, all_preds, average="macro", zero_division=0)


# ── Main ─────────────────────────────────────────────────────────────────────

def main():
    target = sys.argv[1] if len(sys.argv) > 1 else "all"

    if target in ("weapon", "all"):
        print("\nLoading weapon dataset...")
        samples, class_indices = load_weapon_dataset()
        if samples:
            # Read class names from data.yaml
            yaml_path = DATA_DIR / "weapon-classifier" / "data.yaml"
            if yaml_path.exists():
                import yaml
                with open(yaml_path) as f:
                    data = yaml.safe_load(f)
                class_names = data.get("names", [str(i) for i in class_indices])
            else:
                class_names = [str(i) for i in class_indices]

            train_classifier("Weapon Classifier", samples, class_names,
                           "weapon-classifier.onnx")
        else:
            print("No weapon data found. Download dataset first.")

    if target in ("agent", "all"):
        print("\nLoading agent dataset...")
        samples, class_names = load_agent_dataset()
        if samples:
            train_classifier("Agent Classifier", samples, class_names,
                           "agent-classifier.onnx")
        else:
            print("No agent data found. Download dataset first.")

    if target in ("map", "all"):
        print("\nLoading map dataset...")
        samples, class_names = load_map_dataset()
        if samples:
            train_classifier("Map Classifier", samples, class_names,
                           "map-classifier.onnx")
        else:
            print("No map data found. Will extract from videos later.")

    print("\n" + "=" * 60)
    print("ALL DONE")
    print("=" * 60)


if __name__ == "__main__":
    main()
