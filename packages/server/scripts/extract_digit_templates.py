"""
Extract digit templates (0-9 and ':') from Valorant HUD for template matching.

Process:
1. Take a clean gameplay frame with known values
2. Crop the HUD region containing digits
3. Threshold to isolate white text
4. Segment individual characters via contour detection
5. Save as templates for matching

These templates work for: score, timer, ammo, credits reading.
Resolution: extracted at 720p, will be scaled for other resolutions.
"""

import cv2
import numpy as np
from pathlib import Path

TEMPLATE_DIR = Path("data/assets/digit-templates")
TEMPLATE_DIR.mkdir(parents=True, exist_ok=True)

# Reference frames with known values (manually verified)
# Format: (frame_path, region_name, (x1,y1,x2,y2), expected_string, upscale)
REFERENCE_CROPS = [
    # Timer "1:29" from cypher_gameplay_4 — good clean digits
    ("data/ocr-test/cypher_gameplay_4.jpg", "timer", (608, 38, 672, 60), "1:29", 4),
    # Score "8" left side
    ("data/ocr-test/cypher_gameplay_4.jpg", "score_left", (572, 40, 592, 58), "8", 4),
    # Score "1" right side
    ("data/ocr-test/cypher_gameplay_4.jpg", "score_right", (690, 40, 706, 58), "1", 4),
    # Health "100"
    ("data/ocr-test/cypher_gameplay_4.jpg", "health", (400, 685, 475, 710), "100", 4),
    # Ammo "25"
    ("data/ocr-test/cypher_gameplay_4.jpg", "ammo", (1148, 685, 1188, 710), "25", 4),
    # Credits "8,400" — the larger text at bottom-right
    ("data/ocr-test/cypher_gameplay_4.jpg", "credits", (1210, 700, 1275, 716), "8400", 4),
]


def extract_characters(img_crop, expected, upscale=4, threshold=170):
    """
    Segment individual characters from a cropped HUD region.
    Returns list of (char_image, expected_char) pairs.
    """
    # Upscale for better segmentation
    h, w = img_crop.shape[:2]
    img = cv2.resize(img_crop, (w * upscale, h * upscale), interpolation=cv2.INTER_CUBIC)

    # Convert to grayscale
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)

    # Threshold to isolate bright text
    _, binary = cv2.threshold(gray, threshold, 255, cv2.THRESH_BINARY)

    # Find contours
    contours, _ = cv2.findContours(binary, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

    # Filter and sort contours by x position (left to right)
    char_boxes = []
    min_h = img.shape[0] * 0.25

    for c in contours:
        x, y, w, h = cv2.boundingRect(c)
        if h < min_h:
            continue
        if w < 3:
            continue
        char_boxes.append((x, y, w, h))

    char_boxes.sort(key=lambda b: b[0])

    # Try to match with expected string
    expected_chars = list(expected)

    if len(char_boxes) != len(expected_chars):
        print(f"    Warning: found {len(char_boxes)} contours, expected {len(expected_chars)} chars")
        # Try adjusting threshold
        for alt_thresh in [150, 160, 180, 190, 200]:
            _, alt_bin = cv2.threshold(gray, alt_thresh, 255, cv2.THRESH_BINARY)
            alt_contours, _ = cv2.findContours(alt_bin, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
            alt_boxes = []
            for c in alt_contours:
                x, y, w, h = cv2.boundingRect(c)
                if h >= min_h and w >= 3:
                    alt_boxes.append((x, y, w, h))
            alt_boxes.sort(key=lambda b: b[0])
            if len(alt_boxes) == len(expected_chars):
                char_boxes = alt_boxes
                binary = alt_bin
                print(f"    Fixed with threshold={alt_thresh}")
                break

    results = []
    for i, (x, y, w, h) in enumerate(char_boxes):
        # Extract character with padding
        pad = 4
        x1 = max(0, x - pad)
        y1 = max(0, y - pad)
        x2 = min(binary.shape[1], x + w + pad)
        y2 = min(binary.shape[0], y + h + pad)

        char_img = binary[y1:y2, x1:x2]

        # Resize to standard 32x48 (taller than wide for digits)
        char_img = cv2.resize(char_img, (32, 48), interpolation=cv2.INTER_AREA)

        if i < len(expected_chars):
            results.append((char_img, expected_chars[i]))
        else:
            results.append((char_img, "?"))

    return results


def main():
    # Track which digits we've found
    digit_templates = {}  # char -> list of images

    for frame_path, region, (x1, y1, x2, y2), expected, upscale in REFERENCE_CROPS:
        img = cv2.imread(frame_path)
        if img is None:
            print(f"Could not read {frame_path}")
            continue

        crop = img[y1:y2, x1:x2]
        print(f"\nProcessing {region} from {Path(frame_path).name}: expected='{expected}'")

        chars = extract_characters(crop, expected, upscale=upscale)

        for char_img, char_label in chars:
            if char_label == "?":
                continue

            if char_label not in digit_templates:
                digit_templates[char_label] = []
            digit_templates[char_label].append(char_img)

            # Save template
            safe_label = char_label if char_label != ":" else "colon"
            idx = len(digit_templates[char_label])
            cv2.imwrite(str(TEMPLATE_DIR / f"{safe_label}_{idx}.png"), char_img)

    # Summary
    print(f"\n{'='*50}")
    print("DIGIT TEMPLATES EXTRACTED")
    print(f"{'='*50}")

    for char in sorted(digit_templates.keys()):
        count = len(digit_templates[char])
        print(f"  '{char}': {count} templates")

    # Create a combined reference image
    all_chars = sorted(digit_templates.keys())
    print(f"\nTotal unique characters: {len(all_chars)}")
    print(f"Templates saved to: {TEMPLATE_DIR}")

    # Also save a metadata file listing what we have
    import json
    meta = {char: len(imgs) for char, imgs in digit_templates.items()}
    with open(TEMPLATE_DIR / "templates.json", "w") as f:
        json.dump(meta, f, indent=2)

    # Check which digits are missing
    needed = set("0123456789:")
    found = set(digit_templates.keys())
    missing = needed - found
    if missing:
        print(f"\nMISSING digits: {missing}")
        print("Need more reference frames with these digits visible.")
    else:
        print("\nAll digits (0-9 and ':') found!")


if __name__ == "__main__":
    main()
