"""
Analyze a Valorant gameplay video — Full CV pipeline.

This is the end-to-end script that:
  1. Extracts frames at 1 fps
  2. Classifies each frame (game state)
  3. Runs detectors based on state (health, kills, death screen, etc.)
  4. Builds structured per-round timeline
  5. Outputs JSON ready for coaching LLM

Usage:
  python scripts/analyze_video.py path/to/video.mp4

This is a Python prototype. The production version runs in Node.js
with ONNX Runtime. This script validates the pipeline end-to-end.
"""

import sys
import os
import json
import csv
import subprocess
import tempfile
from pathlib import Path
from collections import defaultdict

import cv2
import numpy as np
import base64

# Optional: Gemini for death screen analysis
try:
    import google.generativeai as genai
    GEMINI_KEY = os.environ.get('GEMINI_API_KEY')
    if not GEMINI_KEY:
        raise ValueError("GEMINI_API_KEY environment variable is required")
    genai.configure(api_key=GEMINI_KEY)
    gemini_model = genai.GenerativeModel('gemini-2.5-flash')
    HAS_GEMINI = True
except Exception:
    HAS_GEMINI = False

# Optional: ONNX Runtime for model inference
try:
    import onnxruntime as ort
    HAS_ONNX = True
except ImportError:
    HAS_ONNX = False
    print("Warning: onnxruntime not installed, using heuristic classifiers")

# ── Config ──────────────────────────────────────────────────────────────────

MODEL_DIR = Path("src/services/coaching/models")
ASSETS_DIR = Path("data/assets")

GAME_STATE_CLASSES = ['gameplay', 'death_screen', 'spectating', 'buy_phase', 'round_end', 'loading']
HEALTH_CLASSES = ['0-25', '26-50', '51-75', '76-100', '101-150']
SHIELD_CLASSES = ['0', '25', '50']
CREDITS_CLASSES = ['0-1k', '1-2k', '2-3k', '3-4k', '4-5k', '5k+']

# HUD regions at 1280x720
REGIONS = {
    'health_shield': (310, 672, 510, 718),
    'credits': (1130, 688, 1280, 720),
    'ability_bar': (430, 675, 750, 720),
    'kill_banner': (850, 30, 1250, 90),
    'death_panel': (700, 50, 1270, 500),
    'minimap': (8, 30, 215, 240),
}

# ── ONNX Model Loading ─────────────────────────────────────────────────────

sessions = {}

def load_model(name, filename):
    """Load an ONNX model."""
    if not HAS_ONNX:
        return None
    model_path = MODEL_DIR / filename
    if not model_path.exists():
        return None
    if name not in sessions:
        sessions[name] = ort.InferenceSession(str(model_path), providers=['CPUExecutionProvider'])
    return sessions[name]


def run_classifier(session, image, image_size=224):
    """Run an ONNX classifier on an image."""
    if session is None:
        return None, 0.0

    # Preprocess: resize, BGR→RGB, normalize (ImageNet), NCHW format
    img = cv2.resize(image, (image_size, image_size))
    img = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
    img = img.astype(np.float32) / 255.0
    mean = np.array([0.485, 0.456, 0.406])
    std = np.array([0.229, 0.224, 0.225])
    img = (img - mean) / std
    img = img.transpose(2, 0, 1)  # HWC → CHW
    img = np.expand_dims(img, 0).astype(np.float32)  # Add batch dim

    outputs = session.run(None, {'input': img})
    scores = outputs[0][0]

    # Softmax
    exp_scores = np.exp(scores - np.max(scores))
    probs = exp_scores / exp_scores.sum()

    best_idx = np.argmax(probs)
    return int(best_idx), float(probs[best_idx])


# ── Heuristic Classifiers (fallback when ONNX unavailable) ──────────────────

def classify_state_heuristic(frame):
    """Simple heuristic game state classification."""
    hsv = cv2.cvtColor(frame, cv2.COLOR_BGR2HSV)
    h, s, v = cv2.split(hsv)

    avg_sat = np.mean(s)
    avg_val = np.mean(v)

    if avg_val < 30:
        return 'loading', 0.8
    if avg_sat < 25 and avg_val > 40:
        return 'death_screen', 0.7

    # Check center for buy menu blue
    ch, cw = frame.shape[0], frame.shape[1]
    center = frame[int(ch*0.3):int(ch*0.7), int(cw*0.3):int(cw*0.7)]
    center_hsv = cv2.cvtColor(center, cv2.COLOR_BGR2HSV)
    blue_mask = cv2.inRange(center_hsv, (90, 50, 50), (130, 255, 255))
    if np.sum(blue_mask > 0) / blue_mask.size > 0.15:
        return 'buy_phase', 0.7

    return 'gameplay', 0.6


# ── Kill Banner Detection ───────────────────────────────────────────────────

def analyze_death_screen(frame):
    """Send death screen frame to Gemini to extract kill info."""
    if not HAS_GEMINI:
        return None

    # Encode frame as JPEG
    _, buf = cv2.imencode('.jpg', frame, [cv2.IMWRITE_JPEG_QUALITY, 80])
    b64 = base64.b64encode(buf).decode('utf-8')

    try:
        response = gemini_model.generate_content(
            [
                "This is a Valorant death screen. Extract the following info. "
                "Reply ONLY in this exact JSON format, no other text:\n"
                '{"enemy_agent": "agent name or null", "weapon": "weapon name or null", '
                '"damage_dealt": number or null, "damage_received": number or null}\n'
                "If this is not a death screen or info is not visible, return all nulls.",
                {"inline_data": {"mime_type": "image/jpeg", "data": b64}},
            ],
            generation_config=genai.GenerationConfig(
                response_mime_type="application/json",
                temperature=0.1,
            ),
        )
        import json as _json
        result = _json.loads(response.text.strip())
        return result
    except Exception as e:
        print(f"    Gemini death analysis failed: {e}")
        return None


def detect_kill_banner(frame, sx, sy):
    """Detect yellow kill banner in killfeed area."""
    x1, y1, x2, y2 = REGIONS['kill_banner']
    roi = frame[int(y1*sy):int(y2*sy), int(x1*sx):int(x2*sx)]
    if roi.size == 0:
        return False

    # Yellow: high R, high G, low B
    r, g, b = roi[:,:,2], roi[:,:,1], roi[:,:,0]
    yellow = (r > 180) & (g > 150) & (b < 100)
    ratio = np.sum(yellow) / max(yellow.size, 1)
    return ratio > 0.008  # calibrated on real gameplay


# ── Ability Brightness Check ────────────────────────────────────────────────

def check_abilities(frame, sx, sy):
    """Check ability icon brightness."""
    ability_regions = {
        'C': (468, 684, 508, 714),
        'Q': (530, 684, 570, 714),
        'E': (592, 684, 632, 714),
        'X': (654, 684, 694, 714),
    }

    statuses = {}
    for slot, (x1, y1, x2, y2) in ability_regions.items():
        roi = frame[int(y1*sy):int(y2*sy), int(x1*sx):int(x2*sx)]
        if roi.size == 0:
            statuses[slot] = 'unknown'
            continue
        avg_brightness = np.mean(cv2.cvtColor(roi, cv2.COLOR_BGR2GRAY))
        statuses[slot] = 'available' if avg_brightness > 110 else 'used'

    return statuses


# ── Main Pipeline ───────────────────────────────────────────────────────────

def analyze_video(video_path):
    """Full analysis pipeline."""
    video_path = Path(video_path)
    if not video_path.exists():
        print(f"Video not found: {video_path}")
        return None

    # Get video info
    result = subprocess.run(
        ['ffprobe', '-v', 'error', '-select_streams', 'v:0',
         '-show_entries', 'stream=width,height', '-show_entries', 'format=duration',
         '-of', 'json', str(video_path)],
        capture_output=True, text=True
    )
    info = json.loads(result.stdout)
    width = info['streams'][0]['width']
    height = info['streams'][0]['height']
    duration = float(info['format']['duration'])
    sx, sy = width / 1280, height / 720

    print(f"Video: {video_path.name}")
    print(f"Resolution: {width}x{height}, Duration: {duration:.0f}s")

    # Load ONNX models
    state_model = load_model('state', 'valorant-classifier.onnx')
    health_model = load_model('health', 'health-reader.onnx')
    shield_model = load_model('shield', 'shield-reader.onnx')
    credits_model = load_model('credits', 'credits-reader.onnx')

    # Extract and process frames
    print("Extracting frames at 1 fps...")

    # State machine
    current_state = 'loading'
    round_number = 0
    round_start = 0
    rounds = []
    current_round = None
    kill_count = 0
    last_health = '76-100'
    last_shield = '50'
    last_abilities = {}

    cap = cv2.VideoCapture(str(video_path))
    fps = cap.get(cv2.CAP_PROP_FPS)
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))

    # Process at 1 fps
    frame_interval = int(fps)  # skip this many frames between reads
    timestamp = 0
    frames_processed = 0

    while cap.isOpened():
        # Seek to next timestamp
        frame_pos = int(timestamp * fps)
        if frame_pos >= total_frames:
            break

        cap.set(cv2.CAP_PROP_POS_FRAMES, frame_pos)
        ret, frame = cap.read()
        if not ret:
            break

        # Classify game state
        if state_model:
            idx, conf = run_classifier(state_model, frame, 224)
            state = GAME_STATE_CLASSES[idx] if idx < len(GAME_STATE_CLASSES) else 'unknown'
        else:
            state, conf = classify_state_heuristic(frame)

        # State transitions
        if state != current_state:
            prev = current_state

            # buy_phase/loading → gameplay = round started
            if state == 'gameplay' and prev in ('buy_phase', 'loading'):
                round_start = timestamp
                kill_count = 0

            # → round_end = round finished
            if state == 'round_end' and current_round:
                current_round['end_sec'] = timestamp
                current_round['duration'] = timestamp - current_round['start_sec']
                rounds.append(current_round)
                current_round = None

            # round_end/loading → buy_phase = new round
            if state == 'buy_phase' and prev in ('round_end', 'loading'):
                round_number += 1
                current_round = {
                    'round': round_number,
                    'start_sec': timestamp,
                    'end_sec': 0,
                    'duration': 0,
                    'economy': None,
                    'health_timeline': [],
                    'kills': [],
                    'death': None,
                    'abilities_at_death': None,
                    'survived': True,
                }

            current_state = state

        # Process based on state
        if state == 'gameplay' and current_round:
            # Health/Shield
            if health_model:
                crop = frame[int(672*sy):int(718*sy), int(310*sx):int(510*sx)]
                if crop.size > 0:
                    idx, conf = run_classifier(health_model, crop, 128)
                    health = HEALTH_CLASSES[idx] if idx < len(HEALTH_CLASSES) else last_health
                    if health != last_health:
                        current_round['health_timeline'].append({
                            'sec': round(timestamp - round_start, 1),
                            'health': health,
                        })
                        last_health = health

            # Kill detection
            if detect_kill_banner(frame, sx, sy):
                kill_count += 1
                current_round['kills'].append({
                    'sec': round(timestamp - round_start, 1),
                    'count': kill_count,
                })

            # Ability tracking
            abilities = check_abilities(frame, sx, sy)
            last_abilities = abilities

        elif state == 'buy_phase' and current_round:
            # Credits
            if credits_model:
                crop = frame[int(688*sy):int(720*sy), int(1130*sx):int(1280*sx)]
                if crop.size > 0:
                    idx, conf = run_classifier(credits_model, crop, 128)
                    current_round['economy'] = CREDITS_CLASSES[idx] if idx < len(CREDITS_CLASSES) else None

        elif state == 'death_screen' and current_round and not current_round['death']:
            death_info = {
                'sec': round(timestamp - round_start, 1),
                'abilities_unused': [k for k, v in last_abilities.items() if v == 'available'],
                'enemy_agent': None,
                'weapon': None,
                'damage_dealt': None,
                'damage_received': None,
            }

            # Analyze death screen with Gemini (once per death)
            gemini_result = analyze_death_screen(frame)
            if gemini_result:
                death_info['enemy_agent'] = gemini_result.get('enemy_agent')
                death_info['weapon'] = gemini_result.get('weapon')
                death_info['damage_dealt'] = gemini_result.get('damage_dealt')
                death_info['damage_received'] = gemini_result.get('damage_received')
                print(f"    Death: killed by {death_info['enemy_agent']} with {death_info['weapon']}, "
                      f"dealt {death_info['damage_dealt']} / received {death_info['damage_received']}")

            current_round['death'] = death_info
            current_round['survived'] = False

        timestamp += 1
        frames_processed += 1

        if frames_processed % 60 == 0:
            print(f"  {frames_processed} frames ({timestamp:.0f}s / {duration:.0f}s) - state: {state}")

    cap.release()

    # Finalize last round
    if current_round:
        current_round['end_sec'] = timestamp
        current_round['duration'] = timestamp - current_round['start_sec']
        rounds.append(current_round)

    # Build timeline
    total_deaths = sum(1 for r in rounds if r['death'])
    deaths_unused_abilities = sum(1 for r in rounds if r['death'] and r['death']['abilities_unused'])

    timeline = {
        'video': video_path.name,
        'resolution': f'{width}x{height}',
        'duration_sec': int(duration),
        'total_rounds': len(rounds),
        'rounds_survived': sum(1 for r in rounds if r['survived']),
        'total_deaths': total_deaths,
        'deaths_with_unused_abilities': deaths_unused_abilities,
        'rounds': rounds,
    }

    print(f"\n{'='*50}")
    print(f"ANALYSIS COMPLETE")
    print(f"{'='*50}")
    print(f"Frames processed: {frames_processed}")
    print(f"Rounds detected: {len(rounds)}")
    print(f"Deaths: {total_deaths}")
    print(f"Deaths with unused abilities: {deaths_unused_abilities}")
    print(f"Kills detected: {sum(len(r['kills']) for r in rounds)}")

    # Save timeline
    out_path = video_path.with_suffix('.timeline.json')
    with open(out_path, 'w') as f:
        json.dump(timeline, f, indent=2)
    print(f"\nTimeline saved: {out_path}")

    return timeline


if __name__ == '__main__':
    if len(sys.argv) < 2:
        print("Usage: python scripts/analyze_video.py path/to/video.mp4")
        sys.exit(1)

    analyze_video(sys.argv[1])
