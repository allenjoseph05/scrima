//! Windows.Graphics.Capture (WGC) based screen capture.
//!
//! Why this exists: the previous `ffmpeg gdigrab` path triggers TDR
//! (Timeout Detection & Recovery) on Valorant fullscreen-exclusive mode,
//! causing the Windows graphics driver to reset. WGC is the modern,
//! compositor-aware API used by OBS, Medal.tv, and Shadowplay — it does
//! not stall the GPU under fullscreen-exclusive and is allowed by Vanguard
//! (Vanguard only blocks process-hooking Game Capture, not display-level WGC).
//!
//! Flow:
//!   1. Caller spawns ffmpeg with `-f rawvideo -pix_fmt bgra -i pipe:0`
//!   2. Caller hands us the ffmpeg ChildStdin handle + start_capture()
//!   3. WGC delivers BGRA frames on its own thread → we write them to stdin
//!   4. On stop(): capture session halts, stdin is dropped → ffmpeg flushes & exits
//!
//! This module is Windows-only; callers should guard with `cfg(target_os = "windows")`.

#![cfg(target_os = "windows")]

use std::io::Write;
use std::process::ChildStdin;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use windows_capture::{
    capture::{CaptureControl, Context, GraphicsCaptureApiHandler},
    frame::Frame,
    graphics_capture_api::InternalCaptureControl,
    monitor::Monitor,
    settings::{
        ColorFormat, CursorCaptureSettings, DirtyRegionSettings, DrawBorderSettings,
        MinimumUpdateIntervalSettings, SecondaryWindowSettings, Settings,
    },
};

#[derive(Debug, thiserror::Error)]
pub enum CaptureError {
    #[error("WGC monitor lookup failed: {0}")]
    Monitor(String),
    #[error("WGC session start failed: {0}")]
    Start(String),
    #[error("Win32 GetSystemMetrics returned invalid size")]
    BadDimensions,
}

/// Shared handle to ffmpeg's stdin. The capture thread writes frames through this
/// Mutex. On stop, the caller takes the ChildStdin out to force ffmpeg EOF.
pub type StdinSlot = Arc<Mutex<Option<ChildStdin>>>;

/// Values passed into the WGC handler constructor.
pub struct CaptureFlags {
    pub stdin: StdinSlot,
    /// Minimum interval between frames forwarded to ffmpeg. On a 144Hz monitor
    /// WGC may fire at 144fps — if ffmpeg is told `-framerate 60`, that would
    /// play back 2.4× real-time. We drop over-rate frames here to match the
    /// labelled rate. Set to `Duration::ZERO` to pass every frame through.
    pub min_frame_interval: Duration,
}

/// Per-session handler. One instance per capture; owned by the WGC runtime thread.
pub struct CaptureHandler {
    stdin: StdinSlot,
    min_frame_interval: Duration,
    last_forward_at: Option<Instant>,
    /// Reused per-frame scratch buffer — `Frame::as_nopadding_buffer` wants an
    /// external Vec it can copy into. We keep one around to avoid reallocating
    /// ~8 MB (1080p BGRA) on every frame.
    row_scratch: Vec<u8>,
    /// Total bytes successfully written (diagnostic only).
    bytes_written: u64,
    /// Dropped-frame counter (rate-limiting).
    dropped_for_rate: u64,
    /// True once we've logged a failed-write warning (avoid log spam).
    warned_broken_pipe: bool,
}

impl GraphicsCaptureApiHandler for CaptureHandler {
    type Flags = CaptureFlags;
    type Error = Box<dyn std::error::Error + Send + Sync>;

    fn new(ctx: Context<Self::Flags>) -> Result<Self, Self::Error> {
        log::info!(
            "WGC capture handler initialized (target interval {:?})",
            ctx.flags.min_frame_interval
        );
        Ok(CaptureHandler {
            stdin: ctx.flags.stdin,
            min_frame_interval: ctx.flags.min_frame_interval,
            last_forward_at: None,
            row_scratch: Vec::new(),
            bytes_written: 0,
            dropped_for_rate: 0,
            warned_broken_pipe: false,
        })
    }

    fn on_frame_arrived(
        &mut self,
        frame: &mut Frame,
        _capture_control: InternalCaptureControl,
    ) -> Result<(), Self::Error> {
        // Rate limiting: if a frame arrives before the minimum interval, skip it
        // so the output frame rate matches what ffmpeg thinks the rate is.
        if !self.min_frame_interval.is_zero() {
            let now = Instant::now();
            if let Some(prev) = self.last_forward_at {
                if now.duration_since(prev) < self.min_frame_interval {
                    self.dropped_for_rate = self.dropped_for_rate.saturating_add(1);
                    return Ok(());
                }
            }
            self.last_forward_at = Some(now);
        }

        // Extract the raw BGRA bytes with no row padding so ffmpeg can ingest them
        // as a contiguous rawvideo stream. as_nopadding_buffer writes into our
        // reusable scratch buffer (avoids per-frame allocation).
        let buffer = frame.buffer()?;
        let data = buffer.as_nopadding_buffer(&mut self.row_scratch);

        // Lock the stdin slot and write. If stdin was taken (stop() called)
        // or ffmpeg crashed, writes fail — we drop the frame silently after
        // warning once to avoid spamming the log.
        if let Ok(mut guard) = self.stdin.lock() {
            if let Some(stdin) = guard.as_mut() {
                match stdin.write_all(data) {
                    Ok(()) => {
                        self.bytes_written = self.bytes_written.saturating_add(data.len() as u64);
                    }
                    Err(e) => {
                        if !self.warned_broken_pipe {
                            log::warn!("WGC→ffmpeg pipe write failed (first occurrence): {e}");
                            self.warned_broken_pipe = true;
                        }
                    }
                }
            }
        }
        Ok(())
    }

    fn on_closed(&mut self) -> Result<(), Self::Error> {
        log::info!(
            "WGC capture closed: {} bytes forwarded, {} frames dropped for rate limit",
            self.bytes_written,
            self.dropped_for_rate
        );
        Ok(())
    }
}

/// Live capture. Dropping it stops the session.
pub struct ActiveCapture {
    control: Option<CaptureControl<CaptureHandler, Box<dyn std::error::Error + Send + Sync>>>,
    /// Shared stdin slot — caller uses this to force EOF on ffmpeg when stopping.
    stdin_slot: StdinSlot,
}

impl ActiveCapture {
    /// Stop the capture thread and force-close ffmpeg's stdin so ffmpeg flushes
    /// its output and exits cleanly. Safe to call multiple times.
    pub fn stop(mut self) {
        if let Some(ctl) = self.control.take() {
            if let Err(e) = ctl.stop() {
                log::warn!("WGC session stop returned error: {e:?}");
            }
        }
        // Drop the stdin so ffmpeg sees EOF and finalizes the MP4.
        if let Ok(mut guard) = self.stdin_slot.lock() {
            let _ = guard.take();
        }
    }
}

impl Drop for ActiveCapture {
    fn drop(&mut self) {
        if let Some(ctl) = self.control.take() {
            let _ = ctl.stop();
        }
        if let Ok(mut guard) = self.stdin_slot.lock() {
            let _ = guard.take();
        }
    }
}

/// Primary monitor resolution via Win32 — used to build the ffmpeg `-video_size` arg.
/// Doesn't need WGC to be available; safe to call early.
pub fn primary_monitor_size() -> Result<(u32, u32), CaptureError> {
    extern "system" {
        fn GetSystemMetrics(n_index: i32) -> i32;
    }
    const SM_CXSCREEN: i32 = 0;
    const SM_CYSCREEN: i32 = 1;
    let (w, h) = unsafe { (GetSystemMetrics(SM_CXSCREEN), GetSystemMetrics(SM_CYSCREEN)) };
    if w <= 0 || h <= 0 {
        return Err(CaptureError::BadDimensions);
    }
    Ok((w as u32, h as u32))
}

/// Best-effort probe of WGC availability. WGC needs Windows 10 1903+.
/// We test by asking for the primary monitor — if that succeeds, WGC is usable.
pub fn is_supported() -> bool {
    Monitor::primary().is_ok()
}

/// Begin capturing the primary monitor and stream BGRA frames to `ffmpeg_stdin`.
/// `target_fps` throttles the handler so high-refresh monitors (144/240 Hz)
/// don't over-pump a stream that ffmpeg thinks is 60 fps.
///
/// The returned handle owns the capture session; call `.stop()` (or drop it) to end.
pub fn start_primary_monitor_capture(
    ffmpeg_stdin: ChildStdin,
    target_fps: u32,
) -> Result<ActiveCapture, CaptureError> {
    let monitor = Monitor::primary().map_err(|e| CaptureError::Monitor(format!("{e:?}")))?;

    let stdin_slot: StdinSlot = Arc::new(Mutex::new(Some(ffmpeg_stdin)));
    let min_interval = if target_fps == 0 {
        Duration::ZERO
    } else {
        // Slightly under the nominal interval so small scheduling jitter doesn't
        // cause us to drop frames we should have kept. (e.g. 60fps → 15ms not 16.67)
        let nanos = 1_000_000_000u64 / target_fps as u64;
        Duration::from_nanos(nanos.saturating_sub(2_000_000))
    };

    let flags = CaptureFlags {
        stdin: Arc::clone(&stdin_slot),
        min_frame_interval: min_interval,
    };

    // D3D11 native is BGRA; keep that all the way to ffmpeg to avoid conversion.
    // Default cursor setting = cursor included (matches gdigrab behaviour).
    // Default border setting = yellow border on Win10; invisible to recording output
    // but visible on the player's screen. On Win11 it can be removed with
    // DrawBorderSettings::WithoutBorder (+ manifest capability). Left at Default
    // for compatibility.
    let settings = Settings::new(
        monitor,
        CursorCaptureSettings::Default,
        DrawBorderSettings::Default,
        SecondaryWindowSettings::Default,
        MinimumUpdateIntervalSettings::Default,
        DirtyRegionSettings::Default,
        ColorFormat::Bgra8,
        flags,
    );

    let control = CaptureHandler::start_free_threaded(settings)
        .map_err(|e| CaptureError::Start(format!("{e:?}")))?;

    log::info!("WGC capture started (primary monitor, BGRA8)");
    Ok(ActiveCapture {
        control: Some(control),
        stdin_slot,
    })
}
