#!/bin/bash
# Download clean Valorant gameplay videos for training
# 20 agents, diverse maps, 720p, no overlays preferred

OUTDIR="data/training-videos"
mkdir -p "$OUTDIR"

# Format: agent|youtube_id|map_guess (from title)
declare -a VIDEOS=(
  "cypher|aGs9eOH7Cjs|unknown"
  "omen|i7EmxFPkoQU|unknown"
  "sova|j_JFmD7dOEI|unknown"
  "killjoy|_phEery87U4|unknown"
  "sage|wwTrKMEN-O4|unknown"
  "raze|AQXGhhQEEBA|unknown"
  "reyna|QFcMsXkx448|unknown"
  "phoenix|hoD7hFNKjcE|haven"
  "fade|3kXh44Ji4Bs|unknown"
  "gekko|BEXxuj7QkmA|unknown"
  "neon|tOI1F63lIuQ|unknown"
  "viper|WSt_CVnLdxk|unknown"
  "chamber|LXcNJ5XJkVI|unknown"
  "iso|ZdZSopt90To|unknown"
  "astra|M_DLkgUCLYs|unknown"
  "skye|BNoUufiQTDc|unknown"
  "harbor|pEzyDS2-mCA|unknown"
  "tejo|wfd4OeSxe1I|unknown"
  "clove|l5Rkpik0iBA|unknown"
  "waylay|hshrce8CHTk|corrode"
)

echo "Downloading ${#VIDEOS[@]} gameplay videos at 720p..."
echo ""

for entry in "${VIDEOS[@]}"; do
  IFS='|' read -r agent vid_id map_guess <<< "$entry"
  outfile="$OUTDIR/${agent}-${vid_id}.mp4"

  if [ -f "$outfile" ]; then
    echo "[SKIP] $agent (already downloaded)"
    continue
  fi

  echo "[DL] $agent (https://youtube.com/watch?v=$vid_id) map=$map_guess"
  yt-dlp -f "bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/best[height<=720]" \
    --merge-output-format mp4 \
    -o "$outfile" \
    "https://www.youtube.com/watch?v=$vid_id" 2>&1 | tail -3
  echo ""
done

echo "=== DONE ==="
ls -lh "$OUTDIR"/*.mp4 2>/dev/null | wc -l
echo "videos downloaded"
du -sh "$OUTDIR"
