use serde::Serialize;
/// Tauri IPC Commands — Recording
use tauri::State;

use crate::AppState;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingStartResult {
    pub match_id: String,
    pub encoder: String,
}

/// Start recording gameplay.
#[tauri::command]
pub fn start_recording(state: State<'_, AppState>) -> Result<RecordingStartResult, String> {
    let mut rec = state.recording.lock().map_err(|e| e.to_string())?;
    let match_id = rec.start_recording().map_err(|e| e.to_string())?;
    let status = rec.get_status();

    Ok(RecordingStartResult {
        match_id,
        encoder: status.encoder_used.unwrap_or_else(|| "unknown".into()),
    })
}

/// Stop recording, save match to database, and trigger analysis.
#[tauri::command]
pub fn stop_recording(
    state: State<'_, AppState>,
    app_handle: tauri::AppHandle,
) -> Result<String, String> {
    // 1. Get the started_at timestamp before stopping
    let started_at_ms = {
        let rec = state.recording.lock().map_err(|e| e.to_string())?;
        let status = rec.get_status();
        status
            .started_at_ms
            .map(|ms| ms as i64)
            .unwrap_or_else(crate::now_ms)
    };

    // 2. Stop recording (ffmpeg finalize)
    let recording_path = {
        let mut rec = state.recording.lock().map_err(|e| e.to_string())?;
        rec.stop_recording().map_err(|e| e.to_string())?
    };

    // Detection removed — kills/deaths are now determined by server-side analysis
    let kill_count: usize = 0;
    let death_count: usize = 0;

    // 4. Save match to database + trigger analysis (same as auto-stop)
    let ended_at = crate::now_ms();
    let duration_ms = ended_at - started_at_ms;
    let match_id = std::path::Path::new(&recording_path)
        .file_stem()
        .and_then(|s| s.to_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());

    let recording_size_bytes = std::fs::metadata(&recording_path)
        .ok()
        .map(|m| m.len() as i64);

    let game_id = state
        .active_game_id
        .lock()
        .ok()
        .and_then(|id| id.clone())
        .unwrap_or_else(|| "valorant".into());

    let row = crate::storage::MatchRow {
        id: match_id.clone(),
        game_id,
        started_at: started_at_ms,
        ended_at: Some(ended_at),
        duration_ms: Some(duration_ms),
        map: None,
        agent: None,
        game_mode: None,
        won: None,
        kills: kill_count as i64,
        deaths: death_count as i64,
        assists: 0,
        recording_path: Some(recording_path.clone()),
        recording_size_bytes,
        analysis_status: "none".into(),
        created_at: ended_at,
        // Not stored — computed by list_matches CTE at query time.
        match_number: 0,
    };

    if let Ok(db) = state.db.lock() {
        if let Err(e) = db.insert_match(&row) {
            log::error!("DB insert_match: {e}");
        }
        // Detection events now handled by server-side analysis
        log::info!(
            "Match saved: {match_id} — {:.1} MB, {:.0}s, {kill_count} kills, {death_count} deaths",
            recording_size_bytes.unwrap_or(0) as f64 / 1_048_576.0,
            duration_ms as f64 / 1000.0,
        );
    }

    // Emit session-end event so the frontend refreshes
    use tauri::Emitter;
    let _ = app_handle.emit(
        "scrima:game-session-end",
        serde_json::json!({ "matchId": match_id }),
    );

    Ok(recording_path)
}

/// Get current recording status (also refreshes file size + checks ffmpeg health).
/// If ffmpeg crashed mid-recording, emits `scrima:recording-crashed` and saves the partial recording.
#[tauri::command]
pub fn get_recording_status(
    state: State<'_, AppState>,
    app_handle: tauri::AppHandle,
) -> Result<crate::recording::RecordingStatus, String> {
    let mut rec = state.recording.lock().map_err(|e| e.to_string())?;
    let crashed_match_id = rec.refresh_size_estimate();
    let status = rec.get_status();

    // If ffmpeg crashed, save partial recording and notify the user
    if let Some(ref match_id) = crashed_match_id {
        log::error!("Recording crashed for match {match_id} — saving partial recording");

        // Save partial match to DB so the recording isn't lost
        if let Some(ref file_path) = status.file_path {
            let recording_size_bytes = std::fs::metadata(file_path).ok().map(|m| m.len() as i64);
            let started_at = status
                .started_at_ms
                .map(|ms| ms as i64)
                .unwrap_or_else(crate::now_ms);
            let ended_at = crate::now_ms();

            let game_id = state
                .active_game_id
                .lock()
                .ok()
                .and_then(|id| id.clone())
                .unwrap_or_else(|| "valorant".into());

            let row = crate::storage::MatchRow {
                id: match_id.clone(),
                game_id,
                started_at,
                ended_at: Some(ended_at),
                duration_ms: Some(ended_at - started_at),
                map: None,
                agent: None,
                game_mode: None,
                won: None,
                kills: 0,
                deaths: 0,
                assists: 0,
                recording_path: Some(file_path.clone()),
                recording_size_bytes,
                analysis_status: "none".into(),
                created_at: ended_at,
                // Not stored — computed by list_matches CTE at query time.
                match_number: 0,
            };

            if let Ok(db) = state.db.lock() {
                if let Err(e) = db.insert_match(&row) {
                    log::error!("DB insert partial match: {e}");
                }
            }
        }

        // Emit crash event so the frontend can show a notification
        use tauri::Emitter;
        let _ = app_handle.emit(
            "scrima:recording-crashed",
            serde_json::json!({
                "matchId": match_id,
                "reason": "ffmpeg process exited unexpectedly — the partial recording has been saved"
            }),
        );
    }

    Ok(status)
}

/// Check if ffmpeg is available on PATH or in app data dir.
#[tauri::command]
pub fn check_ffmpeg() -> bool {
    crate::recording::RecordingManager::check_ffmpeg() || ffmpeg_local_path().is_some()
}

/// Get the local ffmpeg path if it exists in app data dir.
fn ffmpeg_local_path() -> Option<std::path::PathBuf> {
    let path = crate::app_data_dir().join("bin").join("ffmpeg.exe");
    if path.exists() {
        Some(path)
    } else {
        None
    }
}

/// Download ffmpeg to the app data directory.
/// Returns the path to the installed ffmpeg binary.
#[tauri::command]
pub async fn install_ffmpeg(app_handle: tauri::AppHandle) -> Result<String, String> {
    use tauri::Emitter;

    let bin_dir = crate::app_data_dir().join("bin");
    let ffmpeg_path = bin_dir.join("ffmpeg.exe");

    if ffmpeg_path.exists() {
        return Ok(ffmpeg_path.to_string_lossy().to_string());
    }

    std::fs::create_dir_all(&bin_dir).map_err(|e| format!("Failed to create bin dir: {}", e))?;

    // Download static ffmpeg build
    let url = "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip";
    log::info!("Downloading ffmpeg from: {}", url);

    let _ = app_handle.emit(
        "scrima:ffmpeg-progress",
        serde_json::json!({ "stage": "downloading" }),
    );

    let resp = reqwest::get(url)
        .await
        .map_err(|e| format!("Download failed: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("Download failed: HTTP {}", resp.status()));
    }

    let bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("Download failed: {}", e))?;

    log::info!("Downloaded {} bytes, extracting...", bytes.len());
    let _ = app_handle.emit(
        "scrima:ffmpeg-progress",
        serde_json::json!({ "stage": "extracting" }),
    );

    // Extract ffmpeg.exe from the zip
    let reader = std::io::Cursor::new(&bytes);
    let mut archive =
        zip::ZipArchive::new(reader).map_err(|e| format!("Failed to open zip: {}", e))?;

    // Find ffmpeg.exe in the archive (it's in a subdirectory)
    let mut found = false;
    for i in 0..archive.len() {
        let mut file = archive
            .by_index(i)
            .map_err(|e| format!("Zip error: {}", e))?;
        let name = file.name().to_string();

        if name.ends_with("bin/ffmpeg.exe") {
            let mut out = std::fs::File::create(&ffmpeg_path)
                .map_err(|e| format!("Failed to create ffmpeg.exe: {}", e))?;
            std::io::copy(&mut file, &mut out).map_err(|e| format!("Failed to extract: {}", e))?;
            found = true;
            break;
        }
    }

    if !found {
        return Err("ffmpeg.exe not found in downloaded archive".into());
    }

    let _ = app_handle.emit(
        "scrima:ffmpeg-progress",
        serde_json::json!({ "stage": "done" }),
    );
    log::info!("ffmpeg installed at: {}", ffmpeg_path.display());

    Ok(ffmpeg_path.to_string_lossy().to_string())
}

/// List recent matches from local SQLite database.
///
/// Backwards-compatible: all three params are optional.
///   - `limit`          defaults to 50 (matches old behaviour when unpaginated)
///   - `offset`         defaults to 0
///   - `analysedOnly`   defaults to false — coaching view passes `true` to get
///                       only matches whose analysis has completed.
#[tauri::command]
pub fn list_recent_matches(
    state: State<'_, AppState>,
    limit: Option<usize>,
    offset: Option<usize>,
    #[allow(non_snake_case)] analysedOnly: Option<bool>,
) -> Result<Vec<crate::storage::MatchRow>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.list_matches(
        limit.unwrap_or(50),
        offset.unwrap_or(0),
        analysedOnly.unwrap_or(false),
    )
    .map_err(|e| e.to_string())
}

/// Count of matches — total for pagination UI. Mirrors `list_recent_matches`'s
/// `analysedOnly` filter so coaching view and history view see consistent
/// totals vs their own slicing.
#[tauri::command]
pub fn count_recent_matches(
    state: State<'_, AppState>,
    #[allow(non_snake_case)] analysedOnly: Option<bool>,
) -> Result<usize, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.count_matches(analysedOnly.unwrap_or(false))
        .map_err(|e| e.to_string())
}

/// Persist the user-selected agent/map for a match the moment the dropdown
/// changes — before analysis runs. Ensures the DB has ground truth even if
/// a later analysis fails to upload (previously caused "unknown" agent silently
/// falling back to per-death VLM guessing across 5 different agents).
#[tauri::command]
pub fn update_match_metadata(
    state: State<'_, AppState>,
    match_id: String,
    agent: Option<String>,
    map: Option<String>,
) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.set_match_metadata(&match_id, agent.as_deref(), map.as_deref())
        .map_err(|e| e.to_string())
}

/// Delete a match and all its files (recording + clips).
#[tauri::command]
pub fn delete_match(state: State<'_, AppState>, match_id: String) -> Result<(), String> {
    // 1. Look up recording path and analysis copy path before deleting from DB
    let (recording_path, analysis_copy_path) = {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        // 1000 is an upper bound — sufficient for every known user's total match
        // count. Fetch all (offset=0, no analysed-only filter) so we can find
        // `match_id` regardless of its analysis state.
        let rows = db.list_matches(1000, 0, false).map_err(|e| e.to_string())?;
        let rec_path = rows
            .iter()
            .find(|r| r.id == match_id)
            .and_then(|r| r.recording_path.clone());
        let analysis_path = db.get_analysis_copy_path(&match_id).ok().flatten();
        (rec_path, analysis_path)
    };

    // 2. Delete recording file
    if let Some(ref path) = recording_path {
        let _ = std::fs::remove_file(path);
        // Also try to delete companion analysis copy by naming convention
        let p = std::path::Path::new(path);
        if let Some(stem) = p.file_stem().and_then(|s| s.to_str()) {
            let companion = p.with_file_name(format!("{stem}_analysis.mp4"));
            let _ = std::fs::remove_file(&companion);
        }
    }

    // 2b. Delete analysis copy from DB path (may differ from companion path)
    if let Some(ref path) = analysis_copy_path {
        let _ = std::fs::remove_file(path);
    }

    // 3. Delete clips directory
    let clips_dir = crate::app_data_dir().join("clips").join(&match_id);
    if clips_dir.exists() {
        let _ = std::fs::remove_dir_all(&clips_dir);
    }

    // 3b. Delete analysis temp directory
    let analysis_dir = crate::app_data_dir().join("analysis");
    let analysis_temp = analysis_dir.join(format!("{match_id}_analysis.mp4"));
    let _ = std::fs::remove_file(&analysis_temp);

    // 4. Delete from DB
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.delete_match(&match_id).map_err(|e| e.to_string())
}

/// Open a specific file in the system's default application (e.g. media player for .mp4).
#[tauri::command]
pub fn open_recording(path: String) -> Result<(), String> {
    let path = std::path::PathBuf::from(&path);

    // Validate: must exist and be a file
    if !path.exists() || !path.is_file() {
        return Err("File not found".to_string());
    }

    // Validate: reject paths with shell metacharacters
    let path_str = path.to_string_lossy();
    if path_str.contains('&')
        || path_str.contains('|')
        || path_str.contains(';')
        || path_str.contains('`')
    {
        return Err("Invalid file path".to_string());
    }

    #[cfg(target_os = "windows")]
    {
        // Use explorer with arg() — passes argument directly without shell interpretation
        std::process::Command::new("explorer")
            .arg(path.as_os_str())
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(path.as_os_str())
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        std::process::Command::new("xdg-open")
            .arg(path.as_os_str())
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Open the clips folder for a match in the system file explorer.
#[tauri::command]
pub fn open_clips_folder(match_id: String) -> Result<(), String> {
    let clips_dir = crate::app_data_dir().join("clips").join(&match_id);

    if !clips_dir.exists() {
        // Create it so the user can at least see where clips would go
        let _ = std::fs::create_dir_all(&clips_dir);
    }

    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer.exe")
            .arg(clips_dir.to_string_lossy().as_ref())
            .spawn()
            .map_err(|e| e.to_string())?;
    }

    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(clips_dir.to_string_lossy().as_ref())
            .spawn()
            .map_err(|e| e.to_string())?;
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        std::process::Command::new("xdg-open")
            .arg(clips_dir.to_string_lossy().as_ref())
            .spawn()
            .map_err(|e| e.to_string())?;
    }

    Ok(())
}
