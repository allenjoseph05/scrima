"""
Simple frame review server. No bugs, just works.
http://localhost:3333
"""

import os
import json
import csv
from pathlib import Path
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import unquote

CLASSES = ["gameplay", "death_screen", "spectating", "buy_phase", "round_end", "loading"]
DATA_DIR = Path(__file__).parent.parent.parent / "data"
REVIEW_DIR = DATA_DIR / "review-deaths"
LABELS_OUT = DATA_DIR / "labels_reviewed.csv"
FRAMES_DIR = DATA_DIR / "frames"

# Build frame list once at startup
FRAMES = []
valid_dirs = set(CLASSES + ["uncertain"])
for cls_dir in sorted(REVIEW_DIR.iterdir()):
    if not cls_dir.is_dir() or cls_dir.name not in valid_dirs:
        continue
    for img in sorted(cls_dir.glob("*.jpg")):
        parts = img.stem.rsplit("_conf", 1)
        conf = float(parts[1]) if len(parts) == 2 else 0.5
        FRAMES.append({
            "file": img.name,
            "cls": cls_dir.name,
            "conf": conf,
            "url": f"/img/{cls_dir.name}/{img.name}",
        })

# death_screen first, then uncertain, then rest
order = {"death_screen": 0, "uncertain": 1, "spectating": 2, "round_end": 3, "buy_phase": 4, "gameplay": 5, "loading": 6}
FRAMES.sort(key=lambda f: (order.get(f["cls"], 9), f["conf"]))
print(f"Loaded {len(FRAMES)} frames for review")

# Track what's been labeled this session
labeled_count = 0
label_stats = {}

HTML = """<!DOCTYPE html>
<html><head><title>Frame Review</title>
<style>
body { background:#111; color:#eee; font-family:sans-serif; margin:0; }
.top { background:#222; padding:10px 20px; position:fixed; top:0; left:0; right:0; z-index:10;
  display:flex; align-items:center; gap:15px; border-bottom:1px solid #333; }
.top h2 { margin:0; font-size:16px; }
#stats { color:#888; font-size:14px; }
#stats b { color:#4f8; }
.main { padding:70px 20px 20px; display:flex; flex-direction:column; align-items:center; }
img { width:640px; height:360px; object-fit:contain; background:#000; border:2px solid #333; border-radius:8px; }
.info { margin:10px 0; color:#888; font-size:14px; }
.pred { display:inline-block; padding:2px 8px; border-radius:4px; font-weight:bold; color:#fff; }
.pred.death_screen { background:#e33; }
.pred.spectating { background:#e80; }
.pred.gameplay { background:#4a4; }
.pred.buy_phase { background:#48f; }
.pred.round_end { background:#a4a; }
.pred.loading { background:#666; }
.pred.uncertain { background:#aa0; color:#111; }
.btns { display:flex; gap:8px; margin:12px 0; flex-wrap:wrap; justify-content:center; }
.btn { padding:10px 20px; border:2px solid; border-radius:8px; cursor:pointer; font-size:15px;
  font-weight:bold; transition:transform 0.1s; }
.btn:hover { transform:scale(1.05); }
.btn:active { transform:scale(0.95); }
.b1 { background:#e33; border-color:#f55; color:#fff; }
.b2 { background:#e80; border-color:#fa0; color:#fff; }
.b3 { background:#4a4; border-color:#6c6; color:#fff; }
.b4 { background:#48f; border-color:#6af; color:#fff; }
.b5 { background:#a4a; border-color:#c6c; color:#fff; }
.b6 { background:#666; border-color:#888; color:#fff; }
.bs { background:#333; border-color:#555; color:#888; }
.hint { font-size:12px; color:#555; }
.bar { width:100%; max-width:640px; height:4px; background:#333; border-radius:2px; margin-top:8px; }
.fill { height:100%; background:#4f8; border-radius:2px; transition:width 0.3s; }
</style></head><body>
<div class="top">
  <h2>Frame Review</h2>
  <div id="stats">Labeled: <b id="cnt">0</b> / TOTAL_COUNT</div>
</div>
<div class="main">
  <img id="img" src="">
  <div class="info">
    <span id="fname">Loading...</span> |
    Predicted: <span id="pred" class="pred">?</span> |
    Conf: <span id="conf">?</span> |
    <span id="pos">0/0</span>
  </div>
  <div class="btns">
    <button class="btn b1" onclick="go('death_screen')">Death Screen (1)</button>
    <button class="btn b2" onclick="go('spectating')">Spectating (2)</button>
    <button class="btn b3" onclick="go('gameplay')">Gameplay (3)</button>
    <button class="btn b4" onclick="go('buy_phase')">Buy Phase (4)</button>
    <button class="btn b5" onclick="go('round_end')">Round End (5)</button>
    <button class="btn b6" onclick="go('loading')">Loading (6)</button>
    <button class="btn bs" onclick="skip()">Skip (S)</button>
  </div>
  <div class="hint">Keys: 1-6 = classify, S = skip, ← → = navigate</div>
  <div class="bar"><div class="fill" id="bar"></div></div>
</div>
<script>
const frames = FRAMES_JSON;
let i = 0;
let done = 0;

function show() {
  if (i >= frames.length) { document.getElementById("fname").textContent = "All done!"; return; }
  const f = frames[i];
  document.getElementById("img").src = f.url;
  document.getElementById("fname").textContent = f.file;
  const p = document.getElementById("pred");
  p.textContent = f.cls;
  p.className = "pred " + f.cls;
  document.getElementById("conf").textContent = (f.conf*100).toFixed(0)+"%";
  document.getElementById("pos").textContent = (i+1)+"/"+frames.length;
  document.getElementById("bar").style.width = ((i/frames.length)*100)+"%";
}

async function go(label) {
  if (i >= frames.length) return;
  const f = frames[i];
  await fetch("/label", {
    method:"POST",
    headers:{"Content-Type":"application/json"},
    body: JSON.stringify({file:f.file, cls:f.cls, label:label})
  });
  done++;
  document.getElementById("cnt").textContent = done;
  i++;
  show();
}

function skip() { i++; show(); }

document.addEventListener("keydown", e => {
  const m = {"1":"death_screen","2":"spectating","3":"gameplay","4":"buy_phase","5":"round_end","6":"loading"};
  if (m[e.key]) { go(m[e.key]); e.preventDefault(); }
  if (e.key==="s"||e.key==="S") { skip(); e.preventDefault(); }
  if (e.key==="ArrowRight") { skip(); e.preventDefault(); }
  if (e.key==="ArrowLeft") { i=Math.max(0,i-1); show(); e.preventDefault(); }
});

show();
</script></body></html>"""


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/":
            html = HTML.replace("FRAMES_JSON", json.dumps(FRAMES)).replace("TOTAL_COUNT", str(len(FRAMES)))
            self.send_response(200)
            self.send_header("Content-Type", "text/html")
            self.end_headers()
            self.wfile.write(html.encode())
        elif self.path.startswith("/img/"):
            rel = unquote(self.path[5:])
            fpath = REVIEW_DIR / rel
            if fpath.exists():
                self.send_response(200)
                self.send_header("Content-Type", "image/jpeg")
                self.end_headers()
                with open(fpath, "rb") as f:
                    self.wfile.write(f.read())
            else:
                self.send_error(404)
        else:
            self.send_error(404)

    def do_POST(self):
        if self.path == "/label":
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            filename = body["file"]
            original_cls = body["cls"]
            label = body["label"]

            # Find original frame path for training
            # filename format: {video_id}_{frame_stem}_confX.XX.jpg
            parts = filename.split("_death_dense_")
            if len(parts) == 2:
                video_id = parts[0]
                rest = parts[1]
                conf_idx = rest.rfind("_conf")
                frame_stem = "death_dense_" + rest[:conf_idx]
                original_path = str(FRAMES_DIR / video_id / f"{frame_stem}.jpg")
            else:
                # fallback: use review path
                original_path = str(REVIEW_DIR / original_cls / filename)

            # Append to labels_reviewed.csv
            exists = LABELS_OUT.exists()
            with open(LABELS_OUT, "a", newline="") as f:
                w = csv.writer(f)
                if not exists:
                    w.writerow(["frame_path", "corrected_label"])
                w.writerow([original_path, label])

            global labeled_count, label_stats
            labeled_count += 1
            label_stats[label] = label_stats.get(label, 0) + 1

            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b'{"ok":true}')
        else:
            self.send_error(404)

    def log_message(self, *args):
        pass  # silent


if __name__ == "__main__":
    print(f"Starting review server at http://localhost:3333")
    print(f"  death_screen: {sum(1 for f in FRAMES if f['cls']=='death_screen')}")
    print(f"  spectating: {sum(1 for f in FRAMES if f['cls']=='spectating')}")
    print(f"  other: {sum(1 for f in FRAMES if f['cls'] not in ('death_screen','spectating'))}")
    HTTPServer(("localhost", 3333), Handler).serve_forever()
