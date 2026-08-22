"""
Train MobileNetV2 Frame Classifier for Valorant Game State Detection

Classes: gameplay, death_screen, spectating, buy_phase, round_end, loading

Uses:
  - labels_reviewed.csv (if exists) or labels.csv for training labels
  - Pretrained MobileNetV2 from torchvision
  - Weighted CrossEntropyLoss for class imbalance
  - Exports to ONNX for Node.js inference

Usage:
  python scripts/train_classifier.py

Output:
  src/services/coaching/models/valorant-classifier.onnx
"""

import os
import csv
import random
from pathlib import Path
from collections import Counter

import torch
import torch.nn as nn
import torch.optim as optim
from torch.utils.data import Dataset, DataLoader, WeightedRandomSampler
from torchvision import transforms, models
from PIL import Image
from sklearn.metrics import classification_report, confusion_matrix

# ── Config ────────────────────────────────────────────────────────────────────

DATA_DIR = Path("data")
LABELS_FILE = DATA_DIR / "labels.csv"  # Always load base labels, then apply corrections from labels_reviewed.csv
MODEL_OUTPUT = Path("src/services/coaching/models/valorant-classifier.onnx")
MODEL_OUTPUT.parent.mkdir(parents=True, exist_ok=True)

CLASSES = ["gameplay", "death_screen", "spectating", "buy_phase", "round_end", "loading"]
CLASS_TO_IDX = {c: i for i, c in enumerate(CLASSES)}

BATCH_SIZE = 32
NUM_EPOCHS_FROZEN = 3
NUM_EPOCHS_UNFROZEN = 12
LR_FROZEN = 1e-3
LR_UNFROZEN = 1e-4
IMAGE_SIZE = 224
SEED = 42

# ── Dataset ───────────────────────────────────────────────────────────────────

class FrameDataset(Dataset):
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
            # Return a black image if file is corrupt
            img = Image.new("RGB", (IMAGE_SIZE, IMAGE_SIZE), (0, 0, 0))
        if self.transform:
            img = self.transform(img)
        return img, label

# ── Transforms ────────────────────────────────────────────────────────────────

train_transform = transforms.Compose([
    transforms.Resize((IMAGE_SIZE, IMAGE_SIZE)),
    transforms.ColorJitter(brightness=0.2, contrast=0.2, saturation=0.1),
    transforms.RandomAffine(degrees=3, translate=(0.05, 0.05)),
    transforms.ToTensor(),
    transforms.Normalize(mean=[0.485, 0.456, 0.406], std=[0.229, 0.224, 0.225]),
])

val_transform = transforms.Compose([
    transforms.Resize((IMAGE_SIZE, IMAGE_SIZE)),
    transforms.ToTensor(),
    transforms.Normalize(mean=[0.485, 0.456, 0.406], std=[0.229, 0.224, 0.225]),
])

# ── Load and split data ──────────────────────────────────────────────────────

def load_data():
    print(f"Loading labels from: {LABELS_FILE}")
    samples = []

    # Load base labels
    with open(LABELS_FILE) as f:
        reader = csv.reader(f)
        next(reader)  # skip header
        for row in reader:
            if len(row) < 2:
                continue
            frame_path = row[0]
            label = row[1].strip()
            if label not in CLASS_TO_IDX:
                continue
            if not os.path.exists(frame_path):
                continue
            samples.append((frame_path, CLASS_TO_IDX[label]))

    # If reviewed labels exist, apply corrections
    reviewed_file = DATA_DIR / "labels_reviewed.csv"
    corrections = {}
    if reviewed_file.exists() and str(LABELS_FILE) != str(reviewed_file):
        with open(reviewed_file) as f:
            reader = csv.reader(f)
            next(reader)  # skip header
            for row in reader:
                if len(row) >= 2:
                    corrections[row[0]] = row[1].strip()
        print(f"Applying {len(corrections)} corrections from labels_reviewed.csv")
        samples = [(p, CLASS_TO_IDX.get(corrections.get(p, CLASSES[l]), l)) for p, l in samples]

    print(f"Total samples: {len(samples)}")

    # Print class distribution
    counter = Counter(l for _, l in samples)
    for cls, idx in CLASS_TO_IDX.items():
        print(f"  {cls}: {counter[idx]}")

    # Stratified split: 80% train, 10% val, 10% test
    random.seed(SEED)
    by_class = {i: [] for i in range(len(CLASSES))}
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

    print(f"\nSplit: train={len(train)}, val={len(val)}, test={len(test)}")
    return train, val, test

# ── Training ──────────────────────────────────────────────────────────────────

def train():
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    print(f"\nDevice: {device}")
    if device.type == "cuda":
        print(f"GPU: {torch.cuda.get_device_name(0)}")

    train_data, val_data, test_data = load_data()

    # Weighted sampler for class imbalance
    train_labels = [l for _, l in train_data]
    class_counts = Counter(train_labels)
    weights = [1.0 / class_counts[l] for l in train_labels]
    sampler = WeightedRandomSampler(weights, len(weights))

    train_loader = DataLoader(FrameDataset(train_data, train_transform), batch_size=BATCH_SIZE, sampler=sampler, num_workers=4, pin_memory=True)
    val_loader = DataLoader(FrameDataset(val_data, val_transform), batch_size=BATCH_SIZE, shuffle=False, num_workers=4, pin_memory=True)
    test_loader = DataLoader(FrameDataset(test_data, val_transform), batch_size=BATCH_SIZE, shuffle=False, num_workers=4, pin_memory=True)

    # Model: MobileNetV2 with custom head
    model = models.mobilenet_v2(weights=models.MobileNet_V2_Weights.IMAGENET1K_V1)
    model.classifier[1] = nn.Linear(model.last_channel, len(CLASSES))
    model = model.to(device)

    # Use unweighted loss — class imbalance is already handled by WeightedRandomSampler
    criterion = nn.CrossEntropyLoss()

    best_f1 = 0
    best_model_state = None

    # Phase 1: Freeze backbone, train classifier head
    print("\n=== Phase 1: Frozen backbone (3 epochs) ===")
    for param in model.features.parameters():
        param.requires_grad = False
    optimizer = optim.Adam(model.classifier.parameters(), lr=LR_FROZEN)

    for epoch in range(NUM_EPOCHS_FROZEN):
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

        val_f1 = evaluate(model, val_loader, device)
        print(f"  Epoch {epoch+1}/{NUM_EPOCHS_FROZEN}: loss={total_loss/len(train_loader):.4f}, train_acc={100*correct/total:.1f}%, val_F1={val_f1:.3f}")

        if val_f1 > best_f1:
            best_f1 = val_f1
            best_model_state = {k: v.cpu().clone() for k, v in model.state_dict().items()}

    # Phase 2: Unfreeze all, fine-tune
    print(f"\n=== Phase 2: Full fine-tuning (12 epochs) ===")
    for param in model.parameters():
        param.requires_grad = True
    optimizer = optim.Adam(model.parameters(), lr=LR_UNFROZEN)
    scheduler = optim.lr_scheduler.CosineAnnealingLR(optimizer, T_max=NUM_EPOCHS_UNFROZEN)

    for epoch in range(NUM_EPOCHS_UNFROZEN):
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
        val_f1 = evaluate(model, val_loader, device)
        marker = " *BEST*" if val_f1 > best_f1 else ""
        print(f"  Epoch {epoch+1}/{NUM_EPOCHS_UNFROZEN}: loss={total_loss/len(train_loader):.4f}, train_acc={100*correct/total:.1f}%, val_F1={val_f1:.3f}{marker}")

        if val_f1 > best_f1:
            best_f1 = val_f1
            best_model_state = {k: v.cpu().clone() for k, v in model.state_dict().items()}

    # Load best model and evaluate on test set
    print(f"\n=== Test Set Evaluation (best val F1={best_f1:.3f}) ===")
    model.load_state_dict(best_model_state)
    model = model.to(device)
    test_f1 = evaluate(model, test_loader, device, detailed=True)

    # Export to ONNX
    print(f"\n=== Exporting to ONNX ===")
    model.eval()
    model = model.cpu()
    dummy = torch.randn(1, 3, IMAGE_SIZE, IMAGE_SIZE)
    torch.onnx.export(
        model, dummy, str(MODEL_OUTPUT),
        input_names=["input"],
        output_names=["output"],
        dynamic_axes={"input": {0: "batch"}, "output": {0: "batch"}},
        opset_version=17,
    )
    size_mb = MODEL_OUTPUT.stat().st_size / 1024 / 1024
    print(f"Model saved: {MODEL_OUTPUT} ({size_mb:.1f} MB)")
    print(f"\nDone! Best val F1={best_f1:.3f}, test F1={test_f1:.3f}")

def evaluate(model, loader, device, detailed=False):
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

    if detailed:
        print(classification_report(all_labels, all_preds, target_names=CLASSES, digits=3))
        cm = confusion_matrix(all_labels, all_preds)
        print("Confusion matrix:")
        print(f"{'':>15}", end="")
        for c in CLASSES:
            print(f"{c[:8]:>10}", end="")
        print()
        for i, row in enumerate(cm):
            print(f"{CLASSES[i]:>15}", end="")
            for v in row:
                print(f"{v:>10}", end="")
            print()

    # Compute macro F1
    from sklearn.metrics import f1_score
    return f1_score(all_labels, all_preds, average="macro")

if __name__ == "__main__":
    train()
