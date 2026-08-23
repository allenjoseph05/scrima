/// Recording Manager
///
/// Manages gameplay recording via ffmpeg. Uses hardware encoders in priority order:
///   1. h264_nvenc (NVIDIA)
///   2. h264_amf (AMD)
///   3. h264_qsv (Intel Quick Sync)
///   4. libx264 (software fallback)
///
/// Per spec: records full quality 1080p 60fps during gameplay.
/// File path: {output_dir}/{match_id}.mp4
pub mod buffer;

#[cfg(target_os = "windows")]
pub mod capture;

use std::collections::VecDeque;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStderr, Command};
use std::sync::{Arc, Mutex, RwLock};
use std::thread;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use thiserror::Error;
use uuid::Uuid;

/// Max lines of ffmpeg stderr to keep in memory for crash diagnostics.
const STDERR_BUFFER_LINES: usize = 200;
/// Max recording duration safety cap (6 hours). Real stop happens via stop_recording.
/// We keep a high cap rather than removing entirely so a runaway recording can't fill the disk.
const MAX_RECORDING_SECONDS: u32 = 6 * 3600;
/// Max ffmpeg auto-restart attempts before giving up. Low because the WGC path
/// doesn't have the GDI "access denied during fullscreen transition" problem —
/// if ffmpeg crashes now, something is genuinely broken (disk, encoder). The
/// GDI fallback path shares this cap; users hitting it more than 3 times should
/// be told to switch Valorant to Windowed Fullscreen.
const MAX_RESTART_ATTEMPTS: u32 = 3;
/// If ffmpeg has been running stably for this long, reset the restart counter so a
/// new burst of crashes later doesn't permanently kill the recording.
const STABLE_RESTART_RESET_SECS: u64 = 300; // 5 minutes

#[derive(Debug, Error)]
pub enum RecordingError {
    #[error("ffmpeg not found. Install ffmpeg and add to PATH.")]
    FfmpegNotFound,
    #[error("Failed to start recording: {0}")]
    StartFailed(String),
    #[error("Failed to stop recording: {0}")]
    StopFailed(String),
    #[error("Not recording")]
    NotRecording,
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
}

// ============================================================
// CONFIG
// ============================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecordingConfig {
    /// Where to save recordings
    pub output_dir: PathBuf,
    /// Target framerate (60 default)
    pub framerate: u32,
    /// Capture resolution height (720 default — optimal for Gemini analysis).
    /// 720p saves ~63% storage vs 1080p with zero coaching quality loss.
    pub resolution_height: u32,
    /// Video bitrate in Mbps (5.0 default for 720p, 8.0 recommended for 1080p)
    pub bitrate_mbps: f32,
    /// Keep last N games on disk (rolling buffer)
    pub max_games_kept: u32,
    /// Max total disk usage in GB
    pub max_disk_gb: u32,
}

impl Default for RecordingConfig {
    fn default() -> Self {
        let dir = dirs_next_or_temp();
        Self {
            output_dir: dir,
            framerate: 60,
            resolution_height: 1080,
            bitrate_mbps: 8.0,
            max_games_kept: 20,
            max_disk_gb: 50,
        }
    }
}

fn dirs_next_or_temp() -> PathBuf {
    // Use the same base directory as lib.rs app_data_dir() for consistency
    crate::app_data_dir().join("recordings")
}

// ============================================================
// STATUS
// ============================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingStatus {
    pub is_recording: bool,
    pub match_id: Option<String>,
    pub file_path: Option<String>,
    /// Path to the pre-built analysis copy (1080p 2fps with timestamps).
    /// Set after recording stops. None if dual-output failed.
    pub analysis_copy_path: Option<String>,
    pub started_at_ms: Option<u64>,
    pub encoder_used: Option<String>,
    pub estimated_size_mb: f32,
}

impl Default for RecordingStatus {
    fn default() -> Self {
        Self {
            is_recording: false,
            match_id: None,
            file_path: None,
            analysis_copy_path: None,
            started_at_ms: None,
            encoder_used: None,
            estimated_size_mb: 0.0,
        }
    }
}

// ============================================================
// ENCODER DETECTION
// ============================================================

#[derive(Debug, Clone, PartialEq)]
pub enum EncoderType {
    Nvenc,    // NVIDIA NVENC
    Amf,      // AMD AMF
    Qsv,      // Intel Quick Sync
    Software, // libx264 fallback
}

impl EncoderType {
    pub fn ffmpeg_codec(&self) -> &str {
        match self {
            EncoderType::Nvenc => "h264_nvenc",
            EncoderType::Amf => "h264_amf",
            EncoderType::Qsv => "h264_qsv",
            EncoderType::Software => "libx264",
        }
    }

    pub fn extra_args(&self) -> Vec<&str> {
        match self {
            // VBR with high-quality preset is much more forgiving than CBR for long
            // recordings during gameplay — under GPU contention the encoder can
            // drop quality instead of failing outright. `-tune ll` (low-latency)
            // is dropped because it's a streaming tuning that doesn't apply here
            // and is known to fail on older NVENC builds.
            EncoderType::Nvenc => vec!["-preset", "p4", "-rc", "vbr", "-rc-lookahead", "0"],
            // AMF: switch from cbr to vbr_latency for similar stability reasons.
            EncoderType::Amf => vec!["-quality", "speed", "-rc", "vbr_latency"],
            EncoderType::Qsv => vec!["-preset", "veryfast"],
            EncoderType::Software => vec!["-preset", "ultrafast", "-tune", "zerolatency"],
        }
    }

    pub fn name(&self) -> &str {
        match self {
            EncoderType::Nvenc => "NVIDIA NVENC",
            EncoderType::Amf => "AMD AMF",
            EncoderType::Qsv => "Intel Quick Sync",
            EncoderType::Software => "Software (libx264)",
        }
    }
}

/// Check if ffmpeg supports ddagrab (DXGI Desktop Duplication — works with fullscreen games).
/// Available in ffmpeg 7.0+ on Windows.
pub fn has_ddagrab() -> bool {
    let output = Command::new(crate::ffmpeg_bin())
        .args(["-hide_banner", "-filters"])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .output();

    match output {
        Ok(out) => {
            let filters = String::from_utf8_lossy(&out.stdout);
            filters.contains("ddagrab")
        }
        Err(_) => false,
    }
}

/// Probe which hardware encoder is available by running ffmpeg -encoders.
pub fn detect_best_encoder() -> EncoderType {
    let output = Command::new(crate::ffmpeg_bin())
        .args(["-hide_banner", "-encoders"])
        .output();

    match output {
        Ok(out) => {
            let encoders = String::from_utf8_lossy(&out.stdout);
            if encoders.contains("h264_nvenc") {
                EncoderType::Nvenc
            } else if encoders.contains("h264_amf") {
                EncoderType::Amf
            } else if encoders.contains("h264_qsv") {
                EncoderType::Qsv
            } else {
                EncoderType::Software
            }
        }
        Err(_) => EncoderType::Software,
    }
}

// ============================================================
// RECORDING MANAGER
// ============================================================

/// Platform-dependent capture handle held alongside the ffmpeg Child.
/// On Windows this is an optional `capture::ActiveCapture` (None on the GDI
/// fallback path). On other platforms it's a unit placeholder.
#[cfg(target_os = "windows")]
type OptCapture = Option<capture::ActiveCapture>;
#[cfg(not(target_os = "windows"))]
type OptCapture = ();

pub struct RecordingManager {
    config: RecordingConfig,
    status: Arc<RwLock<RecordingStatus>>,
    active_process: Option<Child>,
    encoder: EncoderType,
    /// Preferred capture path. `true` = Windows.Graphics.Capture via `capture.rs`
    /// (TDR-safe, works on any GPU incl. integrated). `false` = legacy gdigrab
    /// fallback for pre-1903 Windows or when WGC init fails.
    use_wgc: bool,
    /// Primary monitor size detected at startup — passed to ffmpeg as
    /// `-video_size WxH` when using the WGC rawvideo pipeline.
    monitor_size: (u32, u32),
    /// Active WGC capture session, when `use_wgc` is true and a recording is running.
    #[cfg(target_os = "windows")]
    active_capture: Option<capture::ActiveCapture>,
    /// How many times we've auto-restarted ffmpeg for the current recording
    early_restart_count: u32,
    /// Instant when current recording started (for early-crash detection)
    recording_started: Option<Instant>,
    /// Instant when the current ffmpeg process was last (re)spawned. Used to
    /// reset `early_restart_count` after the process has been stable for a while.
    last_spawn_at: Option<Instant>,
    /// Rolling buffer of recent ffmpeg stderr lines. Drained by a background
    /// thread per spawn — prevents the stderr pipe from filling up and
    /// deadlocking ffmpeg mid-recording (the main symptom of "recording
    /// cancels after some time while playing").
    stderr_log: Arc<Mutex<VecDeque<String>>>,
}

/// Spawn a thread that continuously reads ffmpeg's stderr line-by-line.
///
/// Why this matters: on Windows, anonymous pipes have small kernel buffers
/// (~4 KB). If ffmpeg writes warnings/errors faster than we read, the pipe
/// fills, write() blocks, and ffmpeg hangs in the middle of encoding —
/// effectively cancelling the recording.
///
/// Each line is logged via `log::warn!` (so it shows up in dev.log) and
/// pushed into `buf` (capped at STDERR_BUFFER_LINES) for crash diagnostics.
fn spawn_stderr_drain(stderr: ChildStderr, buf: Arc<Mutex<VecDeque<String>>>) {
    thread::spawn(move || {
        let reader = BufReader::new(stderr);
        for line in reader.lines() {
            match line {
                Ok(text) => {
                    let trimmed = text.trim();
                    if trimmed.is_empty() {
                        continue;
                    }
                    log::warn!("ffmpeg: {trimmed}");
                    if let Ok(mut b) = buf.lock() {
                        if b.len() >= STDERR_BUFFER_LINES {
                            b.pop_front();
                        }
                        b.push_back(trimmed.to_string());
                    }
                }
                Err(_) => break, // pipe closed = ffmpeg exited
            }
        }
    });
}

/// Snapshot the recent stderr lines as a single string for crash diagnostics.
fn snapshot_stderr(buf: &Arc<Mutex<VecDeque<String>>>) -> String {
    buf.lock()
        .map(|b| b.iter().cloned().collect::<Vec<_>>().join("\n"))
        .unwrap_or_default()
}

/// Platform-polymorphic helper: stop an in-progress capture if we have one.
/// No-op on non-Windows or GDI fallback.
#[cfg(target_os = "windows")]
fn stop_capture(cap: OptCapture) {
    if let Some(c) = cap {
        c.stop();
    }
}
#[cfg(not(target_os = "windows"))]
fn stop_capture(_cap: OptCapture) {}

impl RecordingManager {
    pub fn new(config: RecordingConfig) -> Self {
        // Create output directory
        let _ = std::fs::create_dir_all(&config.output_dir);

        let encoder = detect_best_encoder();

        // Decide capture path. WGC is preferred because it does not trigger
        // Windows TDR on D3D fullscreen-exclusive games (which gdigrab does).
        // Vanguard does not block WGC — OBS, Medal, and Shadowplay all use it
        // for Valorant.
        #[cfg(target_os = "windows")]
        let (use_wgc, monitor_size) = {
            let supported = capture::is_supported();
            let size = capture::primary_monitor_size().unwrap_or((1920, 1080));
            if supported {
                log::info!(
                    "Capture method: Windows.Graphics.Capture (primary monitor {}×{})",
                    size.0,
                    size.1
                );
                (true, size)
            } else {
                log::warn!(
                    "Capture method: gdigrab fallback — WGC unsupported on this Windows build. \
                     For best stability, set Valorant → Video → Display Mode → Windowed Fullscreen."
                );
                (false, size)
            }
        };
        #[cfg(not(target_os = "windows"))]
        let (use_wgc, monitor_size) = (false, (1920u32, 1080u32));

        log::info!("Recording encoder: {}", encoder.name());

        Self {
            config,
            status: Arc::new(RwLock::new(RecordingStatus::default())),
            active_process: None,
            encoder,
            use_wgc,
            monitor_size,
            #[cfg(target_os = "windows")]
            active_capture: None,
            early_restart_count: 0,
            recording_started: None,
            last_spawn_at: None,
            stderr_log: Arc::new(Mutex::new(VecDeque::with_capacity(STDERR_BUFFER_LINES))),
        }
    }

    /// Check if ffmpeg is available in PATH.
    pub fn check_ffmpeg() -> bool {
        Command::new(crate::ffmpeg_bin())
            .args(["-version"])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    }

    /// Build the ffmpeg input args. For WGC mode we read raw BGRA from stdin.
    /// For the GDI fallback path we read from `gdigrab desktop`.
    fn build_input_args(&self) -> Vec<String> {
        let mut args: Vec<String> = vec![
            "-hide_banner".into(),
            "-loglevel".into(),
            "warning".into(),
            // Large input buffer absorbs bursty captures so a single slow read
            // doesn't drop the input stream.
            "-rtbufsize".into(),
            "200M".into(),
        ];

        if self.use_wgc {
            // WGC path: frames arrive from our Rust capture thread on stdin.
            // `-framerate` sets the authoritative playback rate (handler drops
            // frames above this rate). `-video_size` must match actual capture.
            let (w, h) = self.monitor_size;
            args.extend([
                "-f".into(),
                "rawvideo".into(),
                "-pix_fmt".into(),
                "bgra".into(),
                "-video_size".into(),
                format!("{w}x{h}"),
                "-framerate".into(),
                self.config.framerate.to_string(),
                // Larger queue — WGC writes can burst.
                "-thread_queue_size".into(),
                "1024".into(),
                "-i".into(),
                "pipe:0".into(),
            ]);
        } else {
            // GDI fallback — only truly stable with borderless windowed games.
            args.extend([
                "-f".into(),
                "gdigrab".into(),
                "-framerate".into(),
                self.config.framerate.to_string(),
                "-i".into(),
                "desktop".into(),
            ]);
        }
        args
    }

    /// Spawn ffmpeg with only the primary output (no analysis copy).
    /// Used as fallback when dual-output fails (e.g. GPU can't handle 2 NVENC sessions).
    fn spawn_ffmpeg_single(&self, output_path: &Path) -> Result<Child, RecordingError> {
        let bitrate_kbps = (self.config.bitrate_mbps * 1000.0) as u32;
        let bitrate = format!("{bitrate_kbps}k");
        // Cap at 1.5x target so VBR has headroom during fast scenes without runaway file sizes.
        let maxrate = format!("{}k", (bitrate_kbps as f32 * 1.5) as u32);
        let bufsize = format!("{}k", bitrate_kbps * 2);
        let res_h = self.config.resolution_height;
        let res_w = (res_h * 16 / 9) & !1;

        let mut args = self.build_input_args();

        args.extend([
            "-vf".into(),
            format!("scale={res_w}:{res_h}"),
            "-c:v".into(),
            self.encoder.ffmpeg_codec().to_string(),
        ]);

        for arg in self.encoder.extra_args() {
            args.push(arg.to_string());
        }

        args.extend([
            "-b:v".into(),
            bitrate,
            "-maxrate".into(),
            maxrate,
            "-bufsize".into(),
            bufsize,
            "-g".into(),
            "120".into(),
            // Generate PTS to keep timestamps monotonic when capture hiccups
            "-fflags".into(),
            "+genpts".into(),
            // Safety cap only — no longer artificially terminates a normal session.
            "-t".into(),
            MAX_RECORDING_SECONDS.to_string(),
            "-an".into(),
            output_path.to_string_lossy().to_string(),
        ]);

        let mut cmd = Command::new(crate::ffmpeg_bin());
        cmd.args(&args)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::piped());

        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NEW_PROCESS_GROUP: u32 = 0x00000200;
            cmd.creation_flags(CREATE_NEW_PROCESS_GROUP);
        }

        let mut child = cmd
            .spawn()
            .map_err(|e| RecordingError::StartFailed(e.to_string()))?;

        // Drain stderr in a background thread to prevent pipe deadlock.
        if let Some(stderr) = child.stderr.take() {
            spawn_stderr_drain(stderr, Arc::clone(&self.stderr_log));
        }

        log::info!(
            "ffmpeg spawned single-output (PID {}), encoder={}",
            child.id(),
            self.encoder.name()
        );
        Ok(child)
    }

    /// Spawn ffmpeg (via `spawner`) and, if we're in WGC mode on Windows,
    /// attach a live capture session to its stdin. Returns the ffmpeg child
    /// and the capture handle (Windows-only; `None` on other platforms or GDI
    /// fallback). On failure, the partial ffmpeg process is killed.
    fn spawn_with_capture<F>(&self, spawner: F) -> Result<(Child, OptCapture), RecordingError>
    where
        F: FnOnce(&Self) -> Result<Child, RecordingError>,
    {
        let mut child = spawner(self)?;

        #[cfg(target_os = "windows")]
        {
            if self.use_wgc {
                let stdin = match child.stdin.take() {
                    Some(s) => s,
                    None => {
                        let _ = child.kill();
                        let _ = child.wait();
                        return Err(RecordingError::StartFailed(
                            "ffmpeg stdin handle unavailable".into(),
                        ));
                    }
                };
                match capture::start_primary_monitor_capture(stdin, self.config.framerate) {
                    Ok(cap) => return Ok((child, Some(cap))),
                    Err(e) => {
                        log::error!("WGC capture start failed: {e}");
                        let _ = child.kill();
                        let _ = child.wait();
                        return Err(RecordingError::StartFailed(format!("WGC init: {e}")));
                    }
                }
            }
            Ok((child, None))
        }
        #[cfg(not(target_os = "windows"))]
        {
            Ok((child, ()))
        }
    }

    /// Start recording the screen to a new file.
    pub fn start_recording(&mut self) -> Result<String, RecordingError> {
        if self.get_status().is_recording {
            return Err(RecordingError::StartFailed("Already recording".into()));
        }

        if !Self::check_ffmpeg() {
            return Err(RecordingError::FfmpegNotFound);
        }

        let match_id = Uuid::new_v4().to_string();
        let file_name = format!("{}.mp4", match_id);
        let file_path = self.config.output_dir.join(&file_name);

        // Fresh recording — clear any stderr lines left over from a previous session.
        if let Ok(mut buf) = self.stderr_log.lock() {
            buf.clear();
        }

        // Try dual-output first (primary + analysis copy), fall back to single-output.
        // After spawning, wait 1.5s to detect immediate ffmpeg crashes (e.g. GPU can't
        // handle 2 NVENC sessions). If it crashes, retry with single-output.
        let (mut child, mut active_capture) =
            self.spawn_with_capture(|s| s.spawn_ffmpeg(&file_path))?;

        std::thread::sleep(std::time::Duration::from_millis(1500));
        if let Ok(Some(exit)) = child.try_wait() {
            // ffmpeg exited immediately — dual output likely failed.
            let err_snapshot = snapshot_stderr(&self.stderr_log);
            if !err_snapshot.is_empty() {
                log::error!("Dual-output ffmpeg stderr: {err_snapshot}");
            }
            log::warn!(
                "Dual-output ffmpeg crashed immediately ({exit}) — falling back to single-output"
            );

            // Stop the dual-output capture session before respawning.
            stop_capture(active_capture);

            // Clean up incomplete files
            let _ = std::fs::remove_file(&file_path);
            let _ = std::fs::remove_file(&Self::analysis_copy_path(&file_path));
            if let Ok(mut buf) = self.stderr_log.lock() {
                buf.clear();
            }

            let (c, cap2) = self.spawn_with_capture(|s| s.spawn_ffmpeg_single(&file_path))?;
            child = c;
            active_capture = cap2;
            // Brief check on fallback too
            std::thread::sleep(std::time::Duration::from_millis(500));
            if let Ok(Some(exit2)) = child.try_wait() {
                stop_capture(active_capture);
                let err2 = snapshot_stderr(&self.stderr_log);
                return Err(RecordingError::StartFailed(format!(
                    "ffmpeg exited immediately: {exit2}\n{err2}"
                )));
            }
        }

        // Write PID file for crash recovery
        write_pid_file(child.id());
        self.active_process = Some(child);
        #[cfg(target_os = "windows")]
        {
            self.active_capture = active_capture;
        }
        #[cfg(not(target_os = "windows"))]
        {
            let _ = active_capture;
        }
        self.early_restart_count = 0;
        let now = Instant::now();
        self.recording_started = Some(now);
        self.last_spawn_at = Some(now);

        let started_at = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;

        let mut st = self.status.write().unwrap_or_else(|e| e.into_inner());
        *st = RecordingStatus {
            is_recording: true,
            match_id: Some(match_id.clone()),
            file_path: Some(file_path.to_string_lossy().to_string()),
            analysis_copy_path: None, // Set after recording stops
            started_at_ms: Some(started_at),
            encoder_used: Some(self.encoder.name().to_string()),
            estimated_size_mb: 0.0,
        };

        log::info!("Recording started: {} ({})", match_id, self.encoder.name());
        Ok(match_id)
    }

    /// Build the analysis copy output path from the primary recording path.
    /// e.g. `/recordings/abc-123.mp4` → `/recordings/abc-123_analysis.mp4`
    fn analysis_copy_path(primary: &Path) -> PathBuf {
        let stem = primary
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("unknown");
        let parent = primary.parent().unwrap_or(primary);
        parent.join(format!("{stem}_analysis.mp4"))
    }

    fn spawn_ffmpeg(&self, output_path: &Path) -> Result<Child, RecordingError> {
        let bitrate_kbps = (self.config.bitrate_mbps * 1000.0) as u32;
        let bitrate = format!("{bitrate_kbps}k");
        let maxrate = format!("{}k", (bitrate_kbps as f32 * 1.5) as u32);
        let bufsize = format!("{}k", bitrate_kbps * 2);
        let analysis_path = Self::analysis_copy_path(output_path);
        let res_h = self.config.resolution_height;
        // Compute width maintaining 16:9 aspect ratio (must be even)
        let res_w = (res_h * 16 / 9) & !1; // e.g. 720→1280, 1080→1920

        let mut args = self.build_input_args();

        // ── Output 1: Primary recording (720p 60fps by default) ─────────────
        args.extend([
            "-map".into(),
            "0:v".into(),
            "-vf".into(),
            format!("scale={res_w}:{res_h}"),
            "-c:v".into(),
            self.encoder.ffmpeg_codec().to_string(),
        ]);

        // Add encoder-specific args for primary stream
        for arg in self.encoder.extra_args() {
            args.push(arg.to_string());
        }

        args.extend([
            "-b:v".into(),
            bitrate,
            "-maxrate".into(),
            maxrate.clone(),
            "-bufsize".into(),
            bufsize.clone(),
            "-g".into(),
            "120".into(), // Keyframe every 2s at 60fps — improves seek accuracy
            "-fflags".into(),
            "+genpts".into(),
            // Safety cap only — real stop comes from stop_recording. 6h ensures
            // a marathon session isn't cut short like the previous 1h limit did.
            "-t".into(),
            MAX_RECORDING_SECONDS.to_string(),
            "-an".into(), // No audio
            output_path.to_string_lossy().to_string(),
        ]);

        // ── Output 2: Analysis copy (1080p 2fps with burned timestamps) ─────
        // Uses a second NVENC session (modern GPUs support 2-3 simultaneous).
        // 2fps at 1080p keeps HUD text legible for server-side CV analysis.
        // Timestamps are burned so Gemini can read exact frame times.
        let analysis_encoder = match &self.encoder {
            // GPU encoders: use same family for analysis stream
            EncoderType::Nvenc => "h264_nvenc",
            EncoderType::Amf => "h264_amf",
            EncoderType::Qsv => "h264_qsv",
            // Software: use same libx264
            EncoderType::Software => "libx264",
        };

        // Analysis copy is always 1080p for legible HUD text (CV needs sharp digits)
        // 2fps balances death detection accuracy with reasonable file size (~20MB for 40-min game)
        // Analysis copy matches primary resolution — no upscale/downscale
        let analysis_vf = format!("fps=2,scale={res_w}:{res_h},drawtext=text='%{{pts\\:hms}}':fontsize=28:fontcolor=white:borderw=2:bordercolor=black:x=10:y=10");

        args.extend([
            "-map".into(),
            "0:v".into(),
            "-vf".into(),
            analysis_vf,
            "-c:v".into(),
            analysis_encoder.to_string(),
        ]);

        // Encoder-specific quality args for analysis stream (good quality for HUD legibility)
        match &self.encoder {
            EncoderType::Nvenc => {
                args.extend(["-preset".into(), "p1".into(), "-cq".into(), "25".into()])
            }
            EncoderType::Amf => args.extend([
                "-quality".into(),
                "speed".into(),
                "-rc".into(),
                "cqp".into(),
                "-qp".into(),
                "25".into(),
            ]),
            EncoderType::Qsv => args.extend([
                "-preset".into(),
                "veryfast".into(),
                "-global_quality".into(),
                "25".into(),
            ]),
            EncoderType::Software => args.extend([
                "-preset".into(),
                "ultrafast".into(),
                "-crf".into(),
                "25".into(),
            ]),
        }

        args.extend([
            "-t".into(),
            MAX_RECORDING_SECONDS.to_string(),
            "-an".into(),
            analysis_path.to_string_lossy().to_string(),
        ]);

        let mut cmd = Command::new(crate::ffmpeg_bin());
        cmd.args(&args)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::piped()); // capture errors for debugging

        // On Windows, create a new process group so we can send CTRL_BREAK_EVENT
        // to stop ffmpeg gracefully (piped stdin 'q' doesn't work on Windows).
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NEW_PROCESS_GROUP: u32 = 0x00000200;
            cmd.creation_flags(CREATE_NEW_PROCESS_GROUP);
        }

        let mut child = cmd
            .spawn()
            .map_err(|e| RecordingError::StartFailed(e.to_string()))?;

        // Drain stderr in a background thread — without this the pipe fills
        // and ffmpeg blocks mid-recording (the original "cancels after some
        // time while playing" symptom).
        if let Some(stderr) = child.stderr.take() {
            spawn_stderr_drain(stderr, Arc::clone(&self.stderr_log));
        }

        log::info!(
            "ffmpeg spawned with dual output (PID {}), encoder={}",
            child.id(),
            self.encoder.name()
        );
        log::info!("  Primary: {}", output_path.display());
        log::info!("  Analysis: {}", analysis_path.display());
        Ok(child)
    }

    /// Stop recording. Returns the path to the recorded file.
    pub fn stop_recording(&mut self) -> Result<String, RecordingError> {
        let mut child = self
            .active_process
            .take()
            .ok_or(RecordingError::NotRecording)?;
        let path = {
            let st = self.status.read().unwrap_or_else(|e| e.into_inner());
            st.file_path.clone().unwrap_or_default()
        };
        let analysis_path = Self::analysis_copy_path(std::path::Path::new(&path));

        // Gracefully stop ffmpeg so it finalizes the MP4 container (moov atom).
        // Without proper shutdown, the file is 0 bytes / corrupt.
        let pid = child.id();

        // Preferred path on Windows WGC: stop the capture thread, which drops
        // ffmpeg's stdin → ffmpeg sees EOF → flushes and exits cleanly. This is
        // more reliable than CTRL_BREAK (which we still use for the GDI
        // fallback where ffmpeg reads from gdigrab instead of stdin).
        #[cfg(target_os = "windows")]
        {
            if let Some(cap) = self.active_capture.take() {
                log::info!("Stopping WGC capture (will close ffmpeg stdin → EOF)");
                cap.stop();
            } else {
                extern "system" {
                    fn GenerateConsoleCtrlEvent(
                        dw_ctrl_event: u32,
                        dw_process_group_id: u32,
                    ) -> i32;
                }
                let result = unsafe { GenerateConsoleCtrlEvent(1, pid) }; // 1 = CTRL_BREAK_EVENT
                log::info!("Sent CTRL_BREAK to ffmpeg (PID {pid}), result={result}");
            }
        }

        #[cfg(not(target_os = "windows"))]
        {
            // On Unix, write 'q' to stdin — works fine with TTY emulation.
            if let Some(mut stdin) = child.stdin.take() {
                use std::io::Write;
                let _ = stdin.write_all(b"q\n");
                let _ = stdin.flush();
                drop(stdin);
            }
        }

        // Wait for ffmpeg to finalize, with a 10-second timeout.
        let deadline = Instant::now() + std::time::Duration::from_secs(10);
        loop {
            match child.try_wait() {
                Ok(Some(status)) => {
                    log::info!("ffmpeg exited: {status}");
                    break;
                }
                Ok(None) if Instant::now() < deadline => {
                    std::thread::sleep(std::time::Duration::from_millis(200));
                }
                Ok(None) => {
                    log::warn!("ffmpeg did not exit in 10s — force killing");
                    let _ = child.kill();
                    let _ = child.wait();
                    break;
                }
                Err(e) => {
                    log::warn!("ffmpeg wait error: {e}");
                    let _ = child.kill();
                    break;
                }
            }
        }

        // Log captured stderr (drained by background thread during recording).
        let err_snapshot = snapshot_stderr(&self.stderr_log);
        if !err_snapshot.is_empty() {
            log::info!("ffmpeg stderr (last lines):\n{err_snapshot}");
        }

        // Verify the primary file was written
        if let Ok(meta) = std::fs::metadata(&path) {
            log::info!("Recording file size: {} bytes", meta.len());
            if meta.len() == 0 {
                log::error!("Recording is 0 bytes! ffmpeg failed to finalize the MP4.");
            }
        } else {
            log::error!("Recording file not found: {path}");
        }

        // Verify analysis copy
        if let Ok(meta) = std::fs::metadata(&analysis_path) {
            log::info!(
                "Analysis copy size: {} bytes ({:.1} MB)",
                meta.len(),
                meta.len() as f64 / 1_048_576.0
            );
            if meta.len() == 0 {
                log::warn!(
                    "Analysis copy is 0 bytes — will fall back to post-recording compression"
                );
                let _ = std::fs::remove_file(&analysis_path);
            }
        } else {
            log::warn!(
                "Analysis copy not found: {} — dual output may have failed",
                analysis_path.display()
            );
        }

        // Clean up PID file
        remove_pid_file();
        self.recording_started = None;
        self.last_spawn_at = None;

        {
            let mut st = self.status.write().unwrap_or_else(|e| e.into_inner());
            st.is_recording = false;
            // Store analysis copy path if it exists and is valid
            if analysis_path.exists()
                && std::fs::metadata(&analysis_path)
                    .map(|m| m.len() > 0)
                    .unwrap_or(false)
            {
                st.analysis_copy_path = Some(analysis_path.to_string_lossy().to_string());
            }
        }

        // Enforce rolling buffer retention policy
        self.enforce_retention();

        log::info!("Recording stopped: {}", path);
        Ok(path)
    }

    /// Keep only the last N games within the disk size limit.
    fn enforce_retention(&self) {
        let result = buffer::enforce_rolling_buffer(
            &self.config.output_dir,
            self.config.max_games_kept as usize,
            self.config.max_disk_gb as u64 * 1024 * 1024 * 1024,
        );
        if let Err(e) = result {
            log::warn!("Retention policy error: {}", e);
        }
    }

    pub fn get_status(&self) -> RecordingStatus {
        self.status
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    /// Update file size from actual file on disk + check ffmpeg is alive.
    /// Returns Some(match_id) if ffmpeg crashed and could NOT be auto-restarted.
    /// Auto-restarts ffmpeg on transient crashes (GDI access denied, display
    /// mode changes when entering/leaving fullscreen, brief encoder hiccups).
    pub fn refresh_size_estimate(&mut self) -> Option<String> {
        // If we've been running stably for STABLE_RESTART_RESET_SECS, reset the
        // counter so a later burst of crashes doesn't permanently kill the recording.
        if let Some(spawned_at) = self.last_spawn_at {
            if self.early_restart_count > 0
                && spawned_at.elapsed().as_secs() >= STABLE_RESTART_RESET_SECS
            {
                log::info!(
                    "ffmpeg stable for >{}s — resetting restart counter (was {})",
                    STABLE_RESTART_RESET_SECS,
                    self.early_restart_count
                );
                self.early_restart_count = 0;
            }
        }

        // Check if ffmpeg is still running — if it died, try to recover
        if let Some(ref mut child) = self.active_process {
            match child.try_wait() {
                Ok(Some(exit)) => {
                    log::warn!("ffmpeg exited unexpectedly during recording: {exit}");
                    // Stderr was already captured by the background drain thread.
                    let err_snapshot = snapshot_stderr(&self.stderr_log);
                    if !err_snapshot.is_empty() {
                        log::error!("ffmpeg stderr at crash:\n{err_snapshot}");
                    }
                    self.active_process = None;
                    remove_pid_file();

                    // ── Auto-restart on crash ─────────────────────────────────
                    // GDI capture can fail intermittently (error 5 = access denied)
                    // when the display mode changes or the compositor hiccups.
                    // Restarting ffmpeg usually fixes it.
                    let can_restart = self.early_restart_count < MAX_RESTART_ATTEMPTS;

                    if can_restart {
                        self.early_restart_count += 1;
                        log::warn!(
                            "Recording crashed — auto-restarting ffmpeg (attempt {}/{})",
                            self.early_restart_count,
                            MAX_RESTART_ATTEMPTS
                        );

                        // Backoff: brief pause that grows slightly with each consecutive
                        // failure, capped at 8s. Lets the display compositor settle
                        // without making the user wait too long.
                        let backoff_secs = std::cmp::min(2 + self.early_restart_count as u64, 8);
                        std::thread::sleep(std::time::Duration::from_secs(backoff_secs));

                        // Clear stderr so the next snapshot reflects the new spawn only.
                        if let Ok(mut buf) = self.stderr_log.lock() {
                            buf.clear();
                        }

                        // Get the output path from status
                        let file_path = {
                            let st = self.status.read().unwrap_or_else(|e| e.into_inner());
                            st.file_path.clone()
                        };

                        if let Some(ref path) = file_path {
                            let output = Path::new(path);

                            // Any leftover WGC session from the pre-crash process is stale.
                            #[cfg(target_os = "windows")]
                            if let Some(cap) = self.active_capture.take() {
                                cap.stop();
                            }

                            // If the partial file is tiny (< 1MB), just delete it.
                            // Otherwise keep it — it has usable footage.
                            let partial_size =
                                std::fs::metadata(output).map(|m| m.len()).unwrap_or(0);
                            if partial_size < 1_048_576 {
                                let _ = std::fs::remove_file(output);
                                let _ = std::fs::remove_file(&Self::analysis_copy_path(output));
                            } else {
                                // Rename partial file so the restart can use the same path
                                let partial_name = format!(
                                    "{}_part{}.mp4",
                                    output
                                        .file_stem()
                                        .and_then(|s| s.to_str())
                                        .unwrap_or("unknown"),
                                    self.early_restart_count - 1
                                );
                                let partial_path =
                                    output.parent().unwrap_or(output).join(&partial_name);
                                let _ = std::fs::rename(output, &partial_path);
                                let _ = std::fs::remove_file(&Self::analysis_copy_path(output));
                                log::info!(
                                    "Saved partial recording: {} ({:.1} MB)",
                                    partial_name,
                                    partial_size as f64 / 1_048_576.0
                                );
                            }

                            // Try dual-output first, fall back to single. Each spawn
                            // re-attaches a WGC session (Windows) to the new process.
                            let spawn_result = self
                                .spawn_with_capture(|s| s.spawn_ffmpeg(output))
                                .or_else(|_| {
                                    self.spawn_with_capture(|s| s.spawn_ffmpeg_single(output))
                                });

                            match spawn_result {
                                Ok((new_child, cap)) => {
                                    write_pid_file(new_child.id());
                                    self.active_process = Some(new_child);
                                    #[cfg(target_os = "windows")]
                                    {
                                        self.active_capture = cap;
                                    }
                                    #[cfg(not(target_os = "windows"))]
                                    {
                                        let _ = cap;
                                    }
                                    self.last_spawn_at = Some(Instant::now());
                                    log::info!("ffmpeg restarted successfully");
                                    return None; // recovered — no crash to report
                                }
                                Err(e) => {
                                    log::error!("ffmpeg restart failed: {e}");
                                    // Fall through to crash handling below
                                }
                            }
                        }
                    } else {
                        log::error!(
                            "ffmpeg crashed {} times — exceeded max restart attempts ({})",
                            self.early_restart_count,
                            MAX_RESTART_ATTEMPTS
                        );
                    }

                    // Could not recover — mark as crashed
                    let mut st = self.status.write().unwrap_or_else(|e| e.into_inner());
                    let crashed_match_id = st.match_id.clone();
                    st.is_recording = false;
                    self.recording_started = None;
                    self.last_spawn_at = None;
                    return crashed_match_id;
                }
                Ok(None) => {} // still running — good
                Err(_) => {}
            }
        }

        // Read actual file size from disk
        let st = self.status.read().unwrap_or_else(|e| e.into_inner());
        if let Some(ref path) = st.file_path {
            if let Ok(meta) = std::fs::metadata(path) {
                drop(st);
                let mut st = self.status.write().unwrap_or_else(|e| e.into_inner());
                st.estimated_size_mb = meta.len() as f32 / 1_048_576.0;
            }
        }
        None
    }
}

// ============================================================
// CRASH RECOVERY
// ============================================================

fn pid_file_path() -> PathBuf {
    crate::app_data_dir().join("ffmpeg.pid")
}

fn write_pid_file(pid: u32) {
    let path = pid_file_path();
    if let Err(e) = std::fs::write(&path, pid.to_string()) {
        log::warn!("Failed to write PID file: {e}");
    }
}

fn remove_pid_file() {
    let path = pid_file_path();
    let _ = std::fs::remove_file(path);
}

/// Called on app startup to clean up orphan ffmpeg processes from a previous crash.
///
/// Reads the PID from `ffmpeg.pid`, checks if the process is still running,
/// and kills it gracefully. Also cleans up incomplete recordings (< 1 KB).
pub fn cleanup_orphan_ffmpeg() {
    let pid_path = pid_file_path();

    if let Ok(pid_str) = std::fs::read_to_string(&pid_path) {
        if let Ok(pid) = pid_str.trim().parse::<u32>() {
            log::warn!("Found orphan ffmpeg PID file (pid={pid}) — previous session crashed");

            // Check if this PID is still a running ffmpeg process
            let sys = sysinfo::System::new_all();
            let sysinfo_pid = sysinfo::Pid::from_u32(pid);
            if let Some(proc) = sys.processes().get(&sysinfo_pid) {
                let name = proc.name().to_string_lossy();
                if name.contains("ffmpeg") {
                    log::warn!("Orphan ffmpeg still running (PID {pid}) — killing");

                    #[cfg(target_os = "windows")]
                    {
                        extern "system" {
                            fn GenerateConsoleCtrlEvent(
                                dw_ctrl_event: u32,
                                dw_process_group_id: u32,
                            ) -> i32;
                        }
                        unsafe { GenerateConsoleCtrlEvent(1, pid) }; // CTRL_BREAK
                        std::thread::sleep(std::time::Duration::from_secs(3));

                        // Force kill if still alive
                        let sys2 = sysinfo::System::new_all();
                        if sys2.processes().contains_key(&sysinfo_pid) {
                            log::warn!("Orphan ffmpeg did not exit — force killing");
                            let _ = Command::new("taskkill")
                                .args(["/F", "/PID", &pid.to_string()])
                                .status();
                        }
                    }

                    #[cfg(not(target_os = "windows"))]
                    {
                        use std::os::unix::process::CommandExt;
                        let _ = Command::new("kill").arg(pid.to_string()).status();
                        std::thread::sleep(std::time::Duration::from_secs(3));
                        let _ = Command::new("kill").args(["-9", &pid.to_string()]).status();
                    }
                } else {
                    log::info!("PID {pid} is not ffmpeg (is '{name}') — stale PID file");
                }
            } else {
                log::info!("PID {pid} no longer running — stale PID file");
            }
        }

        // Always remove the PID file
        let _ = std::fs::remove_file(&pid_path);
    }

    // Clean up incomplete recordings (< 1 KB = corrupt/empty)
    let recordings_dir = crate::app_data_dir().join("recordings");
    if let Ok(entries) = std::fs::read_dir(&recordings_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) == Some("mp4") {
                if let Ok(meta) = std::fs::metadata(&path) {
                    if meta.len() < 1024 {
                        log::warn!("Removing incomplete recording: {}", path.display());
                        let _ = std::fs::remove_file(&path);
                    }
                }
            }
        }
    }

    // Clean up orphan analysis copies (primary deleted but analysis remains)
    if let Ok(entries) = std::fs::read_dir(&recordings_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("");
            if stem.ends_with("_analysis") {
                let primary_stem = &stem[..stem.len() - "_analysis".len()];
                let primary_path = path.with_file_name(format!("{primary_stem}.mp4"));
                if !primary_path.exists() {
                    log::warn!("Removing orphan analysis copy: {}", path.display());
                    let _ = std::fs::remove_file(&path);
                }
            }
        }
    }
}
