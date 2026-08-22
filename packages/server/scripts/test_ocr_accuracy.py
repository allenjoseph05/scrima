"""
OCR Accuracy Test on Valorant HUD Elements (1280x720)

Tests EasyOCR with various preprocessing on cropped HUD regions.
Saves crops for visual verification.
"""

import os
import cv2
import numpy as np
from pathlib import Path

# ── HUD Region Definitions (1280x720) ──────────────────────────────────────
# Format: (x1, y1, x2, y2) - crop coordinates
# These are approximate and may need tuning per video source

REGIONS_720p = {
    # Bottom-center HUD
    "health_shield": (330, 680, 530, 712),     # "50 | 100" or "100"
    "health_number": (390, 680, 480, 712),      # just the HP number
    "shield_number": (330, 680, 390, 712),      # just the shield number

    # Top-center HUD
    "timer": (590, 35, 690, 62),                # "1:30" or "0:45"
    "score_left": (555, 35, 595, 62),           # left team score
    "score_right": (685, 35, 725, 62),          # right team score

    # Bottom-right HUD
    "ammo": (1155, 680, 1240, 712),             # "25 | 75" or "6 24"
    "credits": (1150, 690, 1275, 715),          # "¤ 2,050" (when visible)

    # Wider crops for context
    "bottom_hud_full": (280, 670, 1280, 720),   # entire bottom HUD strip
    "top_hud_full": (400, 25, 880, 70),         # entire top HUD strip
}

# Expected values (manually read from frames for ground truth)
GROUND_TRUTH = {
    "cypher_gameplay_1.jpg": {
        "health_shield": "50 100",
        "timer": "1:43",
        "score_left": "1",
        "score_right": "0",
        "ammo": "0",
    },
    "cypher_gameplay_2.jpg": {},  # will fill after seeing crops
    "cypher_buy_1.jpg": {
        "timer": "1:30",
        "score_left": "0",
        "score_right": "0",
    },
    "breach_gameplay_1.jpg": {
        "health_shield": "100",
        "timer": "0:13",
        "ammo": "6",
    },
    "clove_gameplay_1.jpg": {
        "health_shield": "23 87",
        "timer": "",
        "ammo": "5",
        "credits": "2050",
    },
}

# ── Preprocessing Methods ───────────────────────────────────────────────────

def preprocess_raw(crop):
    """No preprocessing, just RGB"""
    return crop

def preprocess_gray(crop):
    """Convert to grayscale"""
    return cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)

def preprocess_threshold(crop):
    """Grayscale + adaptive threshold"""
    gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
    return cv2.adaptiveThreshold(gray, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
                                  cv2.THRESH_BINARY, 11, 2)

def preprocess_otsu(crop):
    """Grayscale + Otsu threshold"""
    gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
    _, thresh = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    return thresh

def preprocess_white_text(crop):
    """Extract white/bright text on dark background"""
    gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
    # White text is typically > 180 brightness
    _, thresh = cv2.threshold(gray, 170, 255, cv2.THRESH_BINARY)
    return thresh

def preprocess_invert_white(crop):
    """Extract white text, then invert (black text on white bg)"""
    gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
    _, thresh = cv2.threshold(gray, 170, 255, cv2.THRESH_BINARY)
    return cv2.bitwise_not(thresh)

def preprocess_contrast_boost(crop):
    """Boost contrast via CLAHE"""
    gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
    clahe = cv2.createCLAHE(clipLimit=3.0, tileGridSize=(2, 2))
    return clahe.apply(gray)

def preprocess_upscale_white(crop):
    """Upscale 3x + white text extraction"""
    upscaled = cv2.resize(crop, None, fx=3, fy=3, interpolation=cv2.INTER_CUBIC)
    gray = cv2.cvtColor(upscaled, cv2.COLOR_BGR2GRAY)
    _, thresh = cv2.threshold(gray, 170, 255, cv2.THRESH_BINARY)
    return thresh

def preprocess_upscale_gray(crop):
    """Upscale 3x + grayscale"""
    upscaled = cv2.resize(crop, None, fx=3, fy=3, interpolation=cv2.INTER_CUBIC)
    return cv2.cvtColor(upscaled, cv2.COLOR_BGR2GRAY)

PREPROCESSORS = {
    "raw": preprocess_raw,
    "gray": preprocess_gray,
    "threshold": preprocess_threshold,
    "otsu": preprocess_otsu,
    "white_text": preprocess_white_text,
    "invert_white": preprocess_invert_white,
    "contrast": preprocess_contrast_boost,
    "upscale_white": preprocess_upscale_white,
    "upscale_gray": preprocess_upscale_gray,
}

# ── Main Test ───────────────────────────────────────────────────────────────

def main():
    import easyocr

    test_dir = Path("data/ocr-test")
    crop_dir = test_dir / "crops"
    crop_dir.mkdir(exist_ok=True)

    print("Loading EasyOCR (first run downloads models ~100MB)...")
    reader = easyocr.Reader(['en'], gpu=True)
    print("EasyOCR ready.\n")

    frames = sorted(test_dir.glob("*.jpg"))
    print(f"Found {len(frames)} test frames\n")

    # Key regions to focus OCR testing on
    test_regions = ["health_shield", "timer", "score_left", "score_right",
                    "ammo", "credits", "bottom_hud_full", "top_hud_full"]

    # Best preprocessors to test (not all combinations)
    test_preprocessors = ["raw", "gray", "white_text", "upscale_white",
                          "upscale_gray", "contrast", "invert_white"]

    results = []

    for frame_path in frames:
        img = cv2.imread(str(frame_path))
        if img is None:
            print(f"SKIP: Could not read {frame_path.name}")
            continue

        h, w = img.shape[:2]
        print(f"═══ {frame_path.name} ({w}x{h}) ═══")

        # Scale regions if not 1280x720
        scale_x = w / 1280
        scale_y = h / 720

        for region_name in test_regions:
            coords = REGIONS_720p[region_name]
            x1 = int(coords[0] * scale_x)
            y1 = int(coords[1] * scale_y)
            x2 = int(coords[2] * scale_x)
            y2 = int(coords[3] * scale_y)

            crop = img[y1:y2, x1:x2]
            if crop.size == 0:
                continue

            # Save raw crop
            crop_filename = f"{frame_path.stem}_{region_name}.jpg"
            cv2.imwrite(str(crop_dir / crop_filename), crop)

            print(f"\n  ┌─ Region: {region_name} ({x2-x1}x{y2-y1}px)")

            # Get ground truth if available
            gt = GROUND_TRUTH.get(frame_path.name, {}).get(region_name, "?")
            if gt != "?":
                print(f"  │  Expected: '{gt}'")

            for prep_name in test_preprocessors:
                preprocessor = PREPROCESSORS[prep_name]
                processed = preprocessor(crop)

                # Save processed crop
                proc_filename = f"{frame_path.stem}_{region_name}_{prep_name}.jpg"
                cv2.imwrite(str(crop_dir / proc_filename), processed)

                # Run EasyOCR
                try:
                    # For grayscale/binary images, easyocr expects 2D or 3D array
                    if len(processed.shape) == 2:
                        ocr_input = processed
                    else:
                        ocr_input = processed

                    ocr_results = reader.readtext(ocr_input,
                                                   detail=1,
                                                   paragraph=False,
                                                   allowlist='0123456789:/ |,.')

                    texts = [r[1] for r in ocr_results]
                    confs = [r[2] for r in ocr_results]
                    combined = " ".join(texts).strip()
                    avg_conf = sum(confs) / len(confs) if confs else 0

                    match = ""
                    if gt != "?" and combined:
                        # Simple match check - does the OCR output contain the expected digits?
                        gt_digits = ''.join(c for c in gt if c.isdigit())
                        ocr_digits = ''.join(c for c in combined if c.isdigit())
                        if gt_digits and gt_digits == ocr_digits:
                            match = " ✓ MATCH"
                        elif gt_digits and gt_digits in ocr_digits:
                            match = " ~ PARTIAL"
                        else:
                            match = " ✗ MISS"

                    print(f"  │  {prep_name:15s} → '{combined}' (conf={avg_conf:.2f}){match}")

                    results.append({
                        "frame": frame_path.name,
                        "region": region_name,
                        "preprocessor": prep_name,
                        "ocr_text": combined,
                        "confidence": avg_conf,
                        "expected": gt,
                        "match": match.strip(),
                    })

                except Exception as e:
                    print(f"  │  {prep_name:15s} → ERROR: {e}")

            print(f"  └─")

    # ── Summary ──────────────────────────────────────────────────────────────
    print("\n" + "=" * 70)
    print("SUMMARY")
    print("=" * 70)

    # Count matches per preprocessor
    prep_stats = {}
    for r in results:
        if r["expected"] != "?":
            prep = r["preprocessor"]
            if prep not in prep_stats:
                prep_stats[prep] = {"match": 0, "partial": 0, "miss": 0, "empty": 0, "total": 0}
            prep_stats[prep]["total"] += 1
            if "MATCH" in r["match"]:
                prep_stats[prep]["match"] += 1
            elif "PARTIAL" in r["match"]:
                prep_stats[prep]["partial"] += 1
            elif "MISS" in r["match"]:
                prep_stats[prep]["miss"] += 1
            else:
                prep_stats[prep]["empty"] += 1

    print("\nPreprocessor accuracy (on frames with ground truth):")
    for prep, stats in sorted(prep_stats.items(), key=lambda x: -x[1]["match"]):
        total = stats["total"]
        if total == 0:
            continue
        print(f"  {prep:20s}: {stats['match']}/{total} exact, "
              f"{stats['partial']}/{total} partial, "
              f"{stats['miss']}/{total} miss, "
              f"{stats['empty']}/{total} empty")

    # Count matches per region
    region_stats = {}
    for r in results:
        if r["expected"] != "?":
            region = r["region"]
            if region not in region_stats:
                region_stats[region] = {"best_match": False, "any_partial": False}
            if "MATCH" in r["match"]:
                region_stats[region]["best_match"] = True
            if "PARTIAL" in r["match"]:
                region_stats[region]["any_partial"] = True

    print(f"\nCrops saved to: {crop_dir.absolute()}")
    print(f"Total OCR tests run: {len(results)}")

if __name__ == "__main__":
    main()
