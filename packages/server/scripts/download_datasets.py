"""
Download training datasets from Roboflow Universe for Scrima CV models.

Downloads:
  1. Gunfight Analyzer 2 — 4,206 images, 17 weapon classes (YOLOv8 format)
  2. Simple VALORANT UI Detector — 1,742 images, kill/round/spike events
  3. Valorant Kill Detection — 2,154 images, kill events
  4. Valorant Agent Detect — agent classification
  5. Valorant Map Analyser — 1,330 images, minimap icons

Uses Roboflow API key to download in YOLOv8 format.
"""

import os
import sys
import subprocess
from pathlib import Path

DATA_DIR = Path("data/datasets")

# Roboflow API key
RF_API_KEY = os.environ.get("ROBOFLOW_API_KEY")
if not RF_API_KEY:
    raise ValueError("ROBOFLOW_API_KEY environment variable is required")


def download_roboflow_dataset(workspace, project, version, output_name, fmt="yolov8"):
    """Download a dataset from Roboflow Universe."""
    output_dir = DATA_DIR / output_name
    if output_dir.exists() and any(output_dir.iterdir()):
        print(f"  SKIP: {output_name} already exists")
        return True

    output_dir.mkdir(parents=True, exist_ok=True)

    print(f"  Downloading {workspace}/{project} v{version} as {fmt}...")

    try:
        from roboflow import Roboflow
        rf = Roboflow(api_key=RF_API_KEY)
        proj = rf.workspace(workspace).project(project)
        dataset = proj.version(version).download(fmt, location=str(output_dir))
        print(f"  [OK] Downloaded to {output_dir}")
        return True
    except Exception as e:
        print(f"  [FAIL] {e}")
        # Fallback: try direct URL download
        return False


def download_kaggle_dataset(dataset_slug, output_name):
    """Download a dataset from Kaggle."""
    output_dir = DATA_DIR / output_name
    if output_dir.exists() and any(output_dir.iterdir()):
        print(f"  SKIP: {output_name} already exists")
        return True

    output_dir.mkdir(parents=True, exist_ok=True)

    print(f"  Downloading kaggle: {dataset_slug}...")

    try:
        result = subprocess.run(
            ["kaggle", "datasets", "download", "-d", dataset_slug,
             "-p", str(output_dir), "--unzip"],
            capture_output=True, text=True, timeout=600
        )
        if result.returncode == 0:
            print(f"  [OK] Downloaded to {output_dir}")
            return True
        else:
            print(f"  [FAIL] Kaggle CLI error: {result.stderr[:200]}")
            return False
    except FileNotFoundError:
        print(f"  [FAIL] Kaggle CLI not installed (pip install kaggle)")
        return False
    except Exception as e:
        print(f"  [FAIL] {e}")
        return False


def main():
    DATA_DIR.mkdir(parents=True, exist_ok=True)

    print("=" * 60)
    print("DOWNLOADING TRAINING DATASETS")
    print("=" * 60)

    results = {}

    # ── 1. Weapon Classifier: Gunfight Analyzer 2 ──────────────────────────
    print("\n[1/5] Weapon Classifier — Gunfight Analyzer 2 (4,206 imgs)")
    results["weapon"] = download_roboflow_dataset(
        workspace="vihal-arumalla-gwjo9",
        project="valorant-gunfight-analyzer-2",
        version=1,
        output_name="weapon-classifier",
        fmt="yolov8"
    )

    # ── 2. UI/Event Detector: Simple VALORANT UI Detector ──────────────────
    print("\n[2/5] Kill/Event Detector — Simple VALORANT UI Detector (1,742 imgs)")
    results["ui_events"] = download_roboflow_dataset(
        workspace="christalin-dorsey-ljvjf",
        project="simple-valorant-ui-detector",
        version=1,
        output_name="ui-events",
        fmt="yolov8"
    )

    # ── 3. Kill Detection ──────────────────────────────────────────────────
    print("\n[3/5] Kill Detection — John McAlinden (2,154 imgs)")
    results["kill_detection"] = download_roboflow_dataset(
        workspace="john-mcalinden",
        project="valorant-kill-detection",
        version=1,
        output_name="kill-detection",
        fmt="yolov8"
    )

    # ── 4. Agent Classifier ────────────────────────────────────────────────
    print("\n[4/5] Agent Classifier — Kaggle Structured Collection (8,247 imgs)")
    results["agent"] = download_kaggle_dataset(
        dataset_slug="rushilverma07/valorant-image-dataset-structured-collection",
        output_name="agent-classifier"
    )

    # ── 5. Map Classifier — from Kaggle structured collection (included in #4)
    print("\n[5/5] Map + supplementary — valorant-kills Roboflow (1,487 imgs)")
    results["kills_detailed"] = download_roboflow_dataset(
        workspace="valorantkills",
        project="valorant-kills-llb5g",
        version=3,
        output_name="kills-detailed",
        fmt="yolov8"
    )

    # ── Summary ────────────────────────────────────────────────────────────
    print("\n" + "=" * 60)
    print("DOWNLOAD SUMMARY")
    print("=" * 60)
    for name, success in results.items():
        status = "OK" if success else "FAILED"
        print(f"  {name:20s}: {status}")

    # Check what we have
    print("\nDataset sizes:")
    for d in sorted(DATA_DIR.iterdir()):
        if d.is_dir():
            files = list(d.rglob("*"))
            images = [f for f in files if f.suffix.lower() in {".jpg", ".jpeg", ".png"}]
            print(f"  {d.name}: {len(images)} images, {len(files)} total files")


if __name__ == "__main__":
    main()
