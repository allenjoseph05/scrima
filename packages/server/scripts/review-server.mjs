/**
 * Label Review Server
 *
 * Local HTTP server for reviewing and correcting auto-generated frame labels.
 * Opens a web UI showing frames with their labels. Click to correct.
 *
 * Usage: node scripts/review-server.mjs
 * Then open: http://localhost:3333
 */

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const DATA_DIR = path.resolve('data');
const LABELS_PATH = path.join(DATA_DIR, 'labels.csv');
const REVIEWED_PATH = path.join(DATA_DIR, 'labels_reviewed.csv');
const PORT = 3333;

// Load labels
function loadLabels() {
  const lines = fs.readFileSync(LABELS_PATH, 'utf8').trim().split('\n').slice(1);
  return lines.map((line, i) => {
    const [framePath, label, confidence, videoId] = line.split(',');
    return { id: i, framePath, label, confidence: Number.parseFloat(confidence) || 0.5, videoId };
  });
}

// Load reviewed labels (corrections)
function loadReviewed() {
  if (!fs.existsSync(REVIEWED_PATH)) return {};
  const lines = fs.readFileSync(REVIEWED_PATH, 'utf8').trim().split('\n').slice(1);
  const corrections = {};
  for (const line of lines) {
    const [framePath, label] = line.split(',');
    corrections[framePath] = label;
  }
  return corrections;
}

function saveCorrection(framePath, newLabel) {
  if (!fs.existsSync(REVIEWED_PATH)) {
    fs.writeFileSync(REVIEWED_PATH, 'frame_path,corrected_label\n');
  }
  // Append or update
  const existing = loadReviewed();
  existing[framePath] = newLabel;
  const lines = ['frame_path,corrected_label'];
  for (const [fp, lab] of Object.entries(existing)) {
    lines.push(`${fp},${lab}`);
  }
  fs.writeFileSync(REVIEWED_PATH, `${lines.join('\n')}\n`);
}

const HTML = `<!DOCTYPE html>
<html>
<head>
  <title>Scrima Label Review</title>
  <style>
    body { font-family: monospace; background: #1a1a2e; color: #eee; margin: 0; padding: 10px; }
    .controls { padding: 10px; background: #16213e; border-radius: 8px; margin-bottom: 10px; display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
    .controls button { padding: 6px 14px; border: none; border-radius: 4px; cursor: pointer; font-size: 13px; }
    .controls select, .controls input { padding: 5px; background: #0f3460; color: #eee; border: 1px solid #555; border-radius: 4px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, 240px); gap: 8px; }
    .card { background: #16213e; border-radius: 8px; overflow: hidden; cursor: pointer; border: 2px solid transparent; }
    .card.corrected { border-color: #f59e0b; }
    .card img { width: 240px; height: 240px; object-fit: cover; }
    .card .info { padding: 6px; font-size: 11px; }
    .card .label { font-weight: bold; font-size: 13px; }
    .label-gameplay { color: #4ade80; }
    .label-death_screen { color: #ef4444; }
    .label-spectating { color: #f97316; }
    .label-buy_phase { color: #3b82f6; }
    .label-round_end { color: #a855f7; }
    .label-loading { color: #6b7280; }
    .modal { display: none; position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.8); z-index: 100; justify-content: center; align-items: center; }
    .modal.active { display: flex; }
    .modal-content { background: #16213e; padding: 20px; border-radius: 12px; text-align: center; }
    .modal-content img { max-width: 600px; max-height: 400px; border-radius: 8px; }
    .modal-content .buttons { margin-top: 15px; display: flex; gap: 8px; justify-content: center; flex-wrap: wrap; }
    .modal-content button { padding: 10px 20px; border: none; border-radius: 6px; cursor: pointer; font-size: 14px; font-weight: bold; }
    .btn-gameplay { background: #4ade80; color: #000; }
    .btn-death_screen { background: #ef4444; color: #fff; }
    .btn-spectating { background: #f97316; color: #fff; }
    .btn-buy_phase { background: #3b82f6; color: #fff; }
    .btn-round_end { background: #a855f7; color: #fff; }
    .btn-loading { background: #6b7280; color: #fff; }
    .stats { font-size: 12px; color: #888; }
    #progress { font-size: 14px; color: #4ade80; }
  </style>
</head>
<body>
  <div class="controls">
    <span id="progress">Loading...</span>
    <select id="filterVideo"><option value="">All videos</option></select>
    <select id="filterClass">
      <option value="">All classes</option>
      <option value="death_screen">death_screen</option>
      <option value="spectating">spectating</option>
      <option value="buy_phase">buy_phase</option>
      <option value="round_end">round_end</option>
      <option value="loading">loading</option>
      <option value="gameplay">gameplay</option>
    </select>
    <select id="sortBy">
      <option value="confidence">Sort: Least confident first</option>
      <option value="time">Sort: By time</option>
    </select>
    <button onclick="prevPage()">← Prev</button>
    <span id="pageInfo">Page 1</span>
    <button onclick="nextPage()">Next →</button>
    <span class="stats" id="stats"></span>
  </div>
  <div class="grid" id="grid"></div>

  <div class="modal" id="modal">
    <div class="modal-content">
      <img id="modalImg" />
      <p id="modalInfo"></p>
      <div class="buttons">
        <button class="btn-gameplay" onclick="setLabel('gameplay')">1: Gameplay</button>
        <button class="btn-death_screen" onclick="setLabel('death_screen')">2: Death</button>
        <button class="btn-spectating" onclick="setLabel('spectating')">3: Spectating</button>
        <button class="btn-buy_phase" onclick="setLabel('buy_phase')">4: Buy Phase</button>
        <button class="btn-round_end" onclick="setLabel('round_end')">5: Round End</button>
        <button class="btn-loading" onclick="setLabel('loading')">6: Loading</button>
        <button style="background:#333;color:#fff" onclick="closeModal()">ESC: Close</button>
      </div>
    </div>
  </div>

  <script>
    let frames = [];
    let corrections = {};
    let page = 0;
    const PER_PAGE = 30;
    let currentFrameId = null;

    async function load() {
      const resp = await fetch('/api/frames');
      const data = await resp.json();
      frames = data.frames;
      corrections = data.corrections;

      // Populate video filter
      const videos = [...new Set(frames.map(f => f.videoId))];
      const sel = document.getElementById('filterVideo');
      videos.forEach(v => { const o = document.createElement('option'); o.value = v; o.textContent = v; sel.appendChild(o); });

      updateStats();
      render();
    }

    function getFiltered() {
      let f = [...frames];
      const video = document.getElementById('filterVideo').value;
      const cls = document.getElementById('filterClass').value;
      if (video) f = f.filter(x => x.videoId === video);
      if (cls) f = f.filter(x => (corrections[x.framePath] || x.label) === cls);

      const sort = document.getElementById('sortBy').value;
      if (sort === 'confidence') f.sort((a, b) => a.confidence - b.confidence);
      return f;
    }

    function render() {
      const filtered = getFiltered();
      const start = page * PER_PAGE;
      const slice = filtered.slice(start, start + PER_PAGE);
      const grid = document.getElementById('grid');
      grid.innerHTML = '';

      slice.forEach(f => {
        const effectiveLabel = corrections[f.framePath] || f.label;
        const isCorrected = !!corrections[f.framePath];
        const card = document.createElement('div');
        card.className = 'card' + (isCorrected ? ' corrected' : '');
        card.innerHTML = '<img src="/frame?path=' + encodeURIComponent(f.framePath) + '" loading="lazy" />' +
          '<div class="info"><span class="label label-' + effectiveLabel + '">' + effectiveLabel + '</span>' +
          ' <span style="color:#666">' + (f.confidence * 100).toFixed(0) + '%</span>' +
          ' <span style="color:#444">' + f.videoId + '</span></div>';
        card.onclick = () => openModal(f);
        grid.appendChild(card);
      });

      document.getElementById('pageInfo').textContent = 'Page ' + (page + 1) + '/' + Math.ceil(filtered.length / PER_PAGE);
    }

    function updateStats() {
      const corrCount = Object.keys(corrections).length;
      document.getElementById('progress').textContent = frames.length + ' frames | ' + corrCount + ' corrected';

      const dist = {};
      frames.forEach(f => { const l = corrections[f.framePath] || f.label; dist[l] = (dist[l] || 0) + 1; });
      document.getElementById('stats').textContent = Object.entries(dist).map(([k,v]) => k + ':' + v).join(' | ');
    }

    function openModal(f) {
      currentFrameId = f;
      document.getElementById('modalImg').src = '/frame?path=' + encodeURIComponent(f.framePath);
      document.getElementById('modalInfo').textContent = f.videoId + ' | ' + f.label + ' (' + (f.confidence * 100).toFixed(0) + '%)';
      document.getElementById('modal').classList.add('active');
    }

    function closeModal() {
      document.getElementById('modal').classList.remove('active');
      currentFrameId = null;
    }

    async function setLabel(label) {
      if (!currentFrameId) return;
      await fetch('/api/correct', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ framePath: currentFrameId.framePath, label }),
      });
      corrections[currentFrameId.framePath] = label;
      closeModal();
      updateStats();
      render();
    }

    function nextPage() { page++; render(); window.scrollTo(0, 0); }
    function prevPage() { if (page > 0) page--; render(); window.scrollTo(0, 0); }

    document.addEventListener('keydown', e => {
      if (document.getElementById('modal').classList.contains('active')) {
        if (e.key === '1') setLabel('gameplay');
        if (e.key === '2') setLabel('death_screen');
        if (e.key === '3') setLabel('spectating');
        if (e.key === '4') setLabel('buy_phase');
        if (e.key === '5') setLabel('round_end');
        if (e.key === '6') setLabel('loading');
        if (e.key === 'Escape') closeModal();
      } else {
        if (e.key === 'ArrowRight') nextPage();
        if (e.key === 'ArrowLeft') prevPage();
      }
    });

    document.getElementById('filterVideo').onchange = () => { page = 0; render(); };
    document.getElementById('filterClass').onchange = () => { page = 0; render(); };
    document.getElementById('sortBy').onchange = () => { page = 0; render(); };

    load();
  </script>
</body>
</html>`;

// Server
const labels = loadLabels();
console.log(`Loaded ${labels.length} labels`);

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname === '/' || url.pathname === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(HTML);
    return;
  }

  if (url.pathname === '/api/frames') {
    const corrections = loadReviewed();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ frames: labels, corrections }));
    return;
  }

  if (url.pathname === '/api/correct' && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      const { framePath, label } = JSON.parse(body);
      saveCorrection(framePath, label);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });
    return;
  }

  if (url.pathname === '/frame') {
    const framePath = url.searchParams.get('path');
    if (framePath && fs.existsSync(framePath)) {
      const img = fs.readFileSync(framePath);
      res.writeHead(200, { 'Content-Type': 'image/jpeg' });
      res.end(img);
      return;
    }
    res.writeHead(404);
    res.end('Not found');
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`Review server: http://localhost:${PORT}`);
  console.log('Keyboard shortcuts: 1-6 to label, arrows to navigate, Esc to close');
});
