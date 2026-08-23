/// Clip and video processing via ffmpeg
///
/// Creates analysis copies for server upload and extracts coaching moment clips.
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::OnceLock;
use thiserror::Error;

/// Cached result of CUDA hardware acceleration probe.
/// Tested once on first use so we don't repeatedly spawn-and-fail ffmpeg.
static CUDA_AVAILABLE: OnceLock<bool> = OnceLock::new();

fn is_cuda_available() -> bool {
    *CUDA_AVAILABLE.get_or_init(|| {
        // Probe: try decoding a synthetic 1-frame video with CUDA hwaccel.
        let ok = Command::new(crate::ffmpeg_bin())
            .args([
                "-hide_banner",
                "-loglevel",
                "error",
                "-hwaccel",
                "cuda",
                "-f",
                "lavfi",
                "-i",
                "nullsrc=s=64x64:d=0.04",
                "-frames:v",
                "1",
                "-f",
                "null",
                "-",
            ])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        log::info!("CUDA hwaccel probe: available={ok}");
        ok
    })
}

#[derive(Debug, Error)]
pub enum ClipError {
    #[error("ffmpeg failed: {0}")]
    Ffmpeg(String),
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
}

/// Extract a sub-clip from a recording.
/// `start_sec` — seconds from start of recording.
/// `duration_sec` — length of clip.
/// Uses stream copy (no re-encode) so it's near-instant.
pub fn extract_clip(
    recording: &Path,
    start_sec: f64,
    duration_sec: f64,
    output: &Path,
) -> Result<(), ClipError> {
    let status = Command::new(crate::ffmpeg_bin())
        .args([
            "-y",
            "-ss",
            &format!("{start_sec:.3}"),
            "-i",
            &recording.to_string_lossy(),
            "-t",
            &format!("{duration_sec:.3}"),
            "-c",
            "copy",
            &output.to_string_lossy(),
        ])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|e| ClipError::Ffmpeg(e.to_string()))?;

    if !status.success() {
        return Err(ClipError::Ffmpeg(format!(
            "exit code {:?} for clip at {start_sec:.1}s",
            status.code()
        )));
    }

    Ok(())
}

/// Extract a single frame from a recording as a JPEG file.
/// Uses CUDA hardware-accelerated decoding when available.
pub fn extract_frame(recording: &Path, timestamp_sec: f64, output: &Path) -> Result<(), ClipError> {
    let mut args: Vec<String> = vec!["-y".into()];
    if is_cuda_available() {
        args.extend(["-hwaccel".into(), "cuda".into()]);
    }
    args.extend([
        "-ss".into(),
        format!("{timestamp_sec:.3}"),
        "-i".into(),
        recording.to_string_lossy().to_string(),
        "-vframes".into(),
        "1".into(),
        "-q:v".into(),
        "4".into(),
        output.to_string_lossy().to_string(),
    ]);

    let status = Command::new(crate::ffmpeg_bin())
        .args(&args)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|e| ClipError::Ffmpeg(e.to_string()))?;

    if !status.success() {
        return Err(ClipError::Ffmpeg(format!(
            "frame extract failed at {timestamp_sec:.1}s"
        )));
    }

    Ok(())
}

/// Create a lightweight analysis copy for Gemini upload.
///
/// Targets ~0.5fps for typical games (20-45 min). Longer games scale down
/// but never below 0.5fps. Gemini at MEDIA_RESOLUTION_LOW samples at ~0.28fps
/// internally, so 0.5fps already provides more frames than it uses.
///
/// Uses `-skip_frame nokey` to only decode keyframes — since recordings use
/// `-g 120` (keyframe every 2s at 60fps), and we want ~1fps output, this
/// skips decoding ~99% of frames. Combined with NVENC for encoding when available.
pub fn create_analysis_copy(
    recording: &Path,
    output: &Path,
    interval_secs: f64,
) -> Result<(), ClipError> {
    // 3fps gives VLM temporal context for coaching. Floor 0.5fps for very sparse sampling.
    let fps = (1.0 / interval_secs).clamp(0.5, 3.0);
    let vf = format!("fps={fps:.4},scale=1280:720");
    log::info!("Analysis copy: interval={interval_secs:.2}s → fps={fps:.4}");

    // Fast path: -skip_frame nokey only decodes keyframes (I-frames).
    // Recordings have keyframe every 2s (-g 120 at 60fps). At 0.5-1fps output,
    // this decodes ~1 frame/2s instead of 60 frames/s — a ~60-120x speedup.
    // Try with NVENC encode first, then CPU encode, then full-decode fallback.
    let rec_str = recording.to_string_lossy().to_string();
    let out_str = output.to_string_lossy().to_string();

    let encoder_configs: Vec<(&str, Vec<String>)> = if is_cuda_available() {
        vec![
            (
                "skip_frame + NVENC",
                vec![
                    "-y".into(),
                    "-skip_frame".into(),
                    "nokey".into(),
                    "-i".into(),
                    rec_str.clone(),
                    "-vf".into(),
                    vf.clone(),
                    "-c:v".into(),
                    "h264_nvenc".into(),
                    "-preset".into(),
                    "p1".into(),
                    "-cq".into(),
                    "32".into(),
                    "-an".into(),
                    out_str.clone(),
                ],
            ),
            (
                "skip_frame + CPU",
                vec![
                    "-y".into(),
                    "-skip_frame".into(),
                    "nokey".into(),
                    "-i".into(),
                    rec_str.clone(),
                    "-vf".into(),
                    vf.clone(),
                    "-c:v".into(),
                    "libx264".into(),
                    "-preset".into(),
                    "ultrafast".into(),
                    "-crf".into(),
                    "32".into(),
                    "-an".into(),
                    out_str.clone(),
                ],
            ),
            (
                "full decode + NVDEC + NVENC",
                vec![
                    "-y".into(),
                    "-hwaccel".into(),
                    "cuda".into(),
                    "-i".into(),
                    rec_str.clone(),
                    "-vf".into(),
                    vf.clone(),
                    "-c:v".into(),
                    "h264_nvenc".into(),
                    "-preset".into(),
                    "p1".into(),
                    "-cq".into(),
                    "32".into(),
                    "-an".into(),
                    out_str.clone(),
                ],
            ),
        ]
    } else {
        vec![
            (
                "skip_frame + CPU",
                vec![
                    "-y".into(),
                    "-skip_frame".into(),
                    "nokey".into(),
                    "-i".into(),
                    rec_str.clone(),
                    "-vf".into(),
                    vf.clone(),
                    "-c:v".into(),
                    "libx264".into(),
                    "-preset".into(),
                    "ultrafast".into(),
                    "-crf".into(),
                    "32".into(),
                    "-an".into(),
                    out_str.clone(),
                ],
            ),
            (
                "full decode + CPU",
                vec![
                    "-y".into(),
                    "-i".into(),
                    rec_str.clone(),
                    "-vf".into(),
                    vf.clone(),
                    "-c:v".into(),
                    "libx264".into(),
                    "-preset".into(),
                    "ultrafast".into(),
                    "-crf".into(),
                    "32".into(),
                    "-an".into(),
                    out_str.clone(),
                ],
            ),
        ]
    };

    for (label, args) in &encoder_configs {
        log::info!("Analysis copy: trying {label}");

        let result = Command::new(crate::ffmpeg_bin())
            .args(args)
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .output();

        match result {
            Ok(out) if out.status.success() => {
                log::info!("Analysis copy created with {label}");
                return Ok(());
            }
            Ok(out) => {
                let stderr = String::from_utf8_lossy(&out.stderr);
                log::warn!(
                    "{label} failed (exit {:?}): {}",
                    out.status.code(),
                    stderr.lines().take(3).collect::<Vec<_>>().join(" | ")
                );
                let _ = std::fs::remove_file(output);
            }
            Err(e) => {
                log::warn!("{label} spawn failed: {e}");
                let _ = std::fs::remove_file(output);
            }
        }
    }

    Err(ClipError::Ffmpeg(
        "all analysis copy strategies failed".into(),
    ))
}

// ── Enrichment Frame Extraction ──────────────────────────────────────────────

/// A high-fps frame extracted from the original recording for coaching enrichment.
#[derive(Debug, Clone, serde::Serialize)]
pub struct EnrichmentFrame {
    pub label: String,
    pub base64: String,
    pub timestamp_sec: f64,
}

/// Crop filter constants — must match server-side values in frame-extractor.ts
const CROP_MINIMAP: &str = "crop=iw*0.18:ih*0.3:0:0";
const CROP_CENTER: &str = "crop=iw*0.6:ih*0.3:iw*0.2:ih*0.28";
const CROP_KILLFEED: &str = "crop=iw*0.33:ih*0.4:iw*0.67:ih*0.02";
/// "ELIMINATED BY [AGENT]" banner + weapon icon — center of death screen
const CROP_DEATHBANNER: &str = "crop=iw*0.4:ih*0.12:iw*0.3:ih*0.4";
/// Weapon HUD — bottom-right shows weapon name, ammo, icon
const CROP_WEAPON_HUD: &str = "crop=iw*0.2:ih*0.15:iw*0.8:ih*0.85";
/// Ability bar — bottom-center shows 4 ability icons with availability state
const CROP_ABILITY_BAR: &str = "crop=iw*0.3:ih*0.1:iw*0.35:ih*0.88";

/// Extract high-fps enrichment frames from the original 60fps recording.
///
/// For each death, extracts an 8.5-second clip at 2fps (18 raw frames) but only sends
/// 15 timeline frames (7s before → death moment) to avoid spectating confusion.
/// Death screen crops (deathbanner, killfeed, center) are still extracted from frame 018.
/// Also extracts 2 agent identification frames from early in the game.
///
/// Returns base64-encoded JPEG frames ready for upload to the enrichment endpoint.
/// Utility event from Pass 1: ability used earlier in the round before a death.
#[derive(Debug, Clone)]
pub struct UtilityEvent {
    pub death_number: usize,
    pub event_index: usize, // 1-based within the death's round
    pub ability_name: String,
    pub timestamp_sec: f64,
}

pub fn extract_enrichment_frames(
    recording: &Path,
    death_timestamps: &[(usize, f64)], // (death_number, timestamp_sec)
    utility_events: &[UtilityEvent],
    output_dir: &Path,
) -> Result<Vec<EnrichmentFrame>, ClipError> {
    let mut frames: Vec<EnrichmentFrame> = Vec::new();

    // Agent identification frames — early game buy phase
    for &t in &[3.0_f64, 10.0] {
        let label = format!("agent_id_{t:.0}s");
        let out = output_dir.join(format!("{label}.jpg"));
        if extract_frame(recording, t, &out).is_ok() {
            if let Ok(data) = std::fs::read(&out) {
                frames.push(EnrichmentFrame {
                    label,
                    base64: base64_encode(&data),
                    timestamp_sec: t,
                });
            }
        }
    }

    // Per-death: extract 2fps clip + crops
    // Frame offsets relative to death timestamp (at 2fps = 0.5s intervals)
    // 7 seconds before death captures full decision-making context
    // We extract 8.5s of video (18 frames) so frame 018 exists for death screen crops,
    // but only send timeline frames up to T+0.0 to avoid spectating confusion.
    let frame_offsets: Vec<f64> = vec![
        -7.0, -6.5, -6.0, -5.5, -5.0, -4.5, -4.0, -3.5, -3.0, -2.5, -2.0, -1.5, -1.0, -0.5, 0.0,
    ];

    for &(death_num, timestamp) in death_timestamps {
        let clip_start = (timestamp - 7.0).max(0.0);
        let clip_dir = output_dir.join(format!("death_{death_num}"));
        let _ = std::fs::create_dir_all(&clip_dir);

        // Extract 2fps clip in a single ffmpeg call (8.5s window)
        // Use CUDA decode when available — big win on 60fps source recordings
        let mut clip_args: Vec<String> = vec!["-y".into()];
        if is_cuda_available() {
            clip_args.extend(["-hwaccel".into(), "cuda".into()]);
        }
        clip_args.extend([
            "-ss".into(),
            format!("{clip_start:.3}"),
            "-i".into(),
            recording.to_string_lossy().to_string(),
            "-t".into(),
            "8.5".into(),
            "-vf".into(),
            "fps=2".into(),
            "-q:v".into(),
            "4".into(),
            clip_dir
                .join(format!("death_{death_num}_%03d.jpg"))
                .to_string_lossy()
                .to_string(),
        ]);

        let status = Command::new(crate::ffmpeg_bin())
            .args(&clip_args)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map_err(|e| ClipError::Ffmpeg(e.to_string()))?;

        if !status.success() {
            log::warn!("Enrichment clip extraction failed for death {death_num}");
            continue;
        }

        // Map ffmpeg sequential output (001, 002, ...) to labeled frames
        for (i, &offset) in frame_offsets.iter().enumerate() {
            let seq_num = i + 1; // ffmpeg starts at 001
            let file_path = clip_dir.join(format!("death_{death_num}_{seq_num:03}.jpg"));
            if !file_path.exists() {
                continue;
            }

            let label = format!("death_{death_num}_t{offset:+.1}");
            if let Ok(data) = std::fs::read(&file_path) {
                frames.push(EnrichmentFrame {
                    label,
                    base64: base64_encode(&data),
                    timestamp_sec: timestamp + offset,
                });
            }
        }

        // Extract crops from key frames
        // Predeath (T-1.0, frame 013): minimap, weapon HUD, ability bar
        let predeath_frame = clip_dir.join(format!("death_{death_num}_013.jpg"));
        if predeath_frame.exists() {
            extract_crop(
                &predeath_frame,
                CROP_MINIMAP,
                &clip_dir.join("crop_minimap.jpg"),
                &format!("death_{death_num}_crop_minimap"),
                timestamp - 1.0,
                &mut frames,
            );
            extract_crop(
                &predeath_frame,
                CROP_WEAPON_HUD,
                &clip_dir.join("crop_weapon_hud.jpg"),
                &format!("death_{death_num}_crop_weapon_hud"),
                timestamp - 1.0,
                &mut frames,
            );
            extract_crop(
                &predeath_frame,
                CROP_ABILITY_BAR,
                &clip_dir.join("crop_ability_bar.jpg"),
                &format!("death_{death_num}_crop_ability_bar"),
                timestamp - 1.0,
                &mut frames,
            );
        }

        // Death screen (T+1.5, frame 018): center, killfeed, death banner
        let deathscreen_frame = clip_dir.join(format!("death_{death_num}_018.jpg"));
        if deathscreen_frame.exists() {
            extract_crop(
                &deathscreen_frame,
                CROP_CENTER,
                &clip_dir.join("crop_center.jpg"),
                &format!("death_{death_num}_crop_center"),
                timestamp + 1.5,
                &mut frames,
            );
            extract_crop(
                &deathscreen_frame,
                CROP_KILLFEED,
                &clip_dir.join("crop_killfeed.jpg"),
                &format!("death_{death_num}_crop_killfeed"),
                timestamp + 1.5,
                &mut frames,
            );
            extract_crop(
                &deathscreen_frame,
                CROP_DEATHBANNER,
                &clip_dir.join("crop_deathbanner.jpg"),
                &format!("death_{death_num}_crop_deathbanner"),
                timestamp + 1.5,
                &mut frames,
            );
        }
    }

    // ── Utility event frames ─────────────────────────────────────────────────
    // For each utility event from Pass 1, extract 2 snapshots:
    //   T+0.0 = moment of ability use
    //   T+2.0 = aftermath (where did it land / what happened)
    // Plus an ability bar crop at T+0.0 to show ability state.
    for event in utility_events {
        let util_dir = output_dir.join(format!(
            "death_{}_util_{}",
            event.death_number, event.event_index
        ));
        let _ = std::fs::create_dir_all(&util_dir);

        for &offset in &[0.0_f64, 2.0] {
            let ts = (event.timestamp_sec + offset).max(0.0);
            let label = format!(
                "death_{}_util_{}_t{offset:+.1}",
                event.death_number, event.event_index
            );
            let out = util_dir.join(format!("{label}.jpg"));

            if extract_frame(recording, ts, &out).is_ok() {
                if let Ok(data) = std::fs::read(&out) {
                    frames.push(EnrichmentFrame {
                        label: label.clone(),
                        base64: base64_encode(&data),
                        timestamp_sec: ts,
                    });

                    // Extract ability bar crop from the moment of use (T+0.0 only)
                    if offset == 0.0 {
                        extract_crop(
                            &out,
                            CROP_ABILITY_BAR,
                            &util_dir.join("crop_ability_bar.jpg"),
                            &format!(
                                "death_{}_util_{}_crop_ability_bar",
                                event.death_number, event.event_index
                            ),
                            ts,
                            &mut frames,
                        );
                    }
                }
            }
        }
    }

    log::info!(
        "Extracted {} enrichment frames for {} deaths + {} utility events",
        frames.len(),
        death_timestamps.len(),
        utility_events.len()
    );
    Ok(frames)
}

/// Extract a crop from an image using ffmpeg and add to frames list.
fn extract_crop(
    source: &Path,
    filter: &str,
    output: &Path,
    label: &str,
    timestamp_sec: f64,
    frames: &mut Vec<EnrichmentFrame>,
) {
    let status = Command::new(crate::ffmpeg_bin())
        .args([
            "-y",
            "-i",
            &source.to_string_lossy(),
            "-vf",
            filter,
            "-q:v",
            "4",
            &output.to_string_lossy(),
        ])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();

    if let Ok(s) = status {
        if s.success() {
            if let Ok(data) = std::fs::read(output) {
                frames.push(EnrichmentFrame {
                    label: label.to_string(),
                    base64: base64_encode(&data),
                    timestamp_sec,
                });
            }
        }
    }
}

fn base64_encode(data: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(data)
}

// ── Frame-Based Pipeline Extraction ────────────────────────────────────────

/// A high-resolution JPEG frame extracted at a specific offset from a death.
#[derive(Debug)]
pub struct DeathFrame {
    pub offset_sec: f64,
    pub jpeg_bytes: Vec<u8>,
}

/// A set of context frames around a single death event.
#[derive(Debug)]
pub struct DeathFrameSet {
    pub timestamp_sec: f64,
    pub frames: Vec<DeathFrame>,
}

/// A classifier-sized RGB frame with its absolute timestamp in the recording.
#[derive(Debug)]
pub struct TimedRgbFrame {
    pub timestamp_sec: f64,
    pub rgb_bytes: Vec<u8>,
}

/// Typed HUD crops around a death. These are smaller, purpose-built evidence
/// images that let the server/model read HUD facts without guessing from a
/// full 1080p frame.
#[derive(Debug, Default)]
pub struct DeathEvidenceCrops {
    pub decision_ability_bar: Option<Vec<u8>>,
    pub decision_weapon_hud: Option<Vec<u8>>,
    pub contact_weapon_hud: Option<Vec<u8>>,
    pub decision_minimap: Option<Vec<u8>>,
    pub decision_hp_shield: Option<Vec<u8>>,
    pub decision_crosshair: Option<Vec<u8>>,
    pub contact_crosshair: Option<Vec<u8>>,
    pub death_killfeed: Option<Vec<u8>>,
    pub death_top_hud: Option<Vec<u8>>,
}

/// Extract thumbnails from a video at specified fps, writing to a temp file
/// and reading back in chunks. This avoids piping hundreds of MB through stdout.
/// Returns Vec of raw RGB24 byte arrays (each 224*224*3 bytes).
pub fn extract_thumbnails_rgb(recording_path: &Path, fps: f64) -> Result<Vec<Vec<u8>>, ClipError> {
    let frame_size = 224 * 224 * 3; // RGB24, 224x224

    // Write raw frames to a temp file instead of piping through stdout
    let tmp_dir = std::env::temp_dir().join("scrima_thumbnails");
    let _ = std::fs::create_dir_all(&tmp_dir);
    let raw_path = tmp_dir.join(format!(
        "thumbs_{}_{}.raw",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
    ));

    let status = Command::new(crate::ffmpeg_bin())
        .args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-i",
            &recording_path.to_string_lossy(),
            "-vf",
            &format!("fps={fps},scale=224:224"),
            "-pix_fmt",
            "rgb24",
            "-f",
            "rawvideo",
            "-y",
            &raw_path.to_string_lossy(),
        ])
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .status()
        .map_err(|e| ClipError::Ffmpeg(format!("thumbnail extraction: {e}")))?;

    if !status.success() {
        let _ = std::fs::remove_file(&raw_path);
        return Err(ClipError::Ffmpeg(
            "thumbnail extraction failed (non-zero exit)".into(),
        ));
    }

    // Read the raw file in chunks (one frame at a time) to avoid 2x memory peak
    let file = std::fs::File::open(&raw_path).map_err(|e| {
        ClipError::Io(std::io::Error::new(
            std::io::ErrorKind::Other,
            format!("failed to open thumbnail file: {e}"),
        ))
    })?;
    let file_size = file.metadata().map(|m| m.len() as usize).unwrap_or(0);
    let num_frames = file_size / frame_size;
    let mut frames = Vec::with_capacity(num_frames);

    use std::io::Read;
    let mut reader = std::io::BufReader::new(file);
    let mut buf = vec![0u8; frame_size];
    loop {
        match reader.read_exact(&mut buf) {
            Ok(()) => frames.push(buf.clone()),
            Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => break,
            Err(e) => {
                let _ = std::fs::remove_file(&raw_path);
                return Err(ClipError::Io(e));
            }
        }
    }

    // Cleanup temp file
    let _ = std::fs::remove_file(&raw_path);

    log::info!(
        "Extracted {} thumbnails at {fps}fps ({:.1} MB raw)",
        frames.len(),
        file_size as f64 / 1_048_576.0
    );
    Ok(frames)
}

/// Extract classifier-sized RGB frames from a short time window. Unlike
/// `extract_thumbnails_rgb`, this preserves the absolute timestamp for each
/// frame so the analysis pipeline can refine a coarse death candidate into a
/// real death-onset boundary.
pub fn extract_window_thumbnails_rgb(
    recording_path: &Path,
    start_sec: f64,
    duration_sec: f64,
    fps: f64,
) -> Result<Vec<TimedRgbFrame>, ClipError> {
    if duration_sec <= 0.0 || fps <= 0.0 {
        return Ok(Vec::new());
    }

    let frame_size = 224 * 224 * 3;
    let tmp_dir = std::env::temp_dir().join("scrima_thumbnails");
    let _ = std::fs::create_dir_all(&tmp_dir);
    let raw_path = tmp_dir.join(format!(
        "window_{}_{}.raw",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
    ));

    let mut args: Vec<String> = vec![
        "-hide_banner".into(),
        "-loglevel".into(),
        "error".into(),
        "-ss".into(),
        format!("{start_sec:.3}"),
    ];
    if is_cuda_available() {
        args.extend(["-hwaccel".into(), "cuda".into()]);
    }
    args.extend([
        "-i".into(),
        recording_path.to_string_lossy().to_string(),
        "-t".into(),
        format!("{duration_sec:.3}"),
        "-vf".into(),
        format!("fps={fps},scale=224:224"),
        "-pix_fmt".into(),
        "rgb24".into(),
        "-f".into(),
        "rawvideo".into(),
        "-y".into(),
        raw_path.to_string_lossy().to_string(),
    ]);

    let status = Command::new(crate::ffmpeg_bin())
        .args(&args)
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .status()
        .map_err(|e| ClipError::Ffmpeg(format!("window thumbnail extraction: {e}")))?;

    if !status.success() {
        let _ = std::fs::remove_file(&raw_path);
        return Err(ClipError::Ffmpeg(
            "window thumbnail extraction failed (non-zero exit)".into(),
        ));
    }

    let file = std::fs::File::open(&raw_path).map_err(|e| {
        ClipError::Io(std::io::Error::new(
            std::io::ErrorKind::Other,
            format!("failed to open window thumbnail file: {e}"),
        ))
    })?;

    use std::io::Read;
    let mut reader = std::io::BufReader::new(file);
    let mut frames = Vec::new();
    let mut buf = vec![0u8; frame_size];
    let mut idx = 0usize;
    loop {
        match reader.read_exact(&mut buf) {
            Ok(()) => {
                frames.push(TimedRgbFrame {
                    timestamp_sec: start_sec + (idx as f64 / fps),
                    rgb_bytes: buf.clone(),
                });
                idx += 1;
            }
            Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => break,
            Err(e) => {
                let _ = std::fs::remove_file(&raw_path);
                return Err(ClipError::Io(e));
            }
        }
    }

    let _ = std::fs::remove_file(&raw_path);
    Ok(frames)
}

/// Extract a single high-quality JPEG frame at a specific timestamp.
/// Returns JPEG bytes piped directly from ffmpeg.
pub fn extract_frame_jpeg(recording_path: &Path, timestamp_sec: f64) -> Result<Vec<u8>, ClipError> {
    let mut args: Vec<String> = vec!["-hide_banner".into(), "-loglevel".into(), "error".into()];
    if is_cuda_available() {
        args.extend(["-hwaccel".into(), "cuda".into()]);
    }
    args.extend([
        "-ss".into(),
        format!("{:.2}", timestamp_sec),
        "-i".into(),
        recording_path.to_string_lossy().to_string(),
        "-frames:v".into(),
        "1".into(),
        "-q:v".into(),
        "2".into(),
        "-f".into(),
        "image2pipe".into(),
        "-vcodec".into(),
        "mjpeg".into(),
        "pipe:1".into(),
    ]);

    let output = Command::new(crate::ffmpeg_bin())
        .args(&args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|e| ClipError::Ffmpeg(format!("frame extraction at {timestamp_sec}s: {e}")))?;

    if !output.status.success() || output.stdout.is_empty() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(ClipError::Ffmpeg(format!(
            "frame extraction at {timestamp_sec}s: {stderr}"
        )));
    }

    Ok(output.stdout)
}

fn extract_crop_jpeg(
    recording_path: &Path,
    timestamp_sec: f64,
    vf: &str,
) -> Result<Vec<u8>, ClipError> {
    let mut args: Vec<String> = vec!["-hide_banner".into(), "-loglevel".into(), "error".into()];
    if is_cuda_available() {
        args.extend(["-hwaccel".into(), "cuda".into()]);
    }
    args.extend([
        "-ss".into(),
        format!("{timestamp_sec:.2}"),
        "-i".into(),
        recording_path.to_string_lossy().to_string(),
        "-frames:v".into(),
        "1".into(),
        "-vf".into(),
        vf.into(),
        "-q:v".into(),
        "3".into(),
        "-f".into(),
        "image2pipe".into(),
        "-vcodec".into(),
        "mjpeg".into(),
        "pipe:1".into(),
    ]);

    let output = Command::new(crate::ffmpeg_bin())
        .args(&args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|e| ClipError::Ffmpeg(format!("crop extraction at {timestamp_sec}s: {e}")))?;

    if !output.status.success() || output.stdout.is_empty() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(ClipError::Ffmpeg(format!(
            "crop extraction failed at {timestamp_sec}s: {stderr}"
        )));
    }

    Ok(output.stdout)
}

/// Extract a zoomed-in crop of the ability bar (bottom-center HUD) at a
/// specific timestamp. Returns JPEG bytes.
///
/// The full-frame bottom-center ability icons are ~40-50 px wide at 1080p;
/// after Gemma's internal tiling at HIGH media resolution they drop to
/// ~10-15 px — below legible threshold for LIT vs DIMMED. This crop takes
/// the bottom 15% of the frame (center 30% horizontally) and scales up to
/// 512×192 so the four ability icons become ~90-100 px wide each — 5-10×
/// larger than a full-frame tile, making LIT/DIMMED reliably distinguishable.
pub fn extract_ability_bar_crop(
    recording_path: &Path,
    timestamp_sec: f64,
) -> Result<Vec<u8>, ClipError> {
    let mut args: Vec<String> = vec!["-hide_banner".into(), "-loglevel".into(), "error".into()];
    if is_cuda_available() {
        args.extend(["-hwaccel".into(), "cuda".into()]);
    }
    // Crop the bottom-center ability bar. The four C/Q/E/X icons sit in the
    // lower ~10-15% of screen, horizontally centered roughly 35-65% of width.
    // We grab a bit more (bottom 15%, center 30%) to be resilient to small
    // UI scaling differences, then upscale to 1024×384 — 4× the pixel count
    // of our earlier 512×192 crop. Gemma's LIT vs DIMMED reads were partial
    // at the smaller size (user reported 2026-04-20); the larger crop makes
    // the charge indicators and greyed-out overlays substantially cleaner to
    // the model's vision encoder without meaningfully more inference cost.
    let vf = "crop=iw*0.30:ih*0.15:iw*0.35:ih*0.85,scale=1024:384";
    args.extend([
        "-ss".into(),
        format!("{:.2}", timestamp_sec),
        "-i".into(),
        recording_path.to_string_lossy().to_string(),
        "-frames:v".into(),
        "1".into(),
        "-vf".into(),
        vf.into(),
        "-q:v".into(),
        "2".into(),
        "-f".into(),
        "image2pipe".into(),
        "-vcodec".into(),
        "mjpeg".into(),
        "pipe:1".into(),
    ]);

    let output = Command::new(crate::ffmpeg_bin())
        .args(&args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|e| ClipError::Ffmpeg(format!("ability bar crop at {timestamp_sec}s: {e}")))?;

    if !output.status.success() || output.stdout.is_empty() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(ClipError::Ffmpeg(format!(
            "ability bar crop failed at {timestamp_sec}s: {stderr}"
        )));
    }

    Ok(output.stdout)
}

/// Extract typed HUD crops from the decision and death moments. These crops
/// are additive to the legacy full-frame payload; if a crop fails, the rest of
/// the death analysis can still continue.
pub fn extract_death_evidence_crops(
    recording_path: &Path,
    decision_timestamp_sec: f64,
    death_timestamp_sec: f64,
) -> DeathEvidenceCrops {
    let mut crops = DeathEvidenceCrops::default();
    let contact_timestamp_sec = (death_timestamp_sec - 0.5).max(decision_timestamp_sec);

    crops.decision_ability_bar =
        extract_ability_bar_crop(recording_path, decision_timestamp_sec).ok();
    crops.decision_weapon_hud = extract_crop_jpeg(
        recording_path,
        decision_timestamp_sec,
        "crop=iw*0.22:ih*0.16:iw*0.78:ih*0.82,scale=768:-1",
    )
    .ok();
    crops.contact_weapon_hud = extract_crop_jpeg(
        recording_path,
        contact_timestamp_sec,
        "crop=iw*0.22:ih*0.16:iw*0.78:ih*0.82,scale=768:-1",
    )
    .ok();
    crops.decision_minimap = extract_crop_jpeg(
        recording_path,
        decision_timestamp_sec,
        "crop=iw*0.20:ih*0.32:0:0,scale=640:-1",
    )
    .ok();
    crops.decision_hp_shield = extract_crop_jpeg(
        recording_path,
        decision_timestamp_sec,
        "crop=iw*0.22:ih*0.18:0:ih*0.80,scale=768:-1",
    )
    .ok();
    crops.decision_crosshair = extract_crop_jpeg(
        recording_path,
        decision_timestamp_sec,
        "crop=iw*0.34:ih*0.34:iw*0.33:ih*0.33,scale=768:-1",
    )
    .ok();
    crops.contact_crosshair = extract_crop_jpeg(
        recording_path,
        contact_timestamp_sec,
        "crop=iw*0.34:ih*0.34:iw*0.33:ih*0.33,scale=768:-1",
    )
    .ok();
    crops.death_killfeed = extract_crop_jpeg(
        recording_path,
        death_timestamp_sec,
        "crop=iw*0.38:ih*0.32:iw*0.62:ih*0.02,scale=960:-1",
    )
    .ok();
    crops.death_top_hud = extract_crop_jpeg(
        recording_path,
        death_timestamp_sec,
        "crop=iw*0.38:ih*0.14:iw*0.31:0,scale=900:-1",
    )
    .ok();

    crops
}

/// Extract death context frames at full native resolution.
///
/// Offsets are tuned for Gemma's HUD-reading quality, ALL pre-death / at-death
/// (no killcam frames — those show a different agent center-frame and confuse
/// the model more than they help, since the kill feed is already rendered by
/// the moment of death):
///   -5s:   macro context — which area / teammate / angle chosen
///   -3s:   approach phase
///   -2s:   commit moment (positioning finalized, abilities considered)
///   -1.25s: pre-contact adjustment
///   -0.75s: contact starts / angle opens
///   -1s:   engagement prep — decisionHP / abilities / weapon read from here
///   -0.5s: engagement execution (peek / get-peeked)
///   -0.25s: last alive / damage response
///    0.0s: moment of death — kill feed entry is fresh here, HP reads zero,
///          killer name and weapon visible in the kill feed at top-right
///
/// We clamp to `game_start_sec` so frames cannot reach before gameplay started.
/// Frames are piped as JPEG (-q:v 2 ≈ near-lossless) at native recording
/// resolution — user requested HIGH image quality; Gemma tiles internally so
/// source resolution feeds more detail to the model without our re-encoding.
pub fn extract_death_frames(
    recording_path: &Path,
    death_timestamps: &[f64],
    game_start_sec: f64,
) -> Vec<DeathFrameSet> {
    let offsets: [f64; 9] = [-5.0, -3.0, -2.0, -1.25, -1.0, -0.75, -0.5, -0.25, 0.0];
    let mut result = Vec::new();

    for &death_sec in death_timestamps {
        let mut frames = Vec::new();
        for &offset in &offsets {
            let t = (death_sec + offset).max(game_start_sec);
            match extract_frame_jpeg(recording_path, t) {
                Ok(jpeg) => {
                    frames.push(DeathFrame {
                        offset_sec: offset,
                        jpeg_bytes: jpeg,
                    });
                }
                Err(e) => {
                    log::warn!("Failed to extract frame at {t}s for death at {death_sec}s: {e}");
                }
            }
        }
        result.push(DeathFrameSet {
            timestamp_sec: death_sec,
            frames,
        });
    }

    log::info!("Extracted death context frames for {} deaths", result.len());
    result
}

/// Hybrid death context: 10-second video clip + 2 key still frames per death.
/// Video: T-8s to T+2s at 720p for motion context.
/// Stills: T-1s (pre-death HUD) and T+0s (kill feed) at full resolution.
pub struct HybridDeathContext {
    pub timestamp_sec: f64,
    pub video_clip_bytes: Vec<u8>,
    pub pre_death_frame: Option<DeathFrame>, // T-1s
    pub kill_feed_frame: Option<DeathFrame>, // T+0s
}

pub fn extract_hybrid_death_context(
    recording_path: &Path,
    death_timestamps: &[f64],
    game_start_sec: f64,
) -> Vec<HybridDeathContext> {
    let tmp_dir = std::env::temp_dir().join("scrima_clips");
    let _ = std::fs::create_dir_all(&tmp_dir);
    let mut result = Vec::new();

    for &death_sec in death_timestamps {
        let clip_start = (death_sec - 8.0).max(game_start_sec);
        let clip_duration = (death_sec + 2.0) - clip_start;
        let clip_path = tmp_dir.join(format!("death_{:.0}.mp4", death_sec));

        // Extract 10s video clip at 720p, low quality (context only)
        let clip_status = Command::new(crate::ffmpeg_bin())
            .args([
                "-hide_banner",
                "-loglevel",
                "error",
                "-ss",
                &format!("{:.2}", clip_start),
                "-i",
                &recording_path.to_string_lossy(),
                "-t",
                &format!("{:.2}", clip_duration),
                "-vf",
                "scale=854:480",
                "-c:v",
                "libx264",
                "-crf",
                "32",
                "-preset",
                "ultrafast",
                "-an",
                "-y",
                &clip_path.to_string_lossy(),
            ])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();

        let video_bytes = match clip_status {
            Ok(s) if s.success() => {
                let bytes = std::fs::read(&clip_path).unwrap_or_default();
                let _ = std::fs::remove_file(&clip_path);
                if bytes.is_empty() {
                    log::warn!("Empty clip for death at {death_sec}s");
                    Vec::new()
                } else {
                    log::info!(
                        "Clip for death at {death_sec}s: {:.0}KB",
                        bytes.len() as f64 / 1024.0
                    );
                    bytes
                }
            }
            _ => {
                log::warn!("Failed to extract clip for death at {death_sec}s");
                let _ = std::fs::remove_file(&clip_path);
                Vec::new()
            }
        };

        // Extract 2 key still frames at full resolution
        let pre_death = extract_frame_jpeg(recording_path, (death_sec - 1.0).max(game_start_sec))
            .ok()
            .map(|jpeg| DeathFrame {
                offset_sec: -1.0,
                jpeg_bytes: jpeg,
            });

        let kill_feed = extract_frame_jpeg(recording_path, death_sec)
            .ok()
            .map(|jpeg| DeathFrame {
                offset_sec: 0.0,
                jpeg_bytes: jpeg,
            });

        result.push(HybridDeathContext {
            timestamp_sec: death_sec,
            video_clip_bytes: video_bytes,
            pre_death_frame: pre_death,
            kill_feed_frame: kill_feed,
        });
    }

    log::info!("Extracted hybrid context for {} deaths", result.len());
    result
}

// ── Coaching Moment Clips ───────────────────────────────────────────────────

/// Extract a 15-second HD clip around a coaching moment timestamp.
///
/// `offset_sec` — seconds from the start of the recording where the moment occurs.
/// Uses stream copy for instant extraction at full quality.
pub fn extract_coaching_moment_clip(
    recording: &Path,
    offset_sec: f64,
    output: &Path,
) -> Result<(), ClipError> {
    let clip_start = (offset_sec - 10.0).max(0.0);
    let status = Command::new(crate::ffmpeg_bin())
        .args([
            "-y",
            "-ss",
            &format!("{clip_start:.3}"),
            "-i",
            &recording.to_string_lossy(),
            "-t",
            "15",
            "-c",
            "copy",
            &output.to_string_lossy(),
        ])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|e| ClipError::Ffmpeg(e.to_string()))?;

    if !status.success() {
        return Err(ClipError::Ffmpeg(format!(
            "coaching moment clip failed at {offset_sec:.1}s (exit {:?})",
            status.code()
        )));
    }
    Ok(())
}
