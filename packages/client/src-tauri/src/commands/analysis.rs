use crate::errors::UserFacingError;
use crate::network::api_client::{CoachingCreditsResponse, MatchQnAResponse};
use crate::storage::{DeepAnalysisJobRow, DeepCoachingReportRow, MatchRow, TrendReportRow};
use crate::AppState;
use std::sync::atomic::AtomicBool;
/// Analysis command handlers
///
/// `run_analysis` spawns the pipeline in a background tokio task and returns
/// immediately so the frontend can track progress via emitted events.
use std::sync::Arc;
use tauri::{Emitter, Manager, State};

/// Trigger the full-game analysis pipeline for a completed match.
/// Returns immediately; progress comes via scrima:analysis-progress events.
#[tauri::command]
pub async fn run_analysis(
    match_id: String,
    agent: Option<String>,
    map: Option<String>,
    app_handle: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut slot = state.analysis_cancel.lock().map_err(|e| e.to_string())?;
        *slot = Some(cancel.clone());
    }
    tauri::async_runtime::spawn(async move {
        let result = crate::analysis::run_full_game_analysis(
            match_id.clone(),
            app_handle.clone(),
            vec![],
            Some(cancel),
            agent,
            map,
        )
        .await;
        // Clear cancel token
        if let Ok(mut slot) = app_handle.state::<AppState>().analysis_cancel.lock() {
            *slot = None;
        }
        if let Err(e) = result {
            log::error!("Full game analysis error: {e}");
            let kind = UserFacingError::classify(&e);
            let _ = app_handle.emit(
                "scrima:analysis-complete",
                serde_json::json!({
                    "matchId": match_id,
                    "error": kind.user_message(),
                    "errorCode": kind.code(),
                }),
            );
        }
    });
    Ok(())
}

/// Cancel an in-progress analysis pipeline.
#[tauri::command]
pub fn cancel_analysis(state: State<'_, AppState>) -> Result<(), String> {
    let cancel = state.analysis_cancel.lock().map_err(|e| e.to_string())?;
    if let Some(ref flag) = *cancel {
        flag.store(true, std::sync::atomic::Ordering::Relaxed);
        log::info!("Analysis cancellation requested");
    }
    Ok(())
}

/// Run multi-match trend analysis across the last N matches.
/// Returns immediately — completion comes via scrima:trend-complete event.
#[tauri::command]
pub async fn run_trend_analysis(
    n_matches: Option<usize>,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    let n = n_matches.unwrap_or(10).max(1).min(50);
    tauri::async_runtime::spawn(async move {
        if let Err(e) = crate::analysis::trend::run_trend_pipeline(n, app_handle.clone()).await {
            log::error!("Trend pipeline error: {e}");
            let kind = UserFacingError::classify(&e);
            let _ = app_handle.emit(
                "scrima:trend-error",
                serde_json::json!({
                    "error": kind.user_message(),
                    "errorCode": kind.code(),
                }),
            );
        }
    });
    Ok(())
}

/// Fetch the latest trend report.
#[tauri::command]
pub fn get_trend_report(state: State<'_, AppState>) -> Result<Option<TrendReportRow>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.get_latest_trend_report().map_err(|e| e.to_string())
}

/// Get the local analysis job status for a match.
#[tauri::command]
pub fn get_deep_analysis_status(
    match_id: String,
    state: State<'_, AppState>,
) -> Result<Option<DeepAnalysisJobRow>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.get_deep_analysis_job_by_match(&match_id)
        .map_err(|e| e.to_string())
}

/// Get the locally stored coaching report for a match.
#[tauri::command]
pub fn get_deep_coaching_report(
    match_id: String,
    state: State<'_, AppState>,
) -> Result<Option<DeepCoachingReportRow>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.get_deep_coaching_report(&match_id)
        .map_err(|e| e.to_string())
}

/// Re-fetch a completed coaching report from the server and update the local cache.
#[tauri::command]
pub async fn refresh_deep_coaching_report(
    match_id: String,
    state: State<'_, AppState>,
) -> Result<Option<DeepCoachingReportRow>, String> {
    let stored = {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        db.get_deep_coaching_report(&match_id)
            .map_err(|e| e.to_string())?
    };
    let Some(mut stored) = stored else {
        return Ok(None);
    };

    let client = state.api_client();
    let fresh = client
        .get_coaching_report_remote(&stored.server_report_id)
        .await
        .map_err(|e| e.to_string())?;

    stored.report_json = fresh.to_string();
    {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        db.insert_deep_coaching_report(&stored)
            .map_err(|e| e.to_string())?;
    }
    Ok(Some(stored))
}

/// Fetch coaching credit balance from the server.
#[tauri::command]
pub async fn get_coaching_credits(
    state: State<'_, AppState>,
) -> Result<CoachingCreditsResponse, String> {
    let client = state.api_client();
    client
        .get_coaching_credits()
        .await
        .map_err(|e| e.to_string())
}

/// Lightweight heartbeat used by the client connectivity monitor.
/// Returns `true` if the Scrima server responds to GET /health, `false` otherwise.
/// Never returns an error — the caller treats `false` as "server unreachable."
#[tauri::command]
pub async fn check_server_health(state: State<'_, AppState>) -> Result<bool, String> {
    let client = state.api_client();
    Ok(client.health_check().await)
}

/// Ask a question about a coaching report (Q&A chat).
#[tauri::command]
pub async fn ask_match_question(
    report_id: String,
    question: String,
    history: Vec<serde_json::Value>,
    state: State<'_, AppState>,
) -> Result<MatchQnAResponse, String> {
    let client = state.api_client();
    client
        .ask_match_question(&report_id, &question, &history)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_weekly_report_latest(
    state: State<'_, AppState>,
) -> Result<Option<serde_json::Value>, String> {
    let client = state.api_client();
    client
        .get_weekly_report_latest()
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_weekly_reports(
    state: State<'_, AppState>,
) -> Result<Vec<serde_json::Value>, String> {
    let client = state.api_client();
    client.get_weekly_reports().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_pending_upload_count(state: State<'_, AppState>) -> Result<i64, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.pending_upload_count().map_err(|e| e.to_string())
}

/// Import an external video file as a match.
#[tauri::command]
pub async fn import_video(
    video_path: String,
    deaths: Option<i64>,
    _app_handle: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let src = std::path::Path::new(&video_path);
    if !src.exists() {
        return Err(format!("File not found: {video_path}"));
    }

    // 1. Get video duration via ffprobe (fall back to ffmpeg stderr)
    let duration_ms = probe_video_duration(&video_path)?;

    // 2. Copy to recordings directory
    let match_id = uuid::Uuid::new_v4().to_string();
    let recordings_dir = crate::app_data_dir().join("recordings");
    let _ = std::fs::create_dir_all(&recordings_dir);

    let ext = src.extension().and_then(|e| e.to_str()).unwrap_or("mp4");
    let dest = recordings_dir.join(format!("{match_id}.{ext}"));
    std::fs::copy(src, &dest).map_err(|e| format!("Failed to copy video: {e}"))?;

    let file_size = std::fs::metadata(&dest).map(|m| m.len() as i64).ok();
    let now = crate::now_ms();

    // 3. Create match row
    let death_count = deaths.unwrap_or(5);
    let game_id = state
        .active_game_id
        .lock()
        .ok()
        .and_then(|id| id.clone())
        .unwrap_or_else(|| "valorant".into());
    let row = MatchRow {
        id: match_id.clone(),
        game_id,
        started_at: now - duration_ms,
        ended_at: Some(now),
        duration_ms: Some(duration_ms),
        map: None,
        agent: None,
        game_mode: None,
        won: None,
        kills: 0,
        deaths: death_count,
        assists: 0,
        recording_path: Some(dest.to_string_lossy().to_string()),
        recording_size_bytes: file_size,
        analysis_status: "none".into(),
        created_at: now,
        // Not part of stored row — computed at list time by list_matches CTE.
        match_number: 0,
    };

    {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        db.insert_match(&row).map_err(|e| e.to_string())?;
    }

    log::info!(
        "Imported video as match {match_id} — {:.1} MB, {:.0}s, {death_count} deaths",
        file_size.unwrap_or(0) as f64 / 1_048_576.0,
        duration_ms as f64 / 1000.0
    );

    Ok(match_id)
}

/// Probe video duration in milliseconds using ffprobe, with ffmpeg fallback.
fn probe_video_duration(path: &str) -> Result<i64, String> {
    let ffprobe_bin = {
        let local = crate::app_data_dir().join("bin").join("ffprobe.exe");
        if local.exists() {
            local.to_string_lossy().to_string()
        } else {
            "ffprobe".to_string()
        }
    };

    let result = std::process::Command::new(&ffprobe_bin)
        .args([
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            path,
        ])
        .output();

    if let Ok(output) = result {
        if output.status.success() {
            let stdout = String::from_utf8_lossy(&output.stdout);
            if let Ok(secs) = stdout.trim().parse::<f64>() {
                return Ok((secs * 1000.0) as i64);
            }
        }
    }

    // Fallback: use ffmpeg -i (prints duration to stderr)
    let ffmpeg_result = std::process::Command::new(crate::ffmpeg_bin())
        .args(["-i", path])
        .output();

    if let Ok(output) = ffmpeg_result {
        let stderr = String::from_utf8_lossy(&output.stderr);
        if let Some(dur_pos) = stderr.find("Duration: ") {
            let dur_str = &stderr[dur_pos + 10..];
            if let Some(comma) = dur_str.find(',') {
                let time_str = &dur_str[..comma].trim();
                if let Some(ms) = parse_ffmpeg_duration(time_str) {
                    return Ok(ms);
                }
            }
        }
    }

    Err(format!(
        "Could not determine video duration for {path} — ffprobe and ffmpeg both failed"
    ))
}

/// Fetch player coaching observations for the "Your Coach" page.
#[tauri::command]
pub async fn get_coaching_observations(
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let client = state.api_client();
    match client.get_coaching_observations().await {
        Ok(data) => Ok(data),
        Err(e) => {
            log::warn!("Failed to fetch coaching observations: {e}");
            // Return empty structure on error (graceful degradation)
            Ok(serde_json::json!({ "habits": [], "strengths": [], "insights": [] }))
        }
    }
}

/// Fetch full coaching brain state for the interactive "Your Coach" page.
#[tauri::command]
pub async fn get_coaching_brain(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let client = state.api_client();
    match client.get_coaching_brain().await {
        Ok(data) => Ok(data),
        Err(e) => {
            log::warn!("Failed to fetch coaching brain: {e}");
            Ok(serde_json::json!({
                "mastery": { "skills": [], "weakest": [], "strongest": [] },
                "graph": { "totalNodes": 0, "totalEdges": 0, "patterns": [], "recentGames": [] },
                "strategies": { "effective": [], "ineffective": [] },
                "observations": { "habits": [], "strengths": [], "insights": [] },
                "reflections": []
            }))
        }
    }
}

/// Chat with the coach using full brain context.
#[tauri::command]
pub async fn ask_brain_question(
    question: String,
    history: Vec<serde_json::Value>,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let client = state.api_client();
    let res = client
        .brain_chat(&question, &history)
        .await
        .map_err(|e| e.to_string())?;
    Ok(serde_json::json!({
        "answer": res.answer,
        "tokensUsed": res.tokens_used,
        "softBlock": res.soft_block,
        "quota": res.quota,
    }))
}

/// Get a personalized coaching greeting.
#[tauri::command]
pub async fn get_brain_greeting(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let client = state.api_client();
    match client.get_brain_greeting().await {
        Ok(res) => Ok(serde_json::json!({ "greeting": res.greeting })),
        Err(e) => {
            log::warn!("Failed to fetch brain greeting: {e}");
            Ok(serde_json::json!({
                "greeting": "Welcome to Scrima. Play a game and I'll start learning how you play."
            }))
        }
    }
}

/// Dismiss (archive) a single observation from the coach's memory.
#[tauri::command]
pub async fn dismiss_observation(
    id: String,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let client = state.api_client();
    client
        .dismiss_observation(&id)
        .await
        .map_err(|e| e.to_string())
}

/// Fetch unread coach messages (Phase 7D — proactive coach).
#[tauri::command]
pub async fn get_coach_messages(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let client = state.api_client();
    match client.get_coach_messages().await {
        Ok(data) => Ok(data),
        Err(e) => {
            log::warn!("Failed to fetch coach messages: {e}");
            Ok(serde_json::json!({ "messages": [] }))
        }
    }
}

/// Mark a coach message as read (Phase 7D).
#[tauri::command]
pub async fn mark_coach_message_read(
    id: String,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let client = state.api_client();
    client
        .mark_coach_message_read(&id)
        .await
        .map_err(|e| e.to_string())
}

/// Fetch the player's pending hypotheses (Phase 7B — Living Mind belief tiers).
#[tauri::command]
pub async fn get_hypotheses(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let client = state.api_client();
    match client.get_hypotheses().await {
        Ok(data) => Ok(data),
        Err(e) => {
            log::warn!("Failed to fetch hypotheses: {e}");
            Ok(serde_json::json!({ "hypotheses": [] }))
        }
    }
}

/// Player agrees with a hypothesis (Phase 7B).
#[tauri::command]
pub async fn confirm_hypothesis(
    id: String,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let client = state.api_client();
    client
        .confirm_hypothesis(&id)
        .await
        .map_err(|e| e.to_string())
}

/// Player disagrees with a hypothesis (Phase 7B).
#[tauri::command]
pub async fn reject_hypothesis(
    id: String,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let client = state.api_client();
    client
        .reject_hypothesis(&id)
        .await
        .map_err(|e| e.to_string())
}

/// Fetch the player's eras (Phase 5 — Living Mind).
#[tauri::command]
pub async fn get_eras(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let client = state.api_client();
    match client.get_eras().await {
        Ok(data) => Ok(data),
        Err(e) => {
            log::warn!("Failed to fetch eras: {e}");
            Ok(serde_json::json!({ "eras": [] }))
        }
    }
}

/// Fetch the Dashboard pre-session briefing (Phase 4 — "Before you play").
/// Returns a safe empty-ish briefing on any failure so the Dashboard never breaks.
#[tauri::command]
pub async fn get_pre_session_briefing(
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let client = state.api_client();
    match client.get_pre_session_briefing().await {
        Ok(data) => Ok(data),
        Err(e) => {
            log::warn!("Failed to fetch pre-session briefing: {e}");
            Ok(serde_json::json!({
                "sessionNumber": 1,
                "practice": null,
                "lookFor": null,
                "avoid": null,
                "focusOptions": ["Crosshair head height", "Utility before eyes", "Hold angles, patience"],
                "currentCommitment": null,
            }))
        }
    }
}

/// Commit to a focus for this session (Phase 4).
#[tauri::command]
pub async fn commit_focus(
    focus: String,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let client = state.api_client();
    client.commit_focus(&focus).await.map_err(|e| e.to_string())
}

/// Extract a single frame from the local recording at the given timestamp.
/// Returns a base64-encoded JPEG for the Counterfactual Clip evidence panel.
/// Phase 2 — reads match from local SQLite, uses the existing FFmpeg-based
/// extract_frame_jpeg to pull one JPEG, base64-encodes, returns to UI.
#[tauri::command]
pub fn get_death_frame(
    match_id: String,
    timestamp_sec: f64,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let match_row = {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        db.get_match(&match_id).map_err(|e| e.to_string())?
    };
    let match_row = match_row.ok_or_else(|| "match not found".to_string())?;

    let recording_path = match_row
        .recording_path
        .ok_or_else(|| "no recording available for this match".to_string())?;

    let path = std::path::PathBuf::from(&recording_path);
    if !path.exists() {
        return Err(format!("recording file missing: {recording_path}"));
    }

    let ts = timestamp_sec.max(0.0);
    let jpeg = crate::analysis::clips::extract_frame_jpeg(&path, ts)
        .map_err(|e| format!("frame extraction failed: {e}"))?;

    use base64::Engine;
    Ok(base64::engine::general_purpose::STANDARD.encode(&jpeg))
}

/// Player agrees with an observation (Phase 6 — Brain self-model).
#[tauri::command]
pub async fn agree_observation(
    id: String,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let client = state.api_client();
    client
        .agree_observation(&id)
        .await
        .map_err(|e| e.to_string())
}

/// Player disagrees with an observation (Phase 6 — Brain self-model).
#[tauri::command]
pub async fn disagree_observation(
    id: String,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let client = state.api_client();
    client
        .disagree_observation(&id)
        .await
        .map_err(|e| e.to_string())
}

/// Fetch the player's bottleneck compass state (Phase 3 — Bottleneck Compass).
/// Returns a degraded "building" state on failure so the UI never breaks.
#[tauri::command]
pub async fn get_compass(
    priority_category: Option<String>,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let client = state.api_client();
    match client.get_compass(priority_category.as_deref()).await {
        Ok(data) => Ok(data),
        Err(e) => {
            log::warn!("Failed to fetch compass: {e}");
            Ok(serde_json::json!({
                "state": "building",
                "totalObservations": 0,
                "gamesToGo": 5
            }))
        }
    }
}

/// Reset the player's entire coaching brain.
#[tauri::command]
pub async fn reset_brain(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let client = state.api_client();
    client.reset_brain().await.map_err(|e| e.to_string())
}

/// Parse "HH:MM:SS.ms" format to milliseconds
fn parse_ffmpeg_duration(s: &str) -> Option<i64> {
    let parts: Vec<&str> = s.split(':').collect();
    if parts.len() != 3 {
        return None;
    }
    let hours: f64 = parts[0].parse().ok()?;
    let mins: f64 = parts[1].parse().ok()?;
    let secs: f64 = parts[2].parse().ok()?;
    Some(((hours * 3600.0 + mins * 60.0 + secs) * 1000.0) as i64)
}
