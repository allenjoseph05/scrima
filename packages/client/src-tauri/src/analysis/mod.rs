/// Analysis Pipeline — Full-Game Coaching
///
/// Two pipelines:
///   **New (frame-based):** extract thumbnails → ONNX classification → detect deaths
///     → extract high-res death frames → upload frames + metadata → poll → clips
///   **Legacy (video-based):** compress recording → upload video → poll → clips → enrichment
///
/// The new pipeline is used when the classifier model is present on disk.
/// Falls back to the legacy pipeline automatically if the model is absent.
///
/// Triggered from the frontend after `scrima:game-session-end` is received.
/// Runs in a background tokio task and emits progress events.
pub mod clips;
pub mod trend;
pub mod vlm;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::Emitter;
use tauri::Manager;
use thiserror::Error;

use crate::network::api_client::ApiClient;
use crate::storage::{DeepCoachingReportRow, MatchRow};
use crate::AppState;

/// How long to wait between job polls (5 seconds)
const POLL_INTERVAL_MS: u64 = 5_000;
/// Maximum polls before giving up (~35 minutes at 5s intervals).
/// Raised from 180 (15 min) because Gemma 4 free tier is ~3× slower than
/// paid Gemini: an 18-death match can take 20–25 min on throttled days
/// but still completes successfully server-side. Old 15-min cap caused
/// the UI to show "stuck" while reports finished and saved to DB —
/// confusing users into clicking Analyze again. 35 min leaves buffer.
const MAX_POLLS: u32 = 420;
/// Thumbnail extraction fps for ONNX classification.
/// 2 fps catches deaths where the death screen is only visible for 1-2
/// seconds (short pistol-shot kills, quick scope outplays) — 1 fps could
/// miss them entirely since DEATH_CONFIRM_FRAMES=2 requires two consecutive
/// death_screen frames. At 2 fps, detection window is 1.0 s, still safely
/// inside the 2-3 s that a real death screen stays visible in Valorant.
const THUMBNAIL_FPS: f64 = 2.0;
/// Short high-FPS pass around each coarse death candidate. The state classifier
/// is only a candidate generator; this pass finds the first death-screen
/// transition so post-death body/animation frames do not become "decision"
/// evidence.
const DEATH_REFINE_FPS: f64 = 8.0;
const DEATH_REFINE_LOOKBACK_SEC: f64 = 2.5;
const DEATH_REFINE_LOOKAHEAD_SEC: f64 = 1.0;

#[derive(Debug, Clone)]
struct RefinedDeath {
    timestamp_sec: f64,
    candidate_timestamp_sec: f64,
    frame_index: usize,
    confidence: f32,
    onset_confidence: f32,
    refinement_quality: &'static str,
    last_alive_sec: Option<f64>,
    first_death_sec: Option<f64>,
    decision_anchor_sec: f64,
}

#[derive(Debug, Error)]
pub enum AnalysisError {
    #[error("Database: {0}")]
    Database(String),
    #[error("Match not found: {0}")]
    NotFound(String),
    #[error("Network: {0}")]
    Network(String),
    #[error("Cancelled by user")]
    Cancelled,
}

impl From<crate::storage::StorageError> for AnalysisError {
    fn from(e: crate::storage::StorageError) -> Self {
        Self::Database(e.to_string())
    }
}

// ============================================================
// FULL-GAME ANALYSIS PIPELINE
// ============================================================

/// Run the full-game analysis pipeline.
///
/// Checks for the ONNX classifier model on disk:
///   - Present  → new frame-based pipeline (Phase C/D)
///   - Absent   → legacy video upload pipeline (backwards compatible)
pub async fn run_full_game_analysis(
    match_id: String,
    app_handle: tauri::AppHandle,
    all_events: Vec<serde_json::Value>,
    cancel: Option<Arc<AtomicBool>>,
    agent_override: Option<String>,
    map_override: Option<String>,
) -> Result<(), AnalysisError> {
    log::info!("Full game analysis starting: {match_id}");

    let is_cancelled = || -> bool { cancel.as_ref().map_or(false, |c| c.load(Ordering::Relaxed)) };

    // 1. Load match from DB
    let match_row = {
        let state = app_handle.state::<AppState>();
        let db = state
            .db
            .lock()
            .map_err(|e| AnalysisError::Database(e.to_string()))?;
        db.get_match(&match_id)?
            .ok_or_else(|| AnalysisError::NotFound(match_id.clone()))?
    };

    let recording_path = match match_row.recording_path.as_deref() {
        Some(p) if !p.is_empty() => p.to_string(),
        _ => {
            log::warn!("No recording for {match_id} — skipping analysis");
            return Err(AnalysisError::NotFound("recording_path".into()));
        }
    };

    // 1b. If no events passed in, load from SQLite (re-analysis of existing match)
    let all_events = if all_events.is_empty() {
        log::info!("No live events for {match_id} — loading from DB");
        let loaded = {
            let state = app_handle.state::<AppState>();
            let db = state
                .db
                .lock()
                .map_err(|e| AnalysisError::Database(e.to_string()))?;
            db.get_events_for_match(&match_id).unwrap_or_default()
        };
        if loaded.is_empty() {
            log::info!("No stored events for {match_id}");
            vec![]
        } else {
            log::info!("Loaded {} stored events for {match_id}", loaded.len());
            let match_start = match_row.started_at;
            loaded
                .iter()
                .map(|e| {
                    let rel_ms = (e.timestamp_ms - match_start).max(0) as u64;
                    let rel_secs = rel_ms / 1000;
                    let data: serde_json::Value =
                        serde_json::from_str(&e.data).unwrap_or(serde_json::json!({}));
                    serde_json::json!({
                        "event_type_id": e.event_type_id,
                        "timestamp_ms": rel_ms,
                        "offset_seconds": rel_secs,
                        "confidence": e.confidence,
                        "data": data,
                    })
                })
                .collect()
        }
    } else {
        all_events
    };

    // 2. Mark as processing
    {
        let state = app_handle.state::<AppState>();
        let db = state
            .db
            .lock()
            .map_err(|e| AnalysisError::Database(e.to_string()))?;
        let _ = db.update_analysis_status(&match_id, "processing");
    }

    if is_cancelled() {
        mark_analysis_reset(&match_id, &app_handle);
        return Err(AnalysisError::Cancelled);
    }

    // 3. Choose pipeline: new frame-based or legacy video upload
    let app_data = crate::app_data_dir();
    let classifier_available = app_data
        .join("models")
        .join("valorant-classifier.onnx")
        .exists();

    if classifier_available {
        log::info!("Classifier model found — using frame-based pipeline for {match_id}");
        run_frame_pipeline(
            match_id,
            match_row,
            recording_path,
            all_events,
            app_handle,
            cancel,
            agent_override,
            map_override,
        )
        .await
    } else {
        log::info!("Classifier model not found — using legacy video pipeline for {match_id}");
        run_legacy_pipeline(
            match_id,
            match_row,
            recording_path,
            all_events,
            app_handle,
            cancel,
            agent_override,
            map_override,
        )
        .await
    }
}

// ============================================================
// NEW FRAME-BASED PIPELINE (Phase C/D)
// ============================================================

fn fallback_refined_death(
    d: &crate::classification::DetectedDeath,
    game_start_sec: f64,
) -> RefinedDeath {
    RefinedDeath {
        timestamp_sec: d.timestamp_sec,
        candidate_timestamp_sec: d.timestamp_sec,
        frame_index: d.frame_index,
        confidence: d.confidence,
        onset_confidence: d.confidence,
        refinement_quality: "fallback",
        last_alive_sec: None,
        first_death_sec: None,
        decision_anchor_sec: (d.timestamp_sec - 2.0).max(game_start_sec),
    }
}

fn refine_death_onsets(
    recording_path: &str,
    candidates: &[crate::classification::DetectedDeath],
    game_start_sec: f64,
    app_data_dir: &std::path::Path,
) -> Vec<RefinedDeath> {
    let Some(mut classifier) = crate::classification::FrameClassifier::load(app_data_dir) else {
        log::warn!("Death onset refinement skipped: classifier failed to reload");
        return candidates
            .iter()
            .map(|d| fallback_refined_death(d, game_start_sec))
            .collect();
    };

    let mut refined = Vec::with_capacity(candidates.len());
    for d in candidates {
        let window_start = (d.timestamp_sec - DEATH_REFINE_LOOKBACK_SEC).max(game_start_sec);
        let window_duration = DEATH_REFINE_LOOKBACK_SEC + DEATH_REFINE_LOOKAHEAD_SEC;
        let frames = match clips::extract_window_thumbnails_rgb(
            std::path::Path::new(recording_path),
            window_start,
            window_duration,
            DEATH_REFINE_FPS,
        ) {
            Ok(frames) => frames,
            Err(e) => {
                log::warn!(
                    "Death onset refinement failed to extract window at {:.2}s: {e}",
                    d.timestamp_sec
                );
                refined.push(fallback_refined_death(d, game_start_sec));
                continue;
            }
        };

        let mut classified: Vec<(f64, String, f32)> = Vec::with_capacity(frames.len());
        for frame in frames {
            match classifier.classify_rgb(&frame.rgb_bytes) {
                Ok((class, conf)) => classified.push((frame.timestamp_sec, class, conf)),
                Err(e) => {
                    log::warn!("Death onset refinement classification failed: {e}");
                }
            }
        }

        let is_death_like = |idx: usize, rows: &[(f64, String, f32)]| -> bool {
            rows.get(idx)
                .map(|(_, class, conf)| class == "death_screen" && *conf >= 0.45)
                .unwrap_or(false)
        };

        let first_death_idx = (0..classified.len()).find(|&i| {
            if !is_death_like(i, &classified) {
                return false;
            }
            // Require one more death-like frame very near the first one. At 8fps
            // this still allows fast transitions while filtering single-frame
            // red-vignette or scoreboard mistakes.
            ((i + 1)..=((i + 3).min(classified.len().saturating_sub(1))))
                .any(|j| is_death_like(j, &classified))
        });

        let Some(first_idx) = first_death_idx else {
            refined.push(fallback_refined_death(d, game_start_sec));
            continue;
        };

        let last_alive = classified[..first_idx]
            .iter()
            .rev()
            .find(|(_, class, conf)| class == "gameplay" && *conf >= 0.40)
            .map(|(sec, _, _)| *sec);

        let first_death_sec = classified[first_idx].0;
        let onset_confidence = {
            let mut probs = vec![classified[first_idx].2];
            for j in (first_idx + 1)..=((first_idx + 3).min(classified.len().saturating_sub(1))) {
                if is_death_like(j, &classified) {
                    probs.push(classified[j].2);
                }
            }
            probs.iter().sum::<f32>() / probs.len() as f32
        };

        let refinement_quality = if last_alive.is_some() && onset_confidence >= 0.65 {
            "high"
        } else if last_alive.is_some() {
            "medium"
        } else {
            "low"
        };

        refined.push(RefinedDeath {
            timestamp_sec: first_death_sec,
            candidate_timestamp_sec: d.timestamp_sec,
            frame_index: d.frame_index,
            confidence: d.confidence.max(onset_confidence),
            onset_confidence,
            refinement_quality,
            last_alive_sec: last_alive,
            first_death_sec: Some(first_death_sec),
            decision_anchor_sec: (first_death_sec - 2.0).max(game_start_sec),
        });
    }

    refined
}

async fn run_frame_pipeline(
    match_id: String,
    match_row: MatchRow,
    recording_path: String,
    all_events: Vec<serde_json::Value>,
    app_handle: tauri::AppHandle,
    cancel: Option<Arc<AtomicBool>>,
    agent_override: Option<String>,
    map_override: Option<String>,
) -> Result<(), AnalysisError> {
    let is_cancelled = || -> bool { cancel.as_ref().map_or(false, |c| c.load(Ordering::Relaxed)) };

    // ── Step 1: Extract thumbnails at 1fps ──────────────────────────────────
    emit(
        &app_handle,
        "scrima:analysis-progress",
        serde_json::json!({
            "matchId": match_id,
            "stage": "extracting",
            "percent": 5,
            "detail": "Extracting thumbnails from recording...",
        }),
    );

    let rec_path_clone = recording_path.clone();
    let thumbnail_result = tokio::task::spawn_blocking(move || {
        clips::extract_thumbnails_rgb(std::path::Path::new(&rec_path_clone), THUMBNAIL_FPS)
    })
    .await;

    let thumbnails = match thumbnail_result {
        Ok(Ok(frames)) => frames,
        Ok(Err(e)) => {
            log::error!("Thumbnail extraction failed: {e}");
            mark_analysis_failed(&match_id, &app_handle, &e.to_string());
            return Err(AnalysisError::Network(e.to_string()));
        }
        Err(e) => {
            log::error!("spawn_blocking failed for thumbnails: {e}");
            mark_analysis_failed(&match_id, &app_handle, &e.to_string());
            return Err(AnalysisError::Database(e.to_string()));
        }
    };

    if is_cancelled() {
        mark_analysis_reset(&match_id, &app_handle);
        return Err(AnalysisError::Cancelled);
    }

    log::info!("Extracted {} thumbnails for {match_id}", thumbnails.len());

    // ── Step 2: ONNX classification ─────────────────────────────────────────
    emit(
        &app_handle,
        "scrima:analysis-progress",
        serde_json::json!({
            "matchId": match_id,
            "stage": "classifying",
            "percent": 15,
            "detail": "Classifying frames to detect deaths...",
        }),
    );

    let app_data = crate::app_data_dir();
    let ah = app_handle.clone();
    let mid = match_id.clone();
    let classify_result = tokio::task::spawn_blocking(move || {
        let classifier = crate::classification::FrameClassifier::load(&app_data);
        match classifier {
            Some(mut c) => {
                let result = c.classify_and_detect_deaths_with_progress(
                    &thumbnails,
                    THUMBNAIL_FPS,
                    |current, total| {
                        // Map classification to 15-30% of overall progress
                        let class_pct = if total > 0 {
                            (current as f64 / total as f64 * 100.0) as u32
                        } else {
                            0
                        };
                        let overall_pct = 15 + (class_pct as f64 * 0.15) as u32; // 15% to 30%
                        emit(
                            &ah,
                            "scrima:analysis-progress",
                            serde_json::json!({
                                "matchId": mid,
                                "stage": "classifying",
                                "percent": overall_pct,
                                "detail": format!("Classifying frames ({}/{})", current, total),
                            }),
                        );
                    },
                );
                Ok(result)
            }
            None => Err("Classifier failed to load".to_string()),
        }
    })
    .await;

    let (classifications, detected_deaths) = match classify_result {
        Ok(Ok(result)) => result,
        Ok(Err(e)) => {
            log::error!("Classification failed: {e}");
            mark_analysis_failed(&match_id, &app_handle, &e);
            return Err(AnalysisError::Network(e));
        }
        Err(e) => {
            log::error!("spawn_blocking failed for classification: {e}");
            mark_analysis_failed(&match_id, &app_handle, &e.to_string());
            return Err(AnalysisError::Database(e.to_string()));
        }
    };

    if is_cancelled() {
        mark_analysis_reset(&match_id, &app_handle);
        return Err(AnalysisError::Cancelled);
    }

    log::info!(
        "Classification complete: {} frames, {} deaths detected for {match_id}",
        classifications.len(),
        detected_deaths.len()
    );

    // Cap detected deaths to the top-N by classifier confidence BEFORE frame
    // extraction + upload. Two reasons:
    //   1. The server's Zod schema limits `deaths` to 20 entries. A deathmatch
    //      or a rough competitive match can easily produce 25+ detections —
    //      those would HTTP-400 on upload.
    //   2. Only 10 deaths reach Gemma coaching anyway (top-confidence server-
    //      side cap). Sending more wastes bandwidth (~2-3 MB per death of
    //      frames + ability-bar crop) and time.
    // Selection: rank by softmax confidence descending, keep top 10, then
    // re-sort chronologically so death numbering reads in time order.
    const MAX_DEATHS_FOR_COACHING: usize = 10;
    let detected_deaths = if detected_deaths.len() > MAX_DEATHS_FOR_COACHING {
        let original_count = detected_deaths.len();
        let mut sorted = detected_deaths;
        sorted.sort_by(|a, b| {
            b.confidence
                .partial_cmp(&a.confidence)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        sorted.truncate(MAX_DEATHS_FOR_COACHING);
        sorted.sort_by(|a, b| {
            a.timestamp_sec
                .partial_cmp(&b.timestamp_sec)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        log::info!(
            "Capped deaths: {} detected → top {} by classifier confidence for {match_id}",
            original_count,
            sorted.len()
        );
        sorted
    } else {
        detected_deaths
    };

    // ── Step 3: Detect game start (first gameplay frame) ────────────────────
    let game_start_sec = classifications
        .iter()
        .find(|c| c.class == "gameplay")
        .map(|c| c.timestamp_sec)
        .unwrap_or(0.0);

    log::info!("Game start detected at {game_start_sec:.1}s for {match_id}");

    // Collect buy phase timestamps for metadata
    let buy_phase_timestamps: Vec<f64> = classifications
        .iter()
        .filter(|c| c.class == "buy_phase")
        .map(|c| c.timestamp_sec)
        .collect();

    // Estimate round count from buy_phase sequences
    let mut round_count = 0u32;
    let mut in_buy = false;
    for c in &classifications {
        if c.class == "buy_phase" && !in_buy {
            round_count += 1;
            in_buy = true;
        } else if c.class != "buy_phase" {
            in_buy = false;
        }
    }

    // The coarse classifier timestamp is only a candidate. Refine it at 8fps
    // before extracting any coaching frames/crops so the decision window is
    // anchored to the actual alive-to-death transition, not a late body-on-floor
    // animation frame.
    emit(
        &app_handle,
        "scrima:analysis-progress",
        serde_json::json!({
            "matchId": match_id,
            "stage": "classifying",
            "percent": 30,
            "detail": format!("Refining death timing ({} candidates)...", detected_deaths.len()),
        }),
    );

    let rec_for_refine = recording_path.clone();
    let app_data_for_refine = crate::app_data_dir();
    let coarse_deaths = detected_deaths.clone();
    let coarse_deaths_for_fallback = detected_deaths.clone();
    let refined_deaths = tokio::task::spawn_blocking(move || {
        refine_death_onsets(
            &rec_for_refine,
            &coarse_deaths,
            game_start_sec,
            &app_data_for_refine,
        )
    })
    .await
    .unwrap_or_else(|e| {
        log::warn!("Death onset refinement task failed: {e}");
        coarse_deaths_for_fallback
            .iter()
            .map(|d| fallback_refined_death(d, game_start_sec))
            .collect::<Vec<_>>()
    });

    log::info!(
        "Death onset refinement complete: {} deaths for {match_id}",
        refined_deaths.len()
    );

    // ── Step 4: Extract high-res death frames from original recording ───────
    emit(
        &app_handle,
        "scrima:analysis-progress",
        serde_json::json!({
            "matchId": match_id,
            "stage": "extracting",
            "percent": 32,
            "detail": format!("Extracting death frames ({} deaths)...", refined_deaths.len()),
        }),
    );

    let death_timestamps: Vec<f64> = refined_deaths.iter().map(|d| d.timestamp_sec).collect();
    let rec_for_frames = recording_path.clone();
    let gs = game_start_sec;
    let dt = death_timestamps.clone();

    // Extract ordered fight-phase frames per death at native resolution
    // (see clips::extract_death_frames). V4 keeps post-death body/killcam
    // frames out of decision evidence and uses 0s only for killfeed attribution.
    let death_frame_sets = tokio::task::spawn_blocking(move || {
        clips::extract_death_frames(std::path::Path::new(&rec_for_frames), &dt, gs)
    })
    .await
    .unwrap_or_else(|e| {
        log::warn!("Death frame extraction task failed: {e}");
        Vec::new()
    });

    if is_cancelled() {
        mark_analysis_reset(&match_id, &app_handle);
        return Err(AnalysisError::Cancelled);
    }

    // ── Step 4b: Extract one ability-bar crop per death ──────────────────────
    // Zoomed-in crop of the four C/Q/E/X ability icons at the decision-time
    // frame (-1 s relative to death). Gemma struggles to read LIT vs DIMMED
    // from full-frame tiles at HIGH media resolution — a dedicated 512×192
    // crop fixes that. Extracted at max(-1s, game_start_sec) so we never seek
    // before the game started.
    // V3 sends multiple typed crops, not just the legacy ability crop.
    let evidence_crops: Vec<clips::DeathEvidenceCrops> = {
        let rec_for_crops = recording_path.clone();
        let deaths = refined_deaths.clone();
        tokio::task::spawn_blocking(move || {
            deaths
                .iter()
                .map(|d| {
                    clips::extract_death_evidence_crops(
                        std::path::Path::new(&rec_for_crops),
                        d.decision_anchor_sec,
                        d.timestamp_sec,
                    )
                })
                .collect::<Vec<_>>()
        })
        .await
        .unwrap_or_else(|e| {
            log::warn!("Typed evidence crop extraction task failed: {e}");
            Vec::new()
        })
    };

    // ── Step 5: Extract multiple game-context frames for robust ID vote ──────
    // Take up to 3 frames spread across early buy-phases. Multi-frame vote
    // dramatically reduces the chance of a single blurry / spectating frame
    // mis-identifying the agent or map.
    let context_timestamps: Vec<f64> = {
        let mut ts = vec![(game_start_sec + 5.0).max(3.0)];
        // Add early buy-phase-derived frames if we detected any, else fall back
        // to evenly-spaced offsets in the first minute of gameplay.
        if !buy_phase_timestamps.is_empty() {
            for &bt in buy_phase_timestamps.iter().take(3) {
                let frame_ts = (bt + 8.0).max(game_start_sec + 3.0);
                if !ts.iter().any(|t: &f64| (t - frame_ts).abs() < 2.0) {
                    ts.push(frame_ts);
                }
                if ts.len() >= 3 {
                    break;
                }
            }
        }
        if ts.len() < 3 {
            for offset in [15.0, 25.0, 40.0] {
                let t = game_start_sec + offset;
                if !ts.iter().any(|t2: &f64| (t2 - t).abs() < 2.0) {
                    ts.push(t);
                }
                if ts.len() >= 3 {
                    break;
                }
            }
        }
        ts.truncate(3);
        ts
    };

    let rec_for_context = recording_path.clone();
    let context_timestamps_clone = context_timestamps.clone();
    let context_jpegs: Vec<Option<Vec<u8>>> = tokio::task::spawn_blocking(move || {
        context_timestamps_clone
            .iter()
            .map(|&t| clips::extract_frame_jpeg(std::path::Path::new(&rec_for_context), t).ok())
            .collect()
    })
    .await
    .unwrap_or_else(|e| {
        log::warn!("Context frame extraction task failed: {e}");
        Vec::new()
    });

    // ── Step 6: Build metadata JSON and upload ──────────────────────────────
    emit(
        &app_handle,
        "scrima:analysis-progress",
        serde_json::json!({
            "matchId": match_id,
            "stage": "uploading",
            "percent": 42,
            "detail": "Uploading frames to server...",
        }),
    );

    let detected_mode = match_row
        .game_mode
        .clone()
        .unwrap_or_else(|| detect_game_mode(&all_events));

    let effective_agent = agent_override
        .as_deref()
        .unwrap_or_else(|| match_row.agent.as_deref().unwrap_or("unknown"));
    let effective_map = map_override
        .as_deref()
        .unwrap_or_else(|| match_row.map.as_deref().unwrap_or("unknown"));

    log::info!(
        "Frame pipeline metadata: agent={effective_agent} map={effective_map} mode={detected_mode}"
    );

    let phase_for_offset = |offset: f64| -> (&'static str, &'static str) {
        if (offset + 5.0).abs() < 0.01 {
            ("setup_context", "pre_outcome")
        } else if (offset + 3.0).abs() < 0.01 {
            ("approach", "pre_outcome")
        } else if (offset + 2.0).abs() < 0.01 {
            ("decision", "pre_outcome")
        } else if (offset + 1.25).abs() < 0.01 {
            ("pre_contact", "pre_outcome")
        } else if (offset + 1.0).abs() < 0.01 {
            ("hud_crosscheck", "pre_outcome")
        } else if (offset + 0.75).abs() < 0.01 {
            ("contact_start", "pre_outcome")
        } else if (offset + 0.5).abs() < 0.01 {
            ("contact_execution", "pre_outcome")
        } else if (offset + 0.25).abs() < 0.01 {
            ("last_alive", "pre_outcome")
        } else if offset.abs() < 0.01 {
            ("death_confirm", "outcome")
        } else if offset < 0.0 {
            ("pre_death", "pre_outcome")
        } else {
            ("outcome", "outcome")
        }
    };

    // Build deaths array with base64 JPEG frames + ability-bar crop + confidence.
    // Death order in death_frame_sets matches detected_deaths order (same
    // death_timestamps iteration), so we can zip them.
    use base64::Engine;
    let deaths_json: Vec<serde_json::Value> = death_frame_sets
        .iter()
        .enumerate()
        .map(|(i, dfs)| {
            let frames_json: Vec<serde_json::Value> = dfs
                .frames
                .iter()
                .map(|f| {
                    serde_json::json!({
                        "offsetSec": f.offset_sec,
                        "base64Jpeg": base64::engine::general_purpose::STANDARD.encode(&f.jpeg_bytes),
                    })
                })
                .collect();

            let crop_b64 = |bytes: &Option<Vec<u8>>| {
                bytes
                    .as_ref()
                    .map(|jpeg| base64::engine::general_purpose::STANDARD.encode(jpeg))
            };

            let crops = evidence_crops.get(i);
            let ability_crop_b64 = crops.and_then(|c| crop_b64(&c.decision_ability_bar));

            let mut typed_crops = serde_json::Map::new();
            if let Some(crop) = crops {
                if let Some(v) = crop_b64(&crop.decision_weapon_hud) {
                    typed_crops.insert("decisionWeaponHud".into(), serde_json::Value::String(v));
                }
                if let Some(v) = crop_b64(&crop.contact_weapon_hud) {
                    typed_crops.insert("contactWeaponHud".into(), serde_json::Value::String(v));
                }
                if let Some(v) = crop_b64(&crop.decision_minimap) {
                    typed_crops.insert("decisionMinimap".into(), serde_json::Value::String(v));
                }
                if let Some(v) = crop_b64(&crop.decision_hp_shield) {
                    typed_crops.insert("decisionHpShield".into(), serde_json::Value::String(v));
                }
                if let Some(v) = crop_b64(&crop.decision_crosshair) {
                    typed_crops.insert("decisionCrosshair".into(), serde_json::Value::String(v));
                }
                if let Some(v) = crop_b64(&crop.contact_crosshair) {
                    typed_crops.insert("contactCrosshair".into(), serde_json::Value::String(v));
                }
                if let Some(v) = crop_b64(&crop.death_killfeed) {
                    typed_crops.insert("deathKillfeed".into(), serde_json::Value::String(v));
                }
                if let Some(v) = crop_b64(&crop.death_top_hud) {
                    typed_crops.insert("deathTopHud".into(), serde_json::Value::String(v));
                }
            }

            let refined = refined_deaths.get(i);
            let confidence = refined
                .map(|d| d.confidence as f64)
                .unwrap_or(0.5);

            let mut entry = serde_json::json!({
                "timestampSec": dfs.timestamp_sec,
                "frames": frames_json,
                "confidence": confidence,
            });
            if let Some(crop_b64) = ability_crop_b64 {
                entry["abilityBarCropBase64"] = serde_json::Value::String(crop_b64);
            }
            if !typed_crops.is_empty() {
                entry["typedCrops"] = serde_json::Value::Object(typed_crops);
            }
            let phase_frames: Vec<serde_json::Value> = dfs
                .frames
                .iter()
                .map(|f| {
                    let (phase, role) = phase_for_offset(f.offset_sec);
                    serde_json::json!({
                        "offsetSec": f.offset_sec,
                        "phase": phase,
                        "role": role,
                    })
                })
                .collect();
            let mut focus_crop_refs = Vec::new();
            if crops.and_then(|c| c.decision_crosshair.as_ref()).is_some() {
                focus_crop_refs.push(serde_json::json!({
                    "kind": "center_crosshair",
                    "phase": "decision",
                    "offsetSec": -2.0,
                    "typedCropKey": "decisionCrosshair",
                }));
            }
            if crops.and_then(|c| c.contact_crosshair.as_ref()).is_some() {
                focus_crop_refs.push(serde_json::json!({
                    "kind": "center_crosshair",
                    "phase": "contact_execution",
                    "offsetSec": -0.5,
                    "typedCropKey": "contactCrosshair",
                }));
            }
            entry["fightPacket"] = serde_json::json!({
                "version": 5,
                "phaseFrames": phase_frames,
                "focusCropRefs": focus_crop_refs,
            });
            if let Some(d) = refined {
                entry["localEvidence"] = serde_json::json!({
                    "candidateTimestampSec": d.candidate_timestamp_sec,
                    "refinedTimestampSec": d.timestamp_sec,
                    "decisionAnchorSec": d.decision_anchor_sec,
                    "detectorFrameIndex": d.frame_index,
                    "detectorConfidence": d.confidence,
                    "onsetConfidence": d.onset_confidence,
                    "refinementQuality": d.refinement_quality,
                    "lastAliveSec": d.last_alive_sec,
                    "firstDeathSec": d.first_death_sec,
                    "postDeathDecisionFramesExcluded": true,
                });
            }
            entry
        })
        .collect();

    // Primary game context frame (legacy field for older server deployments)
    let game_context_b64 = context_jpegs
        .first()
        .and_then(|opt| opt.as_ref())
        .map(|jpeg| base64::engine::general_purpose::STANDARD.encode(jpeg));

    // Full array of context frames for multi-frame consensus vote.
    let game_context_frames: Vec<String> = context_jpegs
        .iter()
        .filter_map(|opt| opt.as_ref())
        .map(|jpeg| base64::engine::general_purpose::STANDARD.encode(jpeg))
        .collect();

    let payload = serde_json::json!({
        "matchId": match_id,
        "gameId": match_row.game_id,
        "gameMode": detected_mode,
        "durationMs": match_row.duration_ms.unwrap_or(0),
        "map": effective_map,
        "agent": effective_agent,
        "rank": "unknown",
        "evidenceVersion": 5,
        "deaths": deaths_json,
        "gameContextFrame": game_context_b64,
        "gameContextFrames": game_context_frames,
        "roundCount": round_count,
        "buyPhaseTimestamps": buy_phase_timestamps,
        "clientVersion": "fight-v5-evidence",
    });

    let client = app_handle.state::<AppState>().api_client();
    let job = match client
        .upload_analysis_frames(&match_id, payload.to_string())
        .await
    {
        Ok(j) => j,
        Err(e) => {
            log::error!("Frame upload failed for {match_id}: {e}");
            // Frame pipeline cannot be retried offline (frames are extracted at analysis time).
            // User should re-run analysis instead.
            log::warn!("Frame upload failed for {match_id} — user should retry analysis");
            mark_analysis_failed(&match_id, &app_handle, &e.to_string());
            return Err(AnalysisError::Network(e.to_string()));
        }
    };

    log::info!(
        "Frame analysis accepted: job_id={} status={} for match {match_id}",
        job.job_id,
        job.status
    );

    // ── Step 7: Poll for analysis completion ──────────────────────────────
    // Server processes deaths in background. Poll for progress.
    let (report_json, real_server_report_id) = {
        let mut result: Option<(serde_json::Value, String)> = None;

        for attempt in 0..MAX_POLLS {
            if is_cancelled() {
                mark_analysis_reset(&match_id, &app_handle);
                return Err(AnalysisError::Cancelled);
            }

            tokio::time::sleep(Duration::from_millis(POLL_INTERVAL_MS)).await;

            match client.poll_frame_analysis_status(&job.job_id).await {
                Ok(status) => {
                    let (current, total, stage) = match &status.progress {
                        Some(p) => (
                            p.current.unwrap_or(0),
                            p.total.unwrap_or(0),
                            p.stage.as_deref().unwrap_or("analyzing"),
                        ),
                        None => (0, 0, "analyzing"),
                    };

                    // Map server stage to overall percentage (45-95%)
                    let pct = match stage {
                        "analyzing" if total > 0 => {
                            45 + ((current as f64 / total as f64) * 35.0) as u32
                        }
                        "retrying" => 82,
                        "synthesizing" => 88,
                        "saving" => 93,
                        _ => 50,
                    };

                    let detail = match stage {
                        "analyzing" if total > 0 => {
                            format!("Analyzing death {}/{}", current, total)
                        }
                        "retrying" => "Retrying failed deaths...".to_string(),
                        "synthesizing" => "Generating coaching report...".to_string(),
                        "saving" => "Saving report...".to_string(),
                        _ => "Processing...".to_string(),
                    };

                    emit(
                        &app_handle,
                        "scrima:analysis-progress",
                        serde_json::json!({
                            "matchId": match_id,
                            "stage": "analyzing",
                            "percent": pct,
                            "detail": detail,
                        }),
                    );

                    match status.status.as_str() {
                        "completed" => {
                            if let Some(rid) = status.report_id {
                                match client.get_coaching_report_remote(&rid).await {
                                    Ok(report) => {
                                        result = Some((report, rid));
                                        break;
                                    }
                                    Err(e) => {
                                        log::error!("Failed to fetch report {rid}: {e}");
                                        mark_analysis_failed(
                                            &match_id,
                                            &app_handle,
                                            &e.to_string(),
                                        );
                                        return Err(AnalysisError::Network(e.to_string()));
                                    }
                                }
                            }
                            break;
                        }
                        "failed" => {
                            let err_msg = status
                                .error
                                .unwrap_or_else(|| "Analysis failed".to_string());
                            log::error!("Frame analysis job failed: {err_msg}");
                            mark_analysis_failed(&match_id, &app_handle, &err_msg);
                            return Err(AnalysisError::Network(err_msg));
                        }
                        _ => {} // processing — keep polling
                    }
                }
                Err(e) => {
                    log::warn!("Poll error (attempt {}): {e}", attempt + 1);
                }
            }
        }

        match result {
            Some(r) => r,
            None => {
                if is_cancelled() {
                    mark_analysis_reset(&match_id, &app_handle);
                    return Err(AnalysisError::Cancelled);
                }
                log::warn!("Frame analysis timed out for {match_id}");
                {
                    let state = app_handle.state::<AppState>();
                    let db = state
                        .db
                        .lock()
                        .map_err(|e| AnalysisError::Database(e.to_string()))?;
                    let _ = db.update_analysis_status(&match_id, "analyzing");
                }
                return Ok(());
            }
        }
    };

    // ── Step 8: Store coaching report ───────────────────────────────────────
    let report_id = uuid::Uuid::new_v4().to_string();
    let report_row = DeepCoachingReportRow {
        id: report_id.clone(),
        match_id: match_id.clone(),
        server_report_id: real_server_report_id.clone(),
        report_json: report_json.to_string(),
        created_at: crate::now_ms(),
    };

    {
        let state = app_handle.state::<AppState>();
        let db = state
            .db
            .lock()
            .map_err(|e| AnalysisError::Database(e.to_string()))?;
        db.insert_deep_coaching_report(&report_row)?;
        let _ = db.update_analysis_status(&match_id, "done");
    }

    // ── Step 9: Extract local 15s HD clips for coaching moments ─────────────
    extract_moment_clips(&match_id, &match_row, &report_json, &app_handle);

    emit(
        &app_handle,
        "scrima:analysis-complete",
        serde_json::json!({
            "matchId": match_id,
            "reportId": report_id,
        }),
    );

    // No enrichment step in the frame-based pipeline — frames are already uploaded.
    // BUT the client's analysisStore listens for `scrima:enrichment-done` before
    // flipping stage → 'done'; without it, the UI sits on "ENHANCING COACHING"
    // for the full 3-minute safety timeout. Emit done immediately so the UI
    // transitions as soon as the report is saved.
    emit(
        &app_handle,
        "scrima:enrichment-done",
        serde_json::json!({
            "matchId": match_id,
            "enriched": false,
            "deathsUpdated": 0,
        }),
    );
    log::info!("Frame-based analysis complete: {match_id}");
    Ok(())
}

// ============================================================
// LEGACY VIDEO UPLOAD PIPELINE
// ============================================================

async fn run_legacy_pipeline(
    match_id: String,
    match_row: MatchRow,
    recording_path: String,
    all_events: Vec<serde_json::Value>,
    app_handle: tauri::AppHandle,
    cancel: Option<Arc<AtomicBool>>,
    agent_override: Option<String>,
    map_override: Option<String>,
) -> Result<(), AnalysisError> {
    let is_cancelled = || -> bool { cancel.as_ref().map_or(false, |c| c.load(Ordering::Relaxed)) };

    // 3. Get analysis copy — either pre-built (dual-output recording) or create one now.
    let analysis_dir = crate::app_data_dir().join("analysis");
    let _ = std::fs::create_dir_all(&analysis_dir);
    let analysis_path = analysis_dir.join(format!("{match_id}_analysis.mp4"));
    let mut timestamps_burned = false;

    // Check for pre-built analysis copy from dual-output recording
    let prebuilt_path: Option<String> = {
        let state = app_handle.state::<AppState>();
        let db = state
            .db
            .lock()
            .map_err(|e| AnalysisError::Database(e.to_string()))?;
        db.get_analysis_copy_path(&match_id).unwrap_or(None)
    };

    let have_prebuilt = prebuilt_path
        .as_ref()
        .map(|p| {
            let path = std::path::Path::new(p);
            path.exists()
                && std::fs::metadata(path)
                    .map(|m| m.len() > 1024)
                    .unwrap_or(false)
        })
        .unwrap_or(false);

    // Check if a cached analysis copy already exists from a previous analysis run
    let have_cached = analysis_path.exists()
        && std::fs::metadata(&analysis_path)
            .map(|m| m.len() > 1024)
            .unwrap_or(false);

    if have_cached {
        let size = std::fs::metadata(&analysis_path)
            .map(|m| m.len())
            .unwrap_or(0);
        log::info!(
            "Reusing cached analysis copy: {:.1} MB",
            size as f64 / 1_048_576.0
        );
        emit(
            &app_handle,
            "scrima:analysis-progress",
            serde_json::json!({
                "matchId": match_id,
                "stage": "compressing",
            }),
        );
    } else if have_prebuilt {
        let src = prebuilt_path.as_ref().unwrap();
        log::info!("Using pre-built analysis copy: {src}");
        if src != &analysis_path.to_string_lossy().to_string() {
            std::fs::copy(src, &analysis_path)
                .map_err(|e| AnalysisError::Database(format!("copy analysis copy: {e}")))?;
        }
        let size = std::fs::metadata(&analysis_path)
            .map(|m| m.len())
            .unwrap_or(0);
        log::info!(
            "Pre-built analysis copy: {:.1} MB (timestamps already burned)",
            size as f64 / 1_048_576.0
        );
        timestamps_burned = true;

        emit(
            &app_handle,
            "scrima:analysis-progress",
            serde_json::json!({
                "matchId": match_id,
                "stage": "compressing",
            }),
        );
    } else {
        log::info!("No pre-built analysis copy — creating from recording");
        emit(
            &app_handle,
            "scrima:analysis-progress",
            serde_json::json!({
                "matchId": match_id,
                "stage": "compressing",
            }),
        );

        const MAX_FRAMES: f64 = 600.0;
        let duration_secs = match_row.duration_ms.unwrap_or(2_040_000) as f64 / 1000.0;
        let interval_secs = (duration_secs / MAX_FRAMES).max(1.0);
        log::info!("Analysis interval: {interval_secs:.2}s/frame for {duration_secs:.0}s game → ~{} frames",
            (duration_secs / interval_secs) as u32);

        let rec_path = recording_path.clone();
        let out_path = analysis_path.clone();
        match tokio::task::spawn_blocking(move || {
            clips::create_analysis_copy(std::path::Path::new(&rec_path), &out_path, interval_secs)
        })
        .await
        {
            Ok(Ok(())) => {
                let size = std::fs::metadata(&analysis_path)
                    .map(|m| m.len())
                    .unwrap_or(0);
                log::info!("Analysis copy: {:.1} MB", size as f64 / 1_048_576.0);
            }
            Ok(Err(e)) => {
                log::error!("Analysis copy creation failed: {e}");
                mark_analysis_failed(&match_id, &app_handle, &e.to_string());
                return Err(AnalysisError::Network(e.to_string()));
            }
            Err(e) => {
                log::error!("spawn_blocking failed: {e}");
                mark_analysis_failed(&match_id, &app_handle, &e.to_string());
                return Err(AnalysisError::Database(e.to_string()));
            }
        }
    }

    if is_cancelled() {
        let _ = std::fs::remove_file(&analysis_path);
        mark_analysis_reset(&match_id, &app_handle);
        return Err(AnalysisError::Cancelled);
    }

    emit(
        &app_handle,
        "scrima:analysis-progress",
        serde_json::json!({
            "matchId": match_id,
            "stage": "uploading",
        }),
    );

    // 4. Build rich context for the server from ALL detection events.
    let death_events: Vec<serde_json::Value> = all_events.iter()
        .filter(|e| e.get("event_type_id").and_then(|v| v.as_str()) == Some("death"))
        .enumerate()
        .map(|(i, e)| {
            let data = e.get("data").cloned().unwrap_or(serde_json::json!({}));
            let rel_ms = e.get("timestamp_ms").and_then(|v| v.as_u64()).unwrap_or(0);
            let rel_secs = rel_ms / 1000;
            let min = rel_secs / 60;
            let sec = rel_secs % 60;
            let hp_raw = data.get("hp_before").and_then(|v| v.as_f64());
            let hp_before = match hp_raw {
                Some(hp) if hp <= 1.5 => (hp * 100.0) as i64,
                Some(hp) => hp as i64,
                None => 100,
            };
            serde_json::json!({
                "index": i,
                "round": data.get("round").and_then(|v| v.as_u64()).unwrap_or(0),
                "timestampMs": rel_ms,
                "timestampFormatted": format!("{min}:{sec:02}"),
                "killer": data.get("killer").and_then(|v| v.as_str()).unwrap_or("unknown"),
                "weapon": data.get("weapon").and_then(|v| v.as_str()).unwrap_or("unknown"),
                "headshot": data.get("headshot").and_then(|v| v.as_bool()).unwrap_or(false),
                "hpBefore": hp_before,
                "teamAlive": data.get("teamAlive").and_then(|v| v.as_i64()).unwrap_or(4),
                "enemyAlive": data.get("enemyAlive").and_then(|v| v.as_i64()).unwrap_or(5),
                "abilitiesAvailable": data.get("abilitiesAvailable").cloned().unwrap_or(serde_json::json!([])),
                "money": data.get("money").and_then(|v| v.as_u64()).unwrap_or(0),
                "teamMoneyAvg": 0,
            })
        })
        .collect();

    let match_events: Vec<serde_json::Value> = all_events
        .iter()
        .filter(|e| {
            let etype = e
                .get("event_type_id")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            matches!(
                etype,
                "round_start" | "buy_phase_start" | "score_update" | "kill"
            )
        })
        .map(|e| {
            serde_json::json!({
                "type": e.get("event_type_id").and_then(|v| v.as_str()).unwrap_or(""),
                "timestampMs": e.get("timestamp_ms").and_then(|v| v.as_u64()).unwrap_or(0),
                "data": e.get("data").cloned().unwrap_or(serde_json::json!({})),
            })
        })
        .collect();

    let economy_timeline: Vec<serde_json::Value> = all_events
        .iter()
        .filter(|e| e.get("event_type_id").and_then(|v| v.as_str()) == Some("buy_phase_start"))
        .enumerate()
        .map(|(i, e)| {
            let data = e.get("data").cloned().unwrap_or(serde_json::json!({}));
            serde_json::json!({
                "round": i + 1,
                "money": data.get("money").and_then(|v| v.as_u64()).unwrap_or(0),
                "buyType": data.get("buy_type").and_then(|v| v.as_str()).unwrap_or("unknown"),
            })
        })
        .collect();

    log::info!(
        "Analysis context: {} deaths, {} match events, {} economy entries",
        death_events.len(),
        match_events.len(),
        economy_timeline.len()
    );

    let detected_mode = match_row
        .game_mode
        .clone()
        .unwrap_or_else(|| detect_game_mode(&all_events));

    let effective_agent = agent_override
        .as_deref()
        .unwrap_or_else(|| match_row.agent.as_deref().unwrap_or("unknown"));
    let effective_map = map_override
        .as_deref()
        .unwrap_or_else(|| match_row.map.as_deref().unwrap_or("unknown"));

    log::info!("Metadata agent={effective_agent} map={effective_map} (override_agent={:?}, override_map={:?})",
        agent_override, map_override);

    let metadata = serde_json::json!({
        "matchId": match_id,
        "trigger": "manual",
        "game": match_row.game_id,
        "gameMode": detected_mode,
        "durationMs": match_row.duration_ms.unwrap_or(0),
        "map": effective_map,
        "agent": effective_agent,
        "rank": "unknown",
        "timestampsBurned": timestamps_burned,
        "matchEvents": match_events,
        "deathDetails": death_events,
        "economyTimeline": economy_timeline,
        "abilityUsage": { "totalUsed": 0, "totalAvailable": 0, "usageRate": 0.0, "byAbility": {} },
    });

    // 5. Upload analysis copy to server
    let client = app_handle.state::<AppState>().api_client();
    let job = match client
        .upload_game_analysis(&match_id, &analysis_path, metadata.to_string())
        .await
    {
        Ok(j) => j,
        Err(e) => {
            log::error!("Upload failed for {match_id}: {e}");
            let payload = serde_json::json!({
                "context_json": metadata.to_string(),
                "video_path": analysis_path.to_string_lossy(),
            });
            let pending = crate::storage::PendingUploadRow {
                id: uuid::Uuid::new_v4().to_string(),
                match_id: match_id.clone(),
                job_type: "full_game".into(),
                payload_json: payload.to_string(),
                retry_count: 0,
                last_attempt_at: 0,
                status: "pending".into(),
                error_msg: Some(e.to_string()),
                created_at: crate::now_ms(),
            };
            {
                let state = app_handle.state::<AppState>();
                let db = state
                    .db
                    .lock()
                    .map_err(|e2| AnalysisError::Database(e2.to_string()))?;
                let _ = db.insert_pending_upload(&pending);
                let _ = db.update_analysis_status(&match_id, "queued_offline");
            }
            crate::network::retry::wake_retry_loop();
            return Err(AnalysisError::Network(e.to_string()));
        }
    };

    log::info!("Analysis job queued: {} for match {match_id}", job.job_id);

    emit(
        &app_handle,
        "scrima:analysis-progress",
        serde_json::json!({
            "matchId": match_id,
            "stage": "analyzing",
            "jobId": job.job_id,
        }),
    );

    if is_cancelled() {
        mark_analysis_reset(&match_id, &app_handle);
        return Err(AnalysisError::Cancelled);
    }

    // 7. Poll for coaching results
    let (report_json, real_server_report_id) =
        match poll_job(&client, &job.job_id, &match_id, &app_handle, &cancel).await {
            Some(result) => result,
            None => {
                if is_cancelled() {
                    mark_analysis_reset(&match_id, &app_handle);
                    return Err(AnalysisError::Cancelled);
                }
                log::warn!("Analysis timed out for {match_id} — will poll again later");
                {
                    let state = app_handle.state::<AppState>();
                    let db = state
                        .db
                        .lock()
                        .map_err(|e| AnalysisError::Database(e.to_string()))?;
                    let _ = db.update_analysis_status(&match_id, "analyzing");
                }
                emit(
                    &app_handle,
                    "scrima:analysis-progress",
                    serde_json::json!({
                        "matchId": match_id,
                        "stage": "analyzing_background",
                        "jobId": job.job_id,
                    }),
                );
                return Ok(());
            }
        };

    // 8. Store coaching report
    let report_id = uuid::Uuid::new_v4().to_string();
    let report_row = DeepCoachingReportRow {
        id: report_id.clone(),
        match_id: match_id.clone(),
        server_report_id: real_server_report_id.clone(),
        report_json: report_json.to_string(),
        created_at: crate::now_ms(),
    };

    {
        let state = app_handle.state::<AppState>();
        let db = state
            .db
            .lock()
            .map_err(|e| AnalysisError::Database(e.to_string()))?;
        db.insert_deep_coaching_report(&report_row)?;
        let _ = db.update_analysis_status(&match_id, "done");
    }

    // 9. Extract local 15s HD clips for coaching moments
    extract_moment_clips(&match_id, &match_row, &report_json, &app_handle);

    emit(
        &app_handle,
        "scrima:analysis-complete",
        serde_json::json!({
            "matchId": match_id,
            "reportId": report_id,
        }),
    );

    // 10. Background enrichment — extract high-fps frames from original recording
    spawn_background_enrichment(
        match_id.clone(),
        recording_path,
        real_server_report_id,
        report_json,
        app_handle.clone(),
    );

    log::info!("Full game analysis complete: {match_id}");
    Ok(())
}

// ============================================================
// BACKGROUND ENRICHMENT (legacy pipeline only)
// ============================================================

/// Spawn a background task to extract high-fps frames from the original recording
/// and upload them to the server for enhanced coaching enrichment.
fn spawn_background_enrichment(
    match_id: String,
    recording_path: String,
    server_report_id: String,
    report_json: serde_json::Value,
    app_handle: tauri::AppHandle,
) {
    tokio::task::spawn(async move {
        if let Err(e) = run_background_enrichment(
            &match_id,
            &recording_path,
            &server_report_id,
            &report_json,
            &app_handle,
        )
        .await
        {
            log::warn!("Background enrichment failed for {match_id}: {e}");
            emit(
                &app_handle,
                "scrima:enrichment-done",
                serde_json::json!({
                    "matchId": match_id, "enriched": false,
                }),
            );
        }
    });
}

async fn run_background_enrichment(
    match_id: &str,
    recording_path: &str,
    server_report_id: &str,
    report_json: &serde_json::Value,
    app_handle: &tauri::AppHandle,
) -> Result<(), AnalysisError> {
    // 1. Check recording exists
    let rec_path = std::path::Path::new(recording_path);
    if !rec_path.exists() {
        log::info!("[Enrichment] Recording not found, skipping: {recording_path}");
        emit(
            app_handle,
            "scrima:enrichment-done",
            serde_json::json!({
                "matchId": match_id, "enriched": false,
            }),
        );
        return Ok(());
    }

    // 2. Parse death timestamps from report
    let death_coaching = report_json
        .get("death_coaching")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    if death_coaching.is_empty() {
        log::info!("[Enrichment] No deaths in report, skipping for {match_id}");
        emit(
            app_handle,
            "scrima:enrichment-done",
            serde_json::json!({
                "matchId": match_id, "enriched": false,
            }),
        );
        return Ok(());
    }

    let death_timestamps: Vec<(usize, f64)> = death_coaching
        .iter()
        .filter_map(|d| {
            let num = d.get("death_number").and_then(|v| v.as_u64())? as usize;
            let time_str = d.get("approximate_time").and_then(|v| v.as_str())?;
            let secs = parse_timestamp_to_secs(time_str)?;
            Some((num, secs))
        })
        .collect();

    if death_timestamps.is_empty() {
        log::info!("[Enrichment] No valid death timestamps, skipping for {match_id}");
        emit(
            app_handle,
            "scrima:enrichment-done",
            serde_json::json!({
                "matchId": match_id, "enriched": false,
            }),
        );
        return Ok(());
    }

    // 2b. Parse utility events per death from Pass 1 report
    let mut utility_events: Vec<clips::UtilityEvent> = Vec::new();
    for d in &death_coaching {
        let death_num = match d.get("death_number").and_then(|v| v.as_u64()) {
            Some(n) => n as usize,
            None => continue,
        };
        if let Some(events) = d.get("round_utility_events").and_then(|v| v.as_array()) {
            for (idx, e) in events.iter().enumerate() {
                let ability = e
                    .get("ability_name")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let time_str = e
                    .get("approximate_time")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                if let Some(secs) = parse_timestamp_to_secs(time_str) {
                    utility_events.push(clips::UtilityEvent {
                        death_number: death_num,
                        event_index: idx + 1,
                        ability_name: ability,
                        timestamp_sec: secs,
                    });
                }
            }
        }
    }

    log::info!(
        "[Enrichment] Extracting high-fps frames for {} deaths + {} utility events in {match_id}",
        death_timestamps.len(),
        utility_events.len()
    );

    // 3. Extract frames (blocking ffmpeg work)
    let enrichment_dir = crate::app_data_dir().join("enrichment").join(match_id);
    let _ = std::fs::create_dir_all(&enrichment_dir);

    let rec = recording_path.to_string();
    let dir = enrichment_dir.clone();
    let timestamps = death_timestamps;
    let util_events = utility_events;
    let frames = match tokio::task::spawn_blocking(move || {
        clips::extract_enrichment_frames(
            std::path::Path::new(&rec),
            &timestamps,
            &util_events,
            &dir,
        )
    })
    .await
    {
        Ok(Ok(frames)) => frames,
        Ok(Err(e)) => {
            log::warn!("[Enrichment] Frame extraction failed: {e}");
            let _ = std::fs::remove_dir_all(&enrichment_dir);
            emit(
                app_handle,
                "scrima:enrichment-done",
                serde_json::json!({
                    "matchId": match_id, "enriched": false,
                }),
            );
            return Ok(());
        }
        Err(e) => {
            log::warn!("[Enrichment] spawn_blocking failed: {e}");
            let _ = std::fs::remove_dir_all(&enrichment_dir);
            emit(
                app_handle,
                "scrima:enrichment-done",
                serde_json::json!({
                    "matchId": match_id, "enriched": false,
                }),
            );
            return Ok(());
        }
    };

    if frames.is_empty() {
        log::warn!("[Enrichment] No frames extracted for {match_id}");
        let _ = std::fs::remove_dir_all(&enrichment_dir);
        emit(
            app_handle,
            "scrima:enrichment-done",
            serde_json::json!({
                "matchId": match_id, "enriched": false,
            }),
        );
        return Ok(());
    }

    log::info!(
        "[Enrichment] Uploading {} frames for {match_id}",
        frames.len()
    );

    // 4. Upload to server
    let client = app_handle.state::<AppState>().api_client();
    match client
        .upload_enrichment_frames(server_report_id, &frames)
        .await
    {
        Ok(resp) => {
            if resp.enriched {
                log::info!(
                    "[Enrichment] Complete for {match_id}: {} deaths updated",
                    resp.deaths_updated
                );

                // 5. Fetch updated report and store locally
                if let Ok(updated_report) =
                    client.get_coaching_report_remote(server_report_id).await
                {
                    let state = app_handle.state::<AppState>();
                    if let Ok(db) = state.db.lock() {
                        if let Ok(Some(mut stored)) = db.get_deep_coaching_report(match_id) {
                            stored.report_json = updated_report.to_string();
                            let _ = db.insert_deep_coaching_report(&stored);
                            log::info!("[Enrichment] Local report updated for {match_id}");
                        }
                    }

                    emit(
                        app_handle,
                        "scrima:enrichment-done",
                        serde_json::json!({
                            "matchId": match_id,
                            "enriched": true,
                            "deathsUpdated": resp.deaths_updated,
                        }),
                    );
                } else {
                    emit(
                        app_handle,
                        "scrima:enrichment-done",
                        serde_json::json!({
                            "matchId": match_id, "enriched": false,
                        }),
                    );
                }
            } else if resp.already {
                log::info!("[Enrichment] Already enhanced for {match_id}");
                emit(
                    app_handle,
                    "scrima:enrichment-done",
                    serde_json::json!({
                        "matchId": match_id, "enriched": false,
                    }),
                );
            } else {
                log::info!("[Enrichment] Not applied for {match_id}: {:?}", resp.error);
                emit(
                    app_handle,
                    "scrima:enrichment-done",
                    serde_json::json!({
                        "matchId": match_id, "enriched": false,
                    }),
                );
            }
        }
        Err(e) => {
            log::warn!("[Enrichment] Upload failed for {match_id}: {e}");
            emit(
                app_handle,
                "scrima:enrichment-done",
                serde_json::json!({
                    "matchId": match_id, "enriched": false,
                }),
            );
        }
    }

    // 6. Cleanup temp files
    let _ = std::fs::remove_dir_all(&enrichment_dir);
    Ok(())
}

/// Parse "MM:SS" or "HH:MM:SS" timestamp string to seconds.
fn parse_timestamp_to_secs(ts: &str) -> Option<f64> {
    let parts: Vec<&str> = ts.split(':').collect();
    match parts.len() {
        2 => {
            let min: f64 = parts[0].parse().ok()?;
            let sec: f64 = parts[1].parse().ok()?;
            Some(min * 60.0 + sec)
        }
        3 => {
            let hr: f64 = parts[0].parse().ok()?;
            let min: f64 = parts[1].parse().ok()?;
            let sec: f64 = parts[2].parse().ok()?;
            Some(hr * 3600.0 + min * 60.0 + sec)
        }
        _ => None,
    }
}

// ============================================================
// HELPERS
// ============================================================

fn mark_analysis_failed(match_id: &str, app_handle: &tauri::AppHandle, error: &str) {
    let state = app_handle.state::<AppState>();
    if let Ok(db) = state.db.lock() {
        let _ = db.update_analysis_status(match_id, "failed");
    }
    emit(
        app_handle,
        "scrima:analysis-complete",
        serde_json::json!({
            "matchId": match_id,
            "error": error,
        }),
    );
}

/// Reset analysis status to "none" when cancelled, so user can retry.
fn mark_analysis_reset(match_id: &str, app_handle: &tauri::AppHandle) {
    let state = app_handle.state::<AppState>();
    if let Ok(db) = state.db.lock() {
        let _ = db.update_analysis_status(match_id, "none");
    }
    emit(
        app_handle,
        "scrima:analysis-complete",
        serde_json::json!({
            "matchId": match_id,
            "error": "Cancelled by user",
        }),
    );
    log::info!("Analysis cancelled for {match_id}");
}

/// Poll the server job until completed, timed out, or cancelled.
/// Returns (report_json, server_report_id) on success.
async fn poll_job(
    client: &ApiClient,
    server_job_id: &str,
    match_id: &str,
    app_handle: &tauri::AppHandle,
    cancel: &Option<Arc<AtomicBool>>,
) -> Option<(serde_json::Value, String)> {
    for attempt in 0..MAX_POLLS {
        // Check cancellation at the start of each poll
        if cancel.as_ref().map_or(false, |c| c.load(Ordering::Relaxed)) {
            log::info!("Poll loop cancelled for {match_id}");
            return None;
        }

        tokio::time::sleep(Duration::from_millis(POLL_INTERVAL_MS)).await;

        match client.poll_deep_analysis_job(server_job_id).await {
            Ok(status) => {
                log::info!(
                    "Poll {}/{}: status={}",
                    attempt + 1,
                    MAX_POLLS,
                    status.status
                );

                emit(
                    app_handle,
                    "scrima:analysis-progress",
                    serde_json::json!({
                        "matchId": match_id,
                        "stage": "analyzing",
                        "pollAttempt": attempt + 1,
                    }),
                );

                match status.status.as_str() {
                    "completed" => {
                        if let Some(report_id) = status.report_id {
                            match client.get_coaching_report_remote(&report_id).await {
                                Ok(report) => return Some((report, report_id)),
                                Err(e) => {
                                    log::error!(
                                        "Failed to fetch completed report {report_id}: {e}"
                                    );
                                    return None;
                                }
                            }
                        }
                        return None;
                    }
                    "failed" => {
                        log::error!("Analysis job failed on server: {:?}", status.error);
                        return None;
                    }
                    _ => {} // queued | processing — keep polling
                }
            }
            Err(e) => {
                log::warn!("Poll error: {e}");
            }
        }
    }
    None
}

/// Extract local 15s HD clips for each moment in the coaching report.
fn extract_moment_clips(
    match_id: &str,
    match_row: &MatchRow,
    report_json: &serde_json::Value,
    app_handle: &tauri::AppHandle,
) {
    let Some(recording) = match_row.recording_path.as_deref() else {
        return;
    };
    let moments = match report_json.get("moments").and_then(|m| m.as_array()) {
        Some(m) => m.clone(),
        None => return,
    };

    let clips_dir = crate::app_data_dir().join("clips").join(match_id);
    let _ = std::fs::create_dir_all(&clips_dir);

    for (i, moment) in moments.iter().enumerate() {
        let timestamp_ms = moment
            .get("timestampMs")
            .and_then(|v| v.as_i64())
            .unwrap_or(0);
        let offset_sec = if timestamp_ms < 86_400_000 {
            // Relative timestamp (ms from video start) — use directly
            timestamp_ms as f64 / 1000.0
        } else {
            // Absolute timestamp (Unix ms) — subtract match start
            (timestamp_ms - match_row.started_at) as f64 / 1000.0
        };
        if offset_sec <= 0.0 {
            continue;
        }

        let clip_path = clips_dir.join(format!("moment_{i}.mp4"));
        if let Err(e) = clips::extract_coaching_moment_clip(
            std::path::Path::new(recording),
            offset_sec,
            &clip_path,
        ) {
            log::warn!("Moment clip {i} failed: {e}");
            continue;
        }

        log::debug!("Moment clip {i} extracted: {clip_path:?}");
    }

    // Re-read the stored report and inject clip paths
    let state = app_handle.state::<AppState>();
    if let Ok(db) = state.db.lock() {
        if let Ok(Some(mut stored)) = db.get_deep_coaching_report(match_id) {
            if let Ok(mut parsed) = serde_json::from_str::<serde_json::Value>(&stored.report_json) {
                if let Some(moments_arr) = parsed.get_mut("moments").and_then(|m| m.as_array_mut())
                {
                    for (i, moment) in moments_arr.iter_mut().enumerate() {
                        let clip_path = clips_dir.join(format!("moment_{i}.mp4"));
                        if clip_path.exists() {
                            if let Some(obj) = moment.as_object_mut() {
                                obj.insert(
                                    "localClipPath".into(),
                                    serde_json::json!(clip_path.to_string_lossy()),
                                );
                            }
                        }
                    }
                }
                stored.report_json = parsed.to_string();
                let _ = db.insert_deep_coaching_report(&stored);
            }
        }
    };
}

// ============================================================
// GAME MODE DETECTION
// ============================================================

/// Infer the Valorant game mode from detected events.
fn detect_game_mode_from_types(event_types: &[&str]) -> String {
    let round_starts = event_types.iter().filter(|t| **t == "round_start").count();
    let buy_phases = event_types
        .iter()
        .filter(|t| **t == "buy_phase_start")
        .count();
    let deaths = event_types.iter().filter(|t| **t == "death").count();

    if round_starts < 2 && deaths > 5 {
        "deathmatch".into()
    } else if round_starts >= 2 && buy_phases == 0 {
        "spike_rush".into()
    } else if round_starts >= 2 && buy_phases >= 1 {
        "competitive".into()
    } else {
        "competitive".into()
    }
}

/// Detect game mode from JSON event values
fn detect_game_mode(events: &[serde_json::Value]) -> String {
    let types: Vec<&str> = events
        .iter()
        .filter_map(|e| e.get("event_type_id").and_then(|v| v.as_str()))
        .collect();
    detect_game_mode_from_types(&types)
}

fn emit(app: &tauri::AppHandle, event: &str, payload: serde_json::Value) {
    if let Err(e) = app.emit(event, payload) {
        log::debug!("Emit {event}: {e}");
    }
}
