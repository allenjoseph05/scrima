"""
Valorant Video Analyzer v2 — Validated Pipeline

What's validated and working:
  - Game state classifier: detects rounds, deaths, buy phases
  - Credits reader (74%): reads economy bins during buy phase
  - State debouncing: conf > 0.9 accept immediately, else require 2 consecutive
  - Death screen has combat report on FIRST frame (validated visually)
  - Pre-death frame (~1-2s before) shows health/position context
  - Spectating frames after death still show combat report

What Gemini handles (per death, ~$0.002):
  - Pre-death frame: health, shield, position, what player was doing
  - Death screen frame: enemy agent, weapon, damage dealt/received, abilities used

What user provides: agent name, map name

Pipeline:
  1. Extract frames at 1fps
  2. Classify game state (ONNX) with debouncing
  3. Track rounds from state transitions
  4. During buy_phase: run credits reader
  5. On death: send pre-death + death frame to Gemini
  6. Build structured timeline
  7. Send timeline to Gemini for coaching

Usage:
  python scripts/analyze_video_v2.py path/to/video.mp4 --agent Cypher --map Abyss
"""

import sys
import os
import json
import subprocess
import argparse
import base64
import time
from pathlib import Path

import cv2
import numpy as np
import onnxruntime as ort

# ── Config ──────────────────────────────────────────────────────────────────

MODEL_DIR = Path("src/services/coaching/models")
CLASSES = ['gameplay', 'death_screen', 'spectating', 'buy_phase', 'round_end', 'loading']
CREDITS_CLASSES = ['0-1k', '1-2k', '2-3k', '3-4k', '4-5k', '5k+']

# Gemini
GEMINI_KEY = os.environ.get('GEMINI_API_KEY')
if not GEMINI_KEY:
    raise ValueError("GEMINI_API_KEY environment variable is required")

# Debouncing
HIGH_CONF_THRESHOLD = 0.9
MIN_CONSECUTIVE = 2
MIN_ROUND_DURATION = 10  # seconds

# Credits crop at 1280x720
CREDITS_REGION = (1130, 688, 1280, 720)

# ── Model Loading ───────────────────────────────────────────────────────────

def load_onnx(name):
    path = MODEL_DIR / name
    if not path.exists():
        print(f"  Warning: {name} not found")
        return None
    return ort.InferenceSession(str(path), providers=['CPUExecutionProvider'])


def run_model(session, frame, size=224):
    img = cv2.cvtColor(cv2.resize(frame, (size, size)), cv2.COLOR_BGR2RGB).astype(np.float32) / 255.0
    img = ((img - [0.485, 0.456, 0.406]) / [0.229, 0.224, 0.225]).transpose(2, 0, 1)
    scores = session.run(None, {'input': np.expand_dims(img, 0).astype(np.float32)})[0][0]
    exp_s = np.exp(scores - np.max(scores))
    probs = exp_s / exp_s.sum()
    return int(np.argmax(probs)), float(probs[np.argmax(probs)])


# ── Gemini ──────────────────────────────────────────────────────────────────

def init_gemini():
    try:
        import google.generativeai as genai
        genai.configure(api_key=GEMINI_KEY)
        return genai.GenerativeModel('gemini-2.5-flash'), genai
    except Exception as e:
        print(f"  Warning: Gemini init failed: {e}")
        return None, None


def frame_to_b64(frame):
    _, buf = cv2.imencode('.jpg', frame, [cv2.IMWRITE_JPEG_QUALITY, 85])
    return base64.b64encode(buf).decode('utf-8')


def analyze_death_with_gemini(model, genai, pre_death_frame, death_frame, round_num, agent, map_name):
    """Send pre-death + death screen frames to Gemini for analysis."""
    if model is None:
        return None

    pre_b64 = frame_to_b64(pre_death_frame)
    death_b64 = frame_to_b64(death_frame)

    prompt = f"""You are analyzing a Valorant death. The player was playing {agent} on {map_name}, Round {round_num}.

Image 1: The frame 2 seconds BEFORE the player died. Look at their health, shield, position, crosshair placement, and what they were doing.

Image 2: The death screen showing the combat report. Read: who killed them (enemy agent name), what weapon was used, damage dealt (OUTGOING), damage received (INCOMING), and any ability usage.

Reply in this exact JSON format only:
{{
  "pre_death": {{
    "health": <number or null>,
    "shield": <number or null>,
    "position_description": "<brief description of where player was and what they were doing>",
    "crosshair_note": "<any note about crosshair placement or null>"
  }},
  "death_info": {{
    "killed_by_agent": "<agent name or null>",
    "killed_by_weapon": "<weapon name or null>",
    "damage_dealt": <number or null>,
    "damage_received": <number or null>,
    "kills_before_death": <number of kills player got this round or null>
  }},
  "coaching_observation": "<one specific thing the player did wrong or could improve>"
}}"""

    try:
        response = model.generate_content(
            [
                prompt,
                {"inline_data": {"mime_type": "image/jpeg", "data": pre_b64}},
                {"inline_data": {"mime_type": "image/jpeg", "data": death_b64}},
            ],
            generation_config=genai.GenerationConfig(
                response_mime_type="application/json",
                temperature=0.2,
            ),
        )
        return json.loads(response.text.strip())
    except Exception as e:
        print(f"    Gemini error: {e}")
        return None


def generate_coaching(model, genai, timeline, agent, map_name):
    """Send structured timeline to Gemini for overall coaching."""
    if model is None:
        return "Gemini not available"

    prompt = f"""You are an expert Valorant coach. Analyze this game and give specific, actionable coaching.

PLAYER: {agent} on {map_name}
GAME DATA:
{json.dumps(timeline['rounds'], indent=2)}

SUMMARY:
- Rounds played: {timeline['total_rounds']}
- Deaths: {timeline['total_deaths']}
- Rounds survived: {timeline['rounds_survived']}

For each death, the "gemini_analysis" field contains what happened.

Give coaching in this format:
1. BIGGEST MISTAKE (the #1 recurring pattern)
2. TOP 3 SPECIFIC IMPROVEMENTS (with examples from the rounds)
3. ONE DRILL to practice

Be specific — reference exact rounds and situations. No generic advice."""

    try:
        response = model.generate_content(
            prompt,
            generation_config=genai.GenerationConfig(temperature=0.7),
        )
        return response.text
    except Exception as e:
        return f"Coaching generation failed: {e}"


# ── Main Pipeline ───────────────────────────────────────────────────────────

def analyze(video_path, agent, map_name):
    video_path = Path(video_path)
    print(f"Video: {video_path.name}")
    print(f"Agent: {agent}, Map: {map_name}")

    # Get video info
    cap = cv2.VideoCapture(str(video_path))
    fps = cap.get(cv2.CAP_PROP_FPS)
    if fps <= 0:
        fps = 30.0  # fallback
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    duration = total_frames / fps
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    sx, sy = width / 1280, height / 720

    print(f"Resolution: {width}x{height}, Duration: {duration:.0f}s, FPS: {fps:.0f}")

    # Load models
    print("Loading models...")
    state_model = load_onnx('valorant-classifier.onnx')
    credits_model = load_onnx('credits-reader.onnx')
    gemini, genai_lib = init_gemini()

    if state_model is None:
        print("ERROR: Game state classifier not found!")
        return None

    # ── Process frames ──────────────────────────────────────────────────

    # State debouncing
    confirmed_state = 'loading'
    pending_state = None
    pending_count = 0

    # Round tracking
    rounds = []
    current_round = None
    round_num = 0
    death_this_round = False

    # Frame buffer for pre-death context
    prev_frames = {}  # sec -> frame (keep last 5 seconds)

    total_secs = int(duration)
    print(f"Processing {total_secs} frames...")

    for sec in range(total_secs):
        cap.set(cv2.CAP_PROP_POS_FRAMES, int(sec * fps))
        ret, frame = cap.read()
        if not ret:
            break

        # Store frame for pre-death lookback
        prev_frames[sec] = frame.copy()
        # Only keep last 10 seconds
        for old_sec in list(prev_frames.keys()):
            if old_sec < sec - 10:
                del prev_frames[old_sec]

        # Classify
        idx, conf = run_model(state_model, frame)
        raw_state = CLASSES[idx]

        # ── Debouncing ──────────────────────────────────────────────
        accepted = False
        if raw_state != confirmed_state:
            if raw_state == pending_state:
                pending_count += 1
            else:
                pending_state = raw_state
                pending_count = 1

            if conf >= HIGH_CONF_THRESHOLD or pending_count >= MIN_CONSECUTIVE:
                old_state = confirmed_state
                confirmed_state = raw_state
                pending_state = None
                pending_count = 0
                accepted = True

                # ── State transitions ───────────────────────────────

                # New round: buy_phase after round_end or loading
                if confirmed_state == 'buy_phase' and old_state in ('round_end', 'loading'):
                    # Save previous round
                    if current_round and current_round['start_sec'] > 0:
                        current_round['end_sec'] = sec
                        current_round['duration'] = sec - current_round['start_sec']
                        if current_round['duration'] >= MIN_ROUND_DURATION:
                            rounds.append(current_round)

                    round_num += 1
                    current_round = {
                        'round': round_num,
                        'start_sec': sec,
                        'end_sec': 0,
                        'duration': 0,
                        'credits': None,
                        'death': None,
                        'survived': True,
                        'gemini_analysis': None,
                    }
                    death_this_round = False
                    print(f"  Round {round_num} starts at {sec}s")

                # Round end
                if confirmed_state == 'round_end' and current_round:
                    current_round['end_sec'] = sec
                    current_round['duration'] = sec - current_round['start_sec']
                    if current_round['duration'] >= MIN_ROUND_DURATION:
                        rounds.append(current_round)
                        print(f"  Round {current_round['round']} ends at {sec}s ({current_round['duration']}s)")
                    current_round = None

                # ── Death detection ─────────────────────────────────
                # Death = death_screen or (spectating right after death_screen)
                if confirmed_state in ('death_screen', 'spectating') and old_state in ('gameplay', 'death_screen'):
                    if current_round and not death_this_round:
                        death_this_round = True
                        death_sec = sec
                        current_round['survived'] = False

                        # Get pre-death frame (2 seconds before)
                        pre_death_sec = max(sec - 2, 0)
                        pre_death_frame = prev_frames.get(pre_death_sec, frame)

                        # The current frame might be death_screen (with combat report)
                        # or the next few frames during spectating also show it
                        death_frame = frame

                        print(f"  DEATH at {sec}s (round {round_num})")

                        # Analyze with Gemini
                        if gemini:
                            print(f"    Analyzing death with Gemini...")
                            analysis = analyze_death_with_gemini(
                                gemini, genai_lib,
                                pre_death_frame, death_frame,
                                round_num, agent, map_name
                            )
                            if analysis:
                                current_round['gemini_analysis'] = analysis
                                current_round['death'] = {
                                    'sec': sec,
                                    'round_sec': sec - current_round['start_sec'],
                                    **analysis.get('death_info', {}),
                                }
                                obs = analysis.get('coaching_observation', '')
                                print(f"    Killed by: {analysis.get('death_info', {}).get('killed_by_agent', '?')}")
                                print(f"    Observation: {obs[:80]}")
                            else:
                                current_round['death'] = {'sec': sec, 'round_sec': sec - current_round['start_sec']}
                        else:
                            current_round['death'] = {'sec': sec, 'round_sec': sec - current_round['start_sec']}
        else:
            pending_state = None
            pending_count = 0

        # ── Credits reading during buy phase ────────────────────────
        if confirmed_state == 'buy_phase' and current_round and credits_model:
            x1, y1, x2, y2 = CREDITS_REGION
            crop = frame[int(y1*sy):int(y2*sy), int(x1*sx):int(x2*sx)]
            if crop.size > 0:
                cidx, cconf = run_model(credits_model, crop, size=128)
                if cidx < len(CREDITS_CLASSES) and cconf > 0.4:
                    current_round['credits'] = CREDITS_CLASSES[cidx]

        # Progress
        if sec % 120 == 0 and sec > 0:
            print(f"  {sec}s / {total_secs}s processed")

    cap.release()

    # Finalize last round
    if current_round and current_round['start_sec'] > 0:
        current_round['end_sec'] = total_secs
        current_round['duration'] = total_secs - current_round['start_sec']
        if current_round['duration'] >= MIN_ROUND_DURATION:
            rounds.append(current_round)

    # ── Build timeline ──────────────────────────────────────────────────

    timeline = {
        'video': video_path.name,
        'agent': agent,
        'map': map_name,
        'resolution': f'{width}x{height}',
        'duration_sec': int(duration),
        'total_rounds': len(rounds),
        'total_deaths': sum(1 for r in rounds if r['death']),
        'rounds_survived': sum(1 for r in rounds if r['survived']),
        'rounds': rounds,
        'coaching': None,
    }

    # ── Generate coaching ───────────────────────────────────────────────

    print(f"\n{'='*50}")
    print(f"ANALYSIS COMPLETE")
    print(f"{'='*50}")
    print(f"Rounds: {timeline['total_rounds']}")
    print(f"Deaths: {timeline['total_deaths']}")
    print(f"Survived: {timeline['rounds_survived']}")

    if gemini and timeline['total_rounds'] > 0:
        print(f"\nGenerating coaching with Gemini...")
        coaching = generate_coaching(gemini, genai_lib, timeline, agent, map_name)
        timeline['coaching'] = coaching
        print(f"\n{coaching}")

    # Save
    out_path = video_path.with_suffix('.analysis.json')
    with open(out_path, 'w') as f:
        json.dump(timeline, f, indent=2)
    print(f"\nSaved: {out_path}")

    return timeline


# ── CLI ─────────────────────────────────────────────────────────────────────

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Analyze Valorant gameplay video')
    parser.add_argument('video', help='Path to video file')
    parser.add_argument('--agent', default='Unknown', help='Player agent name')
    parser.add_argument('--map', default='Unknown', help='Map name')
    args = parser.parse_args()

    analyze(args.video, args.agent, args.map)
