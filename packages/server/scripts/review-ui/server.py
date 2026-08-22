"""
Frame Review UI — Local web server for classifying training frames.

Browse frames, click a class label to classify, skip uncertain ones.
Saves corrections to labels_reviewed.csv.

Usage:
  cd packages/server
  python scripts/review-ui/server.py

Then open http://localhost:3333
"""

import os
import json
import csv
from pathlib import Path
from http.server import HTTPServer, SimpleHTTPRequestHandler
from urllib.parse import parse_qs, urlparse, unquote

DATA_DIR = Path(__file__).parent.parent.parent / "data"
# Use review-deaths for dense frames (720p), fall back to review for old frames
REVIEW_DIR = DATA_DIR / "review-deaths"
if not REVIEW_DIR.exists():
    REVIEW_DIR = DATA_DIR / "review"
LABELS_REVIEWED = DATA_DIR / "labels_reviewed.csv"
FRAMES_DIR = DATA_DIR / "frames"

CLASSES = ["gameplay", "death_screen", "spectating", "buy_phase", "round_end", "loading"]

# Build frame list from review folder
def get_review_frames():
    frames = []
    # Only scan actual class folders, not video-id folders
    valid_classes = set(CLASSES + ["uncertain"])
    for cls_dir in sorted(REVIEW_DIR.iterdir()):
        if not cls_dir.is_dir():
            continue
        predicted_class = cls_dir.name
        if predicted_class not in valid_classes:
            continue  # skip video-id folders like "cypher-aGs9eOH7Cjs"
        for img in sorted(cls_dir.glob("*.jpg")):
            # Parse filename: {video_id}_frame{N}_conf{X.XX}.jpg
            name = img.stem
            parts = name.rsplit("_conf", 1)
            confidence = float(parts[1]) if len(parts) == 2 else 0.5
            frames.append({
                "path": str(img.resolve()),
                "filename": img.name,
                "predicted": predicted_class,
                "confidence": confidence,
                "rel_path": f"/review-img/{predicted_class}/{img.name}",
            })
    # Sort: death_screen first, then by confidence (lowest first = most uncertain)
    priority = {"death_screen": 0, "spectating": 1, "uncertain": 2, "round_end": 3, "buy_phase": 4, "gameplay": 5, "loading": 6}
    frames.sort(key=lambda f: (priority.get(f["predicted"], 9), f["confidence"]))
    return frames

def load_reviewed():
    """Load already-reviewed labels."""
    reviewed = {}
    if LABELS_REVIEWED.exists():
        with open(LABELS_REVIEWED, "r") as f:
            reader = csv.DictReader(f)
            for row in reader:
                # Support both old format (corrected_label) and new format (label)
                label = row.get("corrected_label") or row.get("label", "")
                if label:
                    reviewed[row["frame_path"]] = label
    return reviewed

def save_label(frame_path, label, video_id):
    """Append a reviewed label."""
    exists = LABELS_REVIEWED.exists()
    with open(LABELS_REVIEWED, "a", newline="") as f:
        writer = csv.writer(f)
        if not exists:
            writer.writerow(["frame_path", "corrected_label"])
        writer.writerow([frame_path, label])

class ReviewHandler(SimpleHTTPRequestHandler):
    frames = []
    reviewed = set()
    stats = {"total": 0, "reviewed": 0, "by_class": {}}

    def do_GET(self):
        parsed = urlparse(self.path)

        if parsed.path == "/":
            self.send_html()
        elif parsed.path == "/api/frames":
            self.send_frames()
        elif parsed.path == "/api/stats":
            self.send_stats()
        elif parsed.path.startswith("/review-img/"):
            self.send_image(parsed.path)
        else:
            self.send_error(404)

    def do_POST(self):
        parsed = urlparse(self.path)

        if parsed.path == "/api/label":
            content_len = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(content_len))

            frame_path = body["frame_path"]
            label = body["label"]
            filename = body.get("filename", "")

            # Extract video_id from filename
            parts = filename.split("_frame")
            video_id = parts[0] if parts else "unknown"

            # Find the original frame path in the frames directory
            # The review file is a copy; we need the original path for training
            frame_num = ""
            if "_frame" in filename:
                frame_part = filename.split("_frame")[1].split("_conf")[0]
                frame_num = int(frame_part)

            original_path = str(FRAMES_DIR / video_id / f"frame_{frame_num:05d}.jpg")

            save_label(original_path, label, video_id)
            self.reviewed.add(frame_path)
            self.stats["reviewed"] += 1
            self.stats["by_class"][label] = self.stats["by_class"].get(label, 0) + 1

            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"ok": True, "stats": self.stats}).encode())
        else:
            self.send_error(404)

    def send_frames(self):
        # Only send unreviewed frames
        unreviewed = [f for f in self.frames if f["path"] not in self.reviewed]
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(unreviewed[:500]).encode())  # batch of 500

    def send_stats(self):
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(self.stats).encode())

    def send_image(self, path):
        # /review-img/{class}/{filename}
        parts = path.split("/review-img/", 1)
        if len(parts) != 2:
            self.send_error(404)
            return
        rel = unquote(parts[1])
        img_path = REVIEW_DIR / rel
        if not img_path.exists():
            self.send_error(404)
            return
        self.send_response(200)
        self.send_header("Content-Type", "image/jpeg")
        self.end_headers()
        with open(img_path, "rb") as f:
            self.wfile.write(f.read())

    def send_html(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/html")
        self.end_headers()
        self.wfile.write(HTML.encode())

    def log_message(self, format, *args):
        # Suppress request logs
        pass

HTML = """<!DOCTYPE html>
<html>
<head>
<title>Scrima Frame Review</title>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: -apple-system, sans-serif; background: #111; color: #eee; }

.header {
  position: fixed; top: 0; left: 0; right: 0; z-index: 100;
  background: #222; padding: 12px 24px; display: flex; align-items: center; gap: 20px;
  border-bottom: 1px solid #333;
}
.header h1 { font-size: 18px; }
.stats { font-size: 14px; color: #888; }
.stats b { color: #4f8; }
.filter-bar { display: flex; gap: 8px; margin-left: auto; }
.filter-btn {
  padding: 4px 12px; border: 1px solid #444; background: #333; color: #ccc;
  border-radius: 4px; cursor: pointer; font-size: 13px;
}
.filter-btn.active { background: #4f8; color: #111; border-color: #4f8; }

.container { padding-top: 70px; display: flex; flex-direction: column; align-items: center; }

.frame-view {
  display: flex; flex-direction: column; align-items: center; padding: 20px;
  max-width: 900px; width: 100%;
}

.frame-img {
  width: 448px; height: 448px; object-fit: contain;
  border: 2px solid #333; border-radius: 8px; background: #000;
  image-rendering: pixelated;
}

.frame-info {
  margin: 12px 0; text-align: center; font-size: 14px; color: #888;
}
.frame-info .predicted {
  display: inline-block; padding: 2px 10px; border-radius: 4px;
  font-weight: bold; margin: 0 4px;
}
.predicted.death_screen { background: #f44; color: #fff; }
.predicted.spectating { background: #f80; color: #fff; }
.predicted.gameplay { background: #4a4; color: #fff; }
.predicted.buy_phase { background: #48f; color: #fff; }
.predicted.round_end { background: #a4a; color: #fff; }
.predicted.loading { background: #666; color: #fff; }
.predicted.uncertain { background: #aa0; color: #111; }

.buttons {
  display: flex; gap: 10px; margin: 16px 0; flex-wrap: wrap; justify-content: center;
}
.btn {
  padding: 10px 24px; border: 2px solid; border-radius: 8px;
  cursor: pointer; font-size: 16px; font-weight: bold;
  transition: transform 0.1s, box-shadow 0.1s;
}
.btn:hover { transform: scale(1.05); box-shadow: 0 0 12px rgba(255,255,255,0.2); }
.btn:active { transform: scale(0.95); }
.btn.death_screen { background: #f44; border-color: #f66; color: #fff; }
.btn.spectating { background: #f80; border-color: #fa0; color: #fff; }
.btn.gameplay { background: #4a4; border-color: #6c6; color: #fff; }
.btn.buy_phase { background: #48f; border-color: #6af; color: #fff; }
.btn.round_end { background: #a4a; border-color: #c6c; color: #fff; }
.btn.loading { background: #666; border-color: #888; color: #fff; }
.btn.skip { background: #333; border-color: #555; color: #888; }

.keyboard-hint { font-size: 12px; color: #555; margin-top: 8px; }
.progress-bar {
  width: 100%; height: 4px; background: #333; margin-top: 10px; border-radius: 2px;
}
.progress-fill { height: 100%; background: #4f8; border-radius: 2px; transition: width 0.3s; }

.counter { font-size: 14px; color: #666; margin: 8px 0; }
</style>
</head>
<body>

<div class="header">
  <h1>Frame Review</h1>
  <div class="stats">
    Reviewed: <b id="reviewed-count">0</b> / <span id="total-count">0</span>
    &nbsp;|&nbsp;
    <span id="class-stats"></span>
  </div>
  <div class="filter-bar">
    <button class="filter-btn active" data-filter="all">All</button>
    <button class="filter-btn" data-filter="death_screen">Death</button>
    <button class="filter-btn" data-filter="spectating">Spectating</button>
    <button class="filter-btn" data-filter="uncertain">Uncertain</button>
  </div>
</div>

<div class="container">
  <div class="frame-view">
    <img id="frame-img" class="frame-img" src="" alt="Frame">
    <div class="frame-info">
      <span id="frame-name">Loading...</span>
      &nbsp; Predicted: <span id="predicted" class="predicted">?</span>
      &nbsp; Confidence: <span id="confidence">?</span>
    </div>
    <div class="counter" id="counter">Frame 0 / 0</div>
    <div class="buttons">
      <button class="btn death_screen" onclick="label('death_screen')">Death Screen (1)</button>
      <button class="btn spectating" onclick="label('spectating')">Spectating (2)</button>
      <button class="btn gameplay" onclick="label('gameplay')">Gameplay (3)</button>
      <button class="btn buy_phase" onclick="label('buy_phase')">Buy Phase (4)</button>
      <button class="btn round_end" onclick="label('round_end')">Round End (5)</button>
      <button class="btn loading" onclick="label('loading')">Loading (6)</button>
      <button class="btn skip" onclick="skip()">Skip (S)</button>
    </div>
    <div class="keyboard-hint">Keyboard: 1-6 to classify, S to skip, Arrow keys to navigate</div>
    <div class="progress-bar"><div class="progress-fill" id="progress"></div></div>
  </div>
</div>

<script>
let frames = [];
let currentIdx = 0;
let filter = "all";
let stats = { reviewed: 0, total: 0, by_class: {} };

async function loadFrames() {
  const resp = await fetch("/api/frames");
  frames = await resp.json();
  stats.total = frames.length;
  document.getElementById("total-count").textContent = frames.length;
  showFrame();
}

function filteredFrames() {
  if (filter === "all") return frames;
  return frames.filter(f => f.predicted === filter);
}

function showFrame() {
  const filtered = filteredFrames();
  if (currentIdx >= filtered.length) {
    document.getElementById("frame-img").src = "";
    document.getElementById("frame-name").textContent = "All done!";
    document.getElementById("predicted").textContent = "-";
    document.getElementById("confidence").textContent = "-";
    return;
  }
  const f = filtered[currentIdx];
  document.getElementById("frame-img").src = f.rel_path;
  document.getElementById("frame-name").textContent = f.filename;

  const pred = document.getElementById("predicted");
  pred.textContent = f.predicted;
  pred.className = "predicted " + f.predicted;

  document.getElementById("confidence").textContent = (f.confidence * 100).toFixed(0) + "%";
  document.getElementById("counter").textContent =
    `Frame ${currentIdx + 1} / ${filtered.length}`;
  document.getElementById("progress").style.width =
    ((currentIdx / filtered.length) * 100) + "%";
}

async function label(cls) {
  const filtered = filteredFrames();
  if (currentIdx >= filtered.length) return;
  const f = filtered[currentIdx];

  await fetch("/api/label", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      frame_path: f.path,
      label: cls,
      filename: f.filename,
    })
  });

  stats.reviewed++;
  stats.by_class[cls] = (stats.by_class[cls] || 0) + 1;
  updateStats();

  // Remove from list and advance
  const globalIdx = frames.indexOf(f);
  if (globalIdx >= 0) frames.splice(globalIdx, 1);
  if (currentIdx >= filteredFrames().length) currentIdx = Math.max(0, filteredFrames().length - 1);
  showFrame();
}

function skip() {
  currentIdx++;
  if (currentIdx >= filteredFrames().length) currentIdx = filteredFrames().length - 1;
  showFrame();
}

function updateStats() {
  document.getElementById("reviewed-count").textContent = stats.reviewed;
  const parts = Object.entries(stats.by_class).map(([k,v]) => `${k}: ${v}`);
  document.getElementById("class-stats").textContent = parts.join(" | ");
}

// Keyboard shortcuts
document.addEventListener("keydown", (e) => {
  const keyMap = { "1": "death_screen", "2": "spectating", "3": "gameplay",
                   "4": "buy_phase", "5": "round_end", "6": "loading" };
  if (keyMap[e.key]) { label(keyMap[e.key]); e.preventDefault(); }
  if (e.key === "s" || e.key === "S") { skip(); e.preventDefault(); }
  if (e.key === "ArrowRight") { skip(); e.preventDefault(); }
  if (e.key === "ArrowLeft") { currentIdx = Math.max(0, currentIdx - 1); showFrame(); e.preventDefault(); }
});

// Filter buttons
document.querySelectorAll(".filter-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".filter-btn").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    filter = btn.dataset.filter;
    currentIdx = 0;
    showFrame();
  });
});

loadFrames();
</script>
</body>
</html>
"""

if __name__ == "__main__":
    # Load frames
    frames = get_review_frames()
    reviewed = load_reviewed()

    ReviewHandler.frames = frames
    ReviewHandler.reviewed = set(f["path"] for f in frames if f["path"] in reviewed)
    ReviewHandler.stats = {
        "total": len(frames),
        "reviewed": len(ReviewHandler.reviewed),
        "by_class": {},
    }

    print(f"Loaded {len(frames)} frames for review ({len(ReviewHandler.reviewed)} already reviewed)")
    print(f"  death_screen: {sum(1 for f in frames if f['predicted'] == 'death_screen')}")
    print(f"  spectating:   {sum(1 for f in frames if f['predicted'] == 'spectating')}")
    print(f"  uncertain:    {sum(1 for f in frames if f['predicted'] == 'uncertain')}")
    print(f"\nStarting review server at http://localhost:3333")

    server = HTTPServer(("localhost", 3333), ReviewHandler)
    server.serve_forever()
